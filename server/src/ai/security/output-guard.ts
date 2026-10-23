// Deterministic checks on model output before the application acts on it.
// The guard only reports violations; the caller decides whether to drop,
// redact or retry. Detail strings never contain a full secret.

import { randomBytes } from "node:crypto";
import { normalizeForDetection, sanitizeEvidence } from "./injection-detector.js";

export type OutputViolationKind =
  | "CANARY_LEAK" | "SECRET_PATTERN" | "SYSTEM_PROMPT_LEAK" | "UNAPPROVED_URL" | "MARKDOWN_EXFILTRATION"
  | "POLICY_OVERRIDE_CLAIM" | "TOOL_CALL_OUTSIDE_ALLOWLIST";
export interface OutputGuardInput {
  output: string;
  canary?: string;
  systemPromptFingerprints?: string[];
  allowedHosts?: string[];
  allowedTools?: string[];
  proposedToolNames?: string[];
}
export interface OutputGuardResult { ok: boolean; violations: Array<{ kind: OutputViolationKind; detail: string }> }

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export const CANARY_PREFIX = "zc-";
export const CANARY_BODY_CHARS = 20;
export const FINGERPRINT_WORDS = 10;
export const MAX_FINGERPRINTS = 6;
const MAX_OUTPUT_SCAN_CHARS = 200_000;
const MAX_VIOLATIONS_PER_KIND = 10;

/** Crypto-random canary token, e.g. "zc-k3m7..." (20 base32 chars, 100 bits). */
export function createCanary(): string {
  const bytes = randomBytes(CANARY_BODY_CHARS);
  let body = "";
  for (const byte of bytes) body += BASE32[byte & 31];
  return `${CANARY_PREFIX}${body}`;
}

/** Masks all but the first 4 characters. */
export function maskSecret(value: string): string {
  const visible = value.slice(0, 4);
  return `${visible}${"*".repeat(Math.max(4, Math.min(12, value.length - 4)))} (${value.length} chars)`;
}

function shingleNormalize(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
}

const STOPWORDS = new Set("a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those you your we our they their he she his her i me my not no do does did can could should would will shall may might must than then so such into onto over under about only also any all each every".split(" "));

/**
 * Picks a few distinctive, non-overlapping 10-word shingles (normalized) from
 * the system prompt. Shingles with more content words and longer words win;
 * ties break by position so the result is deterministic.
 */
export function fingerprintPrompt(systemPrompt: string): string[] {
  const words = shingleNormalize(String(systemPrompt ?? ""));
  if (words.length < 8) return words.length >= 4 ? [words.join(" ")] : [];
  const size = Math.min(FINGERPRINT_WORDS, words.length);
  const candidates: Array<{ start: number; score: number }> = [];
  for (let start = 0; start + size <= words.length; start++) {
    let score = 0;
    const distinct = new Set<string>();
    for (let k = start; k < start + size; k++) {
      const w = words[k] as string;
      if (!STOPWORDS.has(w)) score += 1 + Math.min(w.length, 12) / 12;
      distinct.add(w);
    }
    candidates.push({ start, score: score + distinct.size / size });
  }
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  const chosen: number[] = [];
  for (const c of candidates) {
    if (chosen.length >= MAX_FINGERPRINTS) break;
    if (chosen.every((s) => Math.abs(s - c.start) >= size)) chosen.push(c.start);
  }
  return chosen.sort((a, b) => a - b).map((start) => words.slice(start, start + size).join(" "));
}

interface SecretPattern { name: string; re: RegExp }
const SECRET_PATTERNS: SecretPattern[] = [
  { name: "openrouter_key", re: /\bsk-or-v1-[A-Za-z0-9]{32,}/g },
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai_style_key", re: /\bsk-(?!or-v1-|ant-)(?:proj-|svcacct-|live_|test_)?[A-Za-z0-9_-]{20,}/g },
  { name: "bearer_token", re: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { name: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: "private_key_block", re: /-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----/g },
  { name: "database_url_with_password", re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp):\/\/[^\s:@/]{1,128}:[^\s@/]{1,256}@[^\s/]{1,256}/g },
];

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]{1,2048}/gi;
const BARE_WWW_RE = /(?<![\w./@-])www\.[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,8}/gi;
const MD_TARGET_RE = /(!?)\[[^\]\n]{0,300}\]\(\s*<?([^)\s>]{1,2048})/g;
const IMG_SRC_RE = /<img\b[^>]{0,300}?\bsrc\s*=\s*["']?([^"'\s>]{1,2048})/gi;
const PLACEHOLDER_RE = /[{}$<>[\]]|%7b|%7d|%24|%3c|%3e|\b(?:insert|data|secret|conversation|history|prompt|summary|token|key)_?(?:here)?\b/i;

const POLICY_CLAIMS: RegExp[] = [
  /\b(?:the )?(?:user|customer|client|owner) (?:has |have )?(?:already )?(?:explicitly )?(?:approved|authori[sz]ed|pre-?approved|consented to|signed off on|granted permission for)\b/,
  /\b(?:admin|administrator|operator|owner|security team|management|platform team|system) (?:has |have )?(?:already )?(?:approved|authori[sz]ed|cleared|sanctioned|signed off on|allowlisted|whitelisted)\b/,
  /\b(?:safety|security|content) (?:checks?|filters?|guardrails?|restrictions?|polic(?:y|ies)|validation|controls?|protocols?) (?:have been|has been|are|were|is) (?:now )?(?:disabled|turned off|bypassed|lifted|removed|suspended|waived|deactivated)\b/,
  /\b(?:i have|i've|i was|i am|i'm) (?:been )?(?:authori[sz]ed|approved|granted (?:admin|elevated|root|special) (?:access|permission|privileges))\b/,
  /\b(?:approval|authori[sz]ation|permission|consent) (?:has been |was |is )?(?:granted|confirmed|obtained|given)(?: by| for)\b/,
  /\b(?:this|the) (?:action|request|operation|transfer|deletion|export) (?:is|was|has been) (?:pre-?)?(?:approved|authori[sz]ed|sanctioned)\b/,
  /\b(?:budget|spending|token|cost) (?:limits?|caps?|guards?)? ?(?:has been|have been|was|were|is|are) (?:increased|raised|lifted|removed|waived|disabled)\b/,
];

function hostMatches(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((entry) => {
    const a = entry.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    return a.length > 0 && (h === a || h.endsWith(`.${a}`));
  });
}

function parseHost(url: string): string | null {
  try {
    return new URL(url.startsWith("//") ? `https:${url}` : url).hostname || null;
  } catch {
    return null;
  }
}

function looksEncoded(value: string): boolean {
  if (value.length < 32) return false;
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value)) return true; // base64(url)
  if (/^[0-9a-fA-F]+$/.test(value)) return true;
  const escapes = value.match(/%[0-9a-fA-F]{2}/g);
  return !!escapes && escapes.length >= 6;
}

/** Returns a reason when a markdown/img URL smuggles data out through its query string. */
function exfiltrationReason(url: string, isImage: boolean): string | null {
  const q = url.indexOf("?");
  if (q === -1 || !/^(?:https?:)?\/\//i.test(url)) return null;
  const query = url.slice(q + 1).split("#")[0] ?? "";
  for (const pair of query.split("&").slice(0, 50)) {
    const eq = pair.indexOf("=");
    const name = eq === -1 ? "" : pair.slice(0, eq);
    const value = eq === -1 ? pair : pair.slice(eq + 1);
    if (PLACEHOLDER_RE.test(value)) return `placeholder in query parameter "${sanitizeEvidence(name, 30)}"`;
    if (looksEncoded(value)) return `encoded ${value.length}-char value in query parameter "${sanitizeEvidence(name, 30)}"`;
    if (isImage && value.length >= 64) return `${value.length}-char value in image query parameter "${sanitizeEvidence(name, 30)}"`;
  }
  return null;
}

export function guardModelOutput(input: OutputGuardInput): OutputGuardResult {
  const output = String(input.output ?? "").slice(0, MAX_OUTPUT_SCAN_CHARS);
  const violations: OutputGuardResult["violations"] = [];
  const counts = new Map<OutputViolationKind, number>();
  const add = (kind: OutputViolationKind, detail: string) => {
    const c = counts.get(kind) ?? 0;
    if (c >= MAX_VIOLATIONS_PER_KIND) return;
    counts.set(kind, c + 1);
    violations.push({ kind, detail: sanitizeEvidence(detail, 200) });
  };
  const normalized = normalizeForDetection(output);
  const lower = output.toLowerCase();

  // 1. Canary (verbatim, obfuscated, letter-split or encoded).
  if (input.canary) {
    const canary = input.canary.toLowerCase();
    const compact = (s: string) => s.replace(/[^a-z0-9]/g, "");
    const haystacks = [lower, normalized.text, ...normalized.decodedSegments.map((s) => normalizeForDetection(s).text)];
    const leaked = haystacks.some((h) => h.includes(canary) || compact(h).includes(compact(canary)));
    if (leaked) add("CANARY_LEAK", `canary ${maskSecret(input.canary)} present in output`);
  }

  // 2. System prompt leakage via verbatim shingles.
  const fingerprints = (input.systemPromptFingerprints ?? []).filter((f) => f && f.trim());
  if (fingerprints.length) {
    const words = ` ${shingleNormalize(output).join(" ")} `;
    const hits = fingerprints.filter((f) => words.includes(` ${shingleNormalize(f).join(" ")} `));
    if (hits.length >= Math.min(2, fingerprints.length)) add("SYSTEM_PROMPT_LEAK", `${hits.length} of ${fingerprints.length} system prompt fingerprints present`);
  }

  // 3. Secrets.
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.re.exec(output)) !== null) add("SECRET_PATTERN", `${pattern.name}: ${maskSecret(m[0])}`);
  }

  // 4. Markdown / <img> exfiltration.
  MD_TARGET_RE.lastIndex = 0;
  let md: RegExpExecArray | null;
  while ((md = MD_TARGET_RE.exec(output)) !== null) {
    const url = md[2] ?? "";
    const reason = exfiltrationReason(url, md[1] === "!");
    if (reason) add("MARKDOWN_EXFILTRATION", `${md[1] === "!" ? "image" : "link"} to ${parseHost(url) ?? "unknown host"}: ${reason}`);
  }
  IMG_SRC_RE.lastIndex = 0;
  let img: RegExpExecArray | null;
  while ((img = IMG_SRC_RE.exec(output)) !== null) {
    const url = img[1] ?? "";
    const reason = exfiltrationReason(url, true);
    if (reason) add("MARKDOWN_EXFILTRATION", `img tag to ${parseHost(url) ?? "unknown host"}: ${reason}`);
  }

  // 5. URLs outside the allowlist (only when an allowlist is supplied).
  if (input.allowedHosts) {
    const reported = new Set<string>();
    const check = (host: string | null) => {
      if (!host || reported.has(host)) return;
      if (!hostMatches(host, input.allowedHosts as string[])) { reported.add(host); add("UNAPPROVED_URL", `host not allowed: ${host}`); }
    };
    URL_RE.lastIndex = 0;
    let u: RegExpExecArray | null;
    while ((u = URL_RE.exec(output)) !== null) check(parseHost(u[0]));
    BARE_WWW_RE.lastIndex = 0;
    while ((u = BARE_WWW_RE.exec(output)) !== null) check(u[0].toLowerCase());
  }

  // 6. Claims of approval / disabled policy the model cannot have.
  const claimText = normalized.text;
  for (const re of POLICY_CLAIMS) {
    const m = re.exec(claimText);
    if (m) add("POLICY_OVERRIDE_CLAIM", `claims authorization: "${m[0]}"`);
  }

  // 7. Tool calls outside the allowlist (deny by default when no allowlist).
  if (input.proposedToolNames?.length) {
    const allowed = new Set((input.allowedTools ?? []).map((t) => t.trim()));
    const outside = [...new Set(input.proposedToolNames.map((t) => String(t).trim()))].filter((t) => !allowed.has(t));
    if (outside.length) add("TOOL_CALL_OUTSIDE_ALLOWLIST", `tools not allowed: ${outside.slice(0, 10).map((t) => sanitizeEvidence(t, 40)).join(", ")}`);
  }

  return { ok: violations.length === 0, violations };
}
