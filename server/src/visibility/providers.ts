import { config } from "../config.js";
import { getOxAlphaExecutor } from "../ai/ox-alpha.js";
import { checkCallableModel, getExecutionSettings, paidModelsAllowed } from "../ai/governance.js";
import type { ProviderCitation } from "../ai/provider.js";

/**
 * AI answer providers for visibility collection, and a capability registry
 * that says plainly what each source can and cannot provide.
 *
 * Implemented collection: OpenRouter chat completions through the OX Alpha
 * executor (budget, free-model gate, attribution and audit apply). Without
 * web search a model answers from its training data, so its answers show
 * what that model says — not what any consumer AI search product shows.
 * OpenRouter's web search returns structured citations but is billed per
 * request, so it stays off until an operator enables it.
 *
 * Consumer AI search products (ChatGPT, Google AI Overviews / AI Mode,
 * Perplexity, Gemini, Copilot, Claude) offer no documented API for
 * monitoring their answers; they are never automated or scraped. Answers a
 * user observed there can be imported and are labeled as manual imports.
 */

export interface AnswerRequest {
  queryText: string;
  language: string | null;
  country: string | null;
  orgId: string;
  brandId: string;
  userId?: string;
  signal: AbortSignal;
}

export interface AnswerResult {
  text: string;
  finishReason: string;
  model: string;
  providerRequestId: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  webGrounded: boolean;
  citations: ProviderCitation[];
  observedAt: Date;
}

export class AnswerProviderError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "AnswerProviderError";
  }
}

export interface Capabilities {
  answers: boolean;
  brandMentions: boolean;
  structuredCitations: boolean;
  inlineUrls: boolean;
  webGrounding: boolean;
  usageMetadata: boolean;
  requestIds: boolean;
  languageControl: "prompt" | "none";
  geographyControl: "prompt" | "none";
  cancellation: boolean;
}

export type ProviderStatus = "available" | "not_configured" | "requires_approval" | "model_not_allowed" | "manual_import_only";

export interface ProviderInfo {
  id: string;
  name: string;
  surface: string;
  collection: "provider_api" | "manual_import";
  capabilities: Capabilities;
  explanation: string;
  limitations: string[];
  costNote: string;
}

export interface AnswerProvider {
  info: ProviderInfo;
  model(): string;
  readiness(): Promise<{ status: ProviderStatus; detail: string }>;
  answer(req: AnswerRequest): Promise<AnswerResult>;
}

/** The neutral prompt sent with each query (version recorded on every observation). */
export function buildMessages(req: Pick<AnswerRequest, "queryText" | "language" | "country">) {
  const context = [
    req.language ? `Answer in the language with code "${req.language}".` : null,
    req.country ? `The person asking is in the country with code "${req.country.toUpperCase()}".` : null,
  ].filter(Boolean);
  return [
    ...(context.length ? [{ role: "system" as const, content: context.join(" ") }] : []),
    { role: "user" as const, content: req.queryText },
  ];
}

// An explicitly configured model keeps measurements comparable over time; without one the
// Phase 11 router picks an eligible free model per request (each observation records the model used).
const pinnedAnswerModel = (): string | null => config.AIV_ANSWER_MODEL || config.OX_ALPHA_MODEL || null;
const answerModel = (): string => pinnedAnswerModel() ?? "auto";

function openRouterProvider(web: boolean): AnswerProvider {
  const info: ProviderInfo = {
    id: web ? "openrouter_web" : "openrouter_answer",
    name: web ? "Model answer with web search (OpenRouter)" : "Model answer (OpenRouter)",
    surface: "model_api",
    collection: "provider_api",
    capabilities: {
      answers: true,
      brandMentions: true,
      structuredCitations: web,
      inlineUrls: true,
      webGrounding: web,
      usageMetadata: true,
      requestIds: true,
      languageControl: "prompt",
      geographyControl: "prompt",
      cancellation: true,
    },
    explanation: web
      ? "Sends each query to the configured model with OpenRouter's web search enabled. The provider returns the URLs it used as structured citations."
      : "Sends each query to the configured model without web search. The model answers from its training data, so its answers show what that model says — not what a consumer AI search product shows. URLs written in the answer are recorded as inline URLs, not as provider citations.",
    limitations: [
      "A model's answer through the API is not the answer a consumer product (ChatGPT, Google AI Overviews, Perplexity, …) would show.",
      "Language and country are requested in the prompt; the provider does not geolocate results.",
      ...(web ? ["Web search results depend on OpenRouter's search backend and change over time."] : ["Without web search there are no structured citations."]),
    ],
    costNote: web ? "OpenRouter bills web search per request in addition to the model; needs explicit approval." : "Free models only unless paid models are approved (AI_ALLOW_PAID_MODELS); every call counts against the organization's AI budget.",
  };
  return {
    info,
    model: answerModel,
    async readiness() {
      if (!getOxAlphaExecutor()) return { status: "not_configured", detail: "No OpenRouter API key is configured. An administrator can add it in Admin → Integrations & API Keys." };
      if (web && !config.AIV_WEB_SEARCH_ENABLED) return { status: "requires_approval", detail: "Web search is billed per request. An operator must approve the cost and set AIV_WEB_SEARCH_ENABLED=true." };
      if (web && !paidModelsAllowed()) return { status: "requires_approval", detail: "Web search is billed per request, and the AI router runs in free-only mode (AI_ALLOW_PAID_MODELS=false)." };
      // Same call-time gate the executor applies (pricing class, trial, freshness, review status).
      const pinned = pinnedAnswerModel();
      if (!pinned) return { status: "available", detail: `Model chosen automatically among eligible free models${web ? ", with web search" : ""}.` };
      let check: Awaited<ReturnType<typeof checkCallableModel>>;
      try {
        check = await checkCallableModel(pinned, await getExecutionSettings());
        // (The organization's policy is applied again at call time by the executor.)
      } catch {
        return { status: "not_configured", detail: "The model registry could not be read." };
      }
      if (!check.ok) return { status: "model_not_allowed", detail: `The model ${answerModel()} cannot be used: ${check.reason}.` };
      return { status: "available", detail: `Model ${answerModel()}${web ? " with web search" : ""}.` };
    },
    async answer(req) {
      const executor = getOxAlphaExecutor();
      if (!executor) throw new AnswerProviderError("PROVIDER_NOT_CONFIGURED", "No OpenRouter API key is configured.", false);
      // Free requests never carry billed web search, so a web-grounded run needs paid usage enabled.
      if (web && !paidModelsAllowed()) throw new AnswerProviderError("PROVIDER_NOT_AVAILABLE", "Web search is unavailable in free-only mode.", false);
      const r = await executor.execute({
        model: pinnedAnswerModel() ?? undefined,
        messages: buildMessages(req),
        temperature: 0.7,
        maxTokens: 1_500,
        maxRetries: 1,
        maxTotalAttempts: 1,
        timeoutMs: config.AIV_REQUEST_TIMEOUT_MS,
        signal: req.signal,
        webSearch: web ? { maxResults: config.AIV_WEB_SEARCH_MAX_RESULTS } : undefined,
        agentType: "ai_visibility_collection",
        feature: "aiv_answer",
        taskDescription: "AI visibility query",
        orgId: req.orgId,
        aivBrandId: req.brandId,
        userId: req.userId,
      });
      if (!r.success || !r.response) {
        const code = r.errorCode ?? "PROVIDER_ERROR";
        const retryable = code === "BUDGET_EXCEEDED" || code === "MODEL_UNAVAILABLE" || code === "INVALID_REQUEST" || code === "CANCELLED" ? false : r.retryable ?? true;
        throw new AnswerProviderError(code, (r.error ?? "The provider request failed.").slice(0, 300), retryable);
      }
      return {
        text: r.response.content,
        finishReason: r.response.finishReason,
        model: r.response.model,
        providerRequestId: r.response.providerRequestId ?? null,
        usage: r.response.usage,
        webGrounded: web,
        citations: r.response.citations ?? [],
        observedAt: new Date(),
      };
    },
  };
}

/** Collection providers that are implemented. */
export function answerProviders(): AnswerProvider[] {
  return [openRouterProvider(false), openRouterProvider(true)];
}

let overrides: Map<string, AnswerProvider> | null = null;
/** Test hook: replace providers by id (deterministic fixtures; no network). */
export function setAnswerProvidersForTests(list: AnswerProvider[] | null) {
  overrides = list ? new Map(list.map((p) => [p.info.id, p])) : null;
}

export function getAnswerProvider(id: string): AnswerProvider | null {
  return overrides?.get(id) ?? answerProviders().find((p) => p.info.id === id) ?? null;
}

const manual = (id: string, name: string, explanation: string): ProviderInfo => ({
  id,
  name,
  surface: id,
  collection: "manual_import",
  capabilities: { answers: true, brandMentions: true, structuredCitations: false, inlineUrls: true, webGrounding: false, usageMetadata: false, requestIds: false, languageControl: "none", geographyControl: "none", cancellation: false },
  explanation,
  limitations: ["Only answers you observed and imported; labeled as manually supplied, not as API results.", "Imported citation URLs are recorded as given and are not verified unless you verify them."],
  costNote: "No cost.",
});

const MANUAL_ONLY: ProviderInfo[] = [
  manual("chatgpt", "ChatGPT", "OpenAI offers no API that returns what ChatGPT shows to users. Import answers you observed in ChatGPT."),
  manual("google_ai_overviews", "Google AI Overviews", "Google provides no API for AI Overviews and Search Console does not report them separately. Import answers you observed."),
  manual("google_ai_mode", "Google AI Mode", "Google provides no API for AI Mode answers. Import answers you observed."),
  manual("perplexity", "Perplexity", "Perplexity's Sonar API is a separate paid product and is not integrated; it would also not be the consumer app's answer. Import answers you observed."),
  manual("gemini", "Gemini", "No API returns what the Gemini app shows to users. Import answers you observed."),
  manual("copilot", "Microsoft Copilot", "No API returns what Copilot shows to users. Import answers you observed."),
  manual("claude", "Claude", "No API returns what the Claude apps show to users. Import answers you observed."),
  manual("meta_ai", "Meta AI", "No API returns what Meta AI shows to users. Import answers you observed."),
  manual("other", "Other AI assistant", "Any other assistant whose answers you observed and are entitled to record."),
];

export interface ProviderRegistryEntry extends ProviderInfo {
  status: ProviderStatus;
  detail: string;
  model: string | null;
}

/** Every source with its real status; used by the API and the UI. */
export async function providerRegistry(): Promise<ProviderRegistryEntry[]> {
  const api = await Promise.all(
    answerProviders().map(async (p) => {
      const live = getAnswerProvider(p.info.id) ?? p;
      const r = await live.readiness();
      return { ...live.info, ...r, model: live.model() };
    }),
  );
  return [...api, ...MANUAL_ONLY.map((m) => ({ ...m, status: "manual_import_only" as const, detail: "Manual import only.", model: null }))];
}
