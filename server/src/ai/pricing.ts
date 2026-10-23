// Phase 11: pricing classification for OpenRouter catalog entries.
//
// Deterministic and fail-closed. A model is FREE only when every price the
// catalog lists for it (prompt, completion, request, image, web search,
// reasoning, cache reads and writes, audio, ...) is exactly zero, including
// every time-of-day override. The ":free" suffix or a name containing "free"
// is never evidence. Negative prices are OpenRouter's marker for dynamic
// routers whose cost depends on the model they pick, so they are UNKNOWN.

export type PricingClass = "FREE" | "TRIAL" | "PAID" | "UNKNOWN";

export interface PricingClassification {
  pricingClass: PricingClass;
  /** Why the class was chosen (shown to administrators). */
  reason: string;
  /** A routing alias (dynamic price or the openrouter/ namespace) rather than one model. */
  isRouter: boolean;
  expiresAt: Date | null;
}

const MAX_PRICE_FIELDS = 40;
const MAX_OVERRIDES = 50;

/** Parses one catalog price ("0", "0.0000003", 0). Returns null when it is not a finite number. */
function parsePrice(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "" || value.length > 40) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

type PriceScan = { state: "zero" } | { state: "paid"; field: string } | { state: "unknown"; field: string; negative: boolean };

function scanPrices(prices: Record<string, unknown>, prefix: string): PriceScan {
  const entries = Object.entries(prices).filter(([k]) => k !== "overrides" && k !== "utc_days" && k !== "utc_start" && k !== "utc_end");
  if (entries.length > MAX_PRICE_FIELDS) return { state: "unknown", field: `${prefix}too_many_fields`, negative: false };
  let paid: string | null = null;
  for (const [field, raw] of entries) {
    if (raw === undefined) continue;
    const n = parsePrice(raw);
    if (n === null) return { state: "unknown", field: prefix + field, negative: false };
    if (n < 0) return { state: "unknown", field: prefix + field, negative: true };
    if (n > 0 && paid === null) paid = prefix + field;
  }
  return paid ? { state: "paid", field: paid } : { state: "zero" };
}

export function classifyPricing(input: { id: string; pricing: unknown; expirationDate?: unknown; now?: Date }): PricingClassification {
  const now = input.now ?? new Date();
  const namespaceRouter = input.id.startsWith("openrouter/");
  const expiresAt = parseExpiry(input.expirationDate);
  const result = (pricingClass: PricingClass, reason: string, isRouter = namespaceRouter): PricingClassification => ({ pricingClass, reason, isRouter, expiresAt });

  if (!input.pricing || typeof input.pricing !== "object" || Array.isArray(input.pricing)) return result("UNKNOWN", "pricing missing");
  const pricing = input.pricing as Record<string, unknown>;
  if (parsePrice(pricing.prompt) === null || parsePrice(pricing.completion) === null) return result("UNKNOWN", "prompt or completion price missing");

  const base = scanPrices(pricing, "");
  if (base.state === "unknown") return result("UNKNOWN", base.negative ? `dynamic price (${base.field})` : `unparseable price (${base.field})`, namespaceRouter || base.negative);
  let paidField = base.state === "paid" ? base.field : null;

  if (pricing.overrides !== undefined && pricing.overrides !== null) {
    if (!Array.isArray(pricing.overrides) || pricing.overrides.length > MAX_OVERRIDES) return result("UNKNOWN", "unreadable price overrides");
    for (const [i, o] of pricing.overrides.entries()) {
      if (!o || typeof o !== "object") return result("UNKNOWN", "unreadable price override");
      const scan = scanPrices(o as Record<string, unknown>, `overrides[${i}].`);
      if (scan.state === "unknown") return result("UNKNOWN", `unparseable price (${scan.field})`, namespaceRouter || scan.negative);
      if (scan.state === "paid" && paidField === null) paidField = scan.field;
    }
  }

  if (paidField) return result("PAID", `charged price (${paidField})`);
  if (input.expirationDate !== null && input.expirationDate !== undefined && !expiresAt) return result("UNKNOWN", "unreadable expiration date");
  if (expiresAt) {
    if (expiresAt.getTime() <= now.getTime()) return result("UNKNOWN", "free period has ended");
    return result("TRIAL", `free until ${expiresAt.toISOString().slice(0, 10)}`);
  }
  return result("FREE", "every listed price is zero");
}

function parseExpiry(value: unknown): Date | null {
  if (typeof value !== "string" || value.length > 40) return null;
  // Date-only values mean the end of that UTC day.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59Z` : value;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** OpenRouter's provider guard: refuse any endpoint that would charge for this request. */
export const ZERO_MAX_PRICE = Object.freeze({ prompt: 0, completion: 0, request: 0, image: 0 });
