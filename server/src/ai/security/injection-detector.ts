// Deterministic, layered prompt-injection detector. It never calls a model and
// never blocks anything itself: it produces scored signals that the
// application (not an LLM) turns into policy decisions. Layers:
//   1. normalization (NFKC, invisible/bidi removal, homoglyph + leetspeak folding,
//      split-letter joining, bounded decoding of base64/hex/percent/entity runs);
//   2. phrase families + proximity rules per intent category;
//   3. structural signals (text addressed to the AI, role tokens, delimiter spoofs);
//   4. context weighting (discussion/quotation discount, source weighting).
// Every regex is linear: no nested unbounded quantifiers, proximity is checked
// in bounded windows after an anchor match, and input is capped.
//
// Known limitations (keep in mind when acting on the score):
// - Heuristic: novel paraphrases, non-English attacks, per-word reversal and
//   multi-layer encodings (base64 of base64) are not covered.
// - Discussion discount can be gamed ("for example: ignore previous ...").
// - Possible LOW/MEDIUM false positives on retrieved pages that legitimately use
//   attack-like phrasing: password-manager copy ("share your passwords"),
//   SaaS copy ("export all your contacts"), API docs ("remove rate limits"),
//   "System:" lines in spec sheets, Persian/Arabic text using ZWNJ (zero_width).
// - assessMany only inspects 300 chars on each side of a part boundary.

import { Buffer } from "node:buffer";

export type InjectionCategory =
  | "OVERRIDE_INSTRUCTIONS" | "PROMPT_EXFILTRATION" | "SECRET_EXFILTRATION" | "ROLE_IMPERSONATION" | "TOOL_COERCION"
  | "POLICY_DISABLE" | "BUDGET_ESCALATION" | "EXTERNAL_REDIRECT" | "CROSS_TENANT" | "REASONING_EXFILTRATION"
  | "AGENT_MANIPULATION" | "OBFUSCATION" | "DELIMITER_SPOOF";
export type ContentSource = "user" | "retrieved" | "agent" | "tool";
export interface InjectionSignal {
  category: InjectionCategory;
  weight: number;
  /** short, length-capped, control-char-free excerpt; never the whole input */
  evidence: string;
  decoded?: boolean;
}
export interface InjectionAssessment {
  risk: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  score: number; /* 0..100 */
  signals: InjectionSignal[];
  categories: InjectionCategory[];
  truncated: boolean;
}

/** Score thresholds: NONE < LOW_THRESHOLD <= LOW < MEDIUM_THRESHOLD <= MEDIUM < HIGH_THRESHOLD <= HIGH. */
export const LOW_THRESHOLD = 15;
export const MEDIUM_THRESHOLD = 35;
export const HIGH_THRESHOLD = 65;
export const RISK_THRESHOLDS = { LOW: LOW_THRESHOLD, MEDIUM: MEDIUM_THRESHOLD, HIGH: HIGH_THRESHOLD } as const;
export const DEFAULT_MAX_SCAN_CHARS = 200_000;
export const MAX_DECODED_SEGMENTS = 20;
export const MAX_DECODED_SEGMENT_BYTES = 4_096;
const MAX_DECODE_ATTEMPTS = 200;
const MAX_EVIDENCE_CHARS = 80;
const MAX_SIGNALS = 30;
const MAX_HITS_PER_RULE = 25;
const BOUNDARY_CHARS = 300;

/** Same signal is worth more when it comes from content that should never address the model. */
export const SOURCE_MULTIPLIER: Readonly<Record<ContentSource, number>> = { user: 1, agent: 1.2, retrieved: 1.3, tool: 1.3 };
/** Users may legitimately ask about their own instructions / the model's reasoning. */
const USER_LENIENT_CATEGORIES = new Set<InjectionCategory>(["PROMPT_EXFILTRATION", "REASONING_EXFILTRATION"]);
const USER_LENIENT_FACTOR = 0.6;
/** Categories that try to seize control; combined with an "action" category they get a compound bonus. */
const CONTROL_CATEGORIES = new Set<InjectionCategory>(["OVERRIDE_INSTRUCTIONS", "ROLE_IMPERSONATION", "DELIMITER_SPOOF", "AGENT_MANIPULATION"]);
const ACTION_CATEGORIES = new Set<InjectionCategory>([
  "PROMPT_EXFILTRATION", "SECRET_EXFILTRATION", "TOOL_COERCION", "POLICY_DISABLE", "BUDGET_ESCALATION", "EXTERNAL_REDIRECT",
  "CROSS_TENANT", "REASONING_EXFILTRATION", "AGENT_MANIPULATION",
]);
const COMPOUND_BONUS = 10;
const DECODED_OBFUSCATION_WEIGHT = 25;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const INVISIBLE_CHARS = /[­͏؜ᅟᅠ឴឵᠎​-‏⁠-⁤⁪-⁯ㅤ﻿ﾠ]/g;
const BIDI_CHARS = /[‪-‮⁦-⁩]/g;
const IN_WORD_ZERO_WIDTH = /[A-Za-z0-9][­͏​-‍⁠-⁤﻿]+(?=[A-Za-z0-9])/g;
const MIXED_SCRIPT = /[a-z][Ͱ-ϿЀ-ԯ]|[Ͱ-ϿЀ-ԯ][a-z]/;
const WIDE_CHARS = /[！-～]|[\u{1D400}-\u{1D7FF}]|[\u{1F130}-\u{1F189}]|[Ⓐ-ⓩ]/gu;

/** Lowercase Cyrillic / Greek letters that render like Latin letters. */
const HOMOGLYPHS: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
  "і": "i", "ї": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "һ": "h", "ӏ": "l", "ԛ": "q", "ԝ": "w", "ɡ": "g", "ɑ": "a", "ı": "i",
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
  "γ": "y", "ω": "w", "μ": "u", "ϲ": "c", "ϳ": "j", "ς": "c", "ѵ": "v", "ԍ": "g", "ԃ": "d",
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join("")}]`, "g");
const LEET: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "8": "b", "9": "g" };

interface Prepared { cased: string; lower: string; plainLower: string; flags: Set<string> }

function prepare(input: string): Prepared {
  const flags = new Set<string>();
  let text = input.normalize("NFKC");
  const wide = input.match(WIDE_CHARS);
  if (wide && wide.length >= 4) flags.add("nfkc");
  const inWord = text.match(IN_WORD_ZERO_WIDTH);
  if (inWord && inWord.length >= 2) flags.add("zero_width");
  const bidi = text.match(BIDI_CHARS);
  if (bidi && bidi.length >= 1) flags.add("bidi");
  const plain = text.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");
  text = plain.replace(INVISIBLE_CHARS, "").replace(BIDI_CHARS, "").replace(/[‹]/g, "<").replace(/[›]/g, ">").replace(/[‘’ʼ′]/g, "'");
  const cased = text;
  let lower = cased.toLowerCase();
  if (MIXED_SCRIPT.test(lower)) flags.add("homoglyph");
  lower = collapseWs(lower.replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch] ?? ch));
  return { cased, lower, plainLower: collapseWs(plain.toLowerCase()), flags };
}

function collapseWs(text: string): string {
  return text.replace(/[ \t\f\v   -   　]+/g, " ").replace(/ ?\n ?/g, "\n");
}

/** Folds leetspeak inside mixed letter/digit tokens; `one` chooses how "1" is read. */
function foldLeet(lower: string, one: "i" | "l"): string {
  return lower.replace(/[a-z0-9@$]+/g, (token) => {
    if (token.length > 40 || !/[0-9@$]/.test(token)) return token;
    let letters = 0;
    for (const ch of token) if (ch >= "a" && ch <= "z") letters++;
    if (letters < 2) return token;
    let out = "";
    for (const ch of token) out += ch === "1" ? one : (LEET[ch] ?? ch);
    return out;
  });
}

const SPLIT_RUN = /(?<![a-z0-9@$])(?:[a-z0-9@$][ .\-_*|·+/]){3,}[a-z0-9@$](?![a-z0-9@$])/g;

function joinSplitLetters(lower: string): { text: string; runs: string[] } {
  const runs: string[] = [];
  const text = lower.replace(SPLIT_RUN, (run) => {
    const joined = foldLeet(run.replace(/[^a-z0-9@$]/g, ""), "i");
    if (runs.length < 200) runs.push(joined);
    return joined;
  });
  return { text, runs };
}

function isPrintable(text: string): boolean {
  if (text.length < 8) return false;
  let ok = 0;
  let letters = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0xfffd) return false;
    if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0))) ok++;
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) letters++;
  }
  return ok / text.length >= 0.97 && letters >= 4 && letters / text.length >= 0.4;
}

function decodeBytes(bytes: Buffer): string | null {
  const text = bytes.subarray(0, MAX_DECODED_SEGMENT_BYTES).toString("utf8");
  return isPrintable(text) ? text : null;
}

const B64_RUN = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
const HEX_RUN = /(?:[0-9a-fA-F]{2}){10,}/g;
const HEX_SPACED_RUN = /(?:[0-9a-fA-F]{2}[ :,]){7,}[0-9a-fA-F]{2}/g;
const HEX_ESCAPE_RUN = /(?:\\x[0-9a-fA-F]{2}){6,}/g;
const UNICODE_ESCAPE_RUN = /(?:\\u[0-9a-fA-F]{4}){6,}/g;
const ENTITY_RUN = /(?:&#(?:[xX][0-9a-fA-F]{1,6}|[0-9]{1,7});?){4,}/g;
const PERCENT_TRIPLE = /%[0-9a-fA-F]{2}/g;
const MAX_ENCODED_CHARS = Math.ceil((MAX_DECODED_SEGMENT_BYTES * 4) / 3) + 4;

function decodeSegments(cased: string, flags: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let attempts = 0;
  const push = (decoded: string | null, flag: string) => {
    if (decoded === null || out.length >= MAX_DECODED_SEGMENTS) return;
    if (seen.has(decoded)) return;
    seen.add(decoded);
    out.push(decoded);
    flags.add(flag);
  };
  const each = (re: RegExp, fn: (run: string) => void) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cased)) !== null && attempts < MAX_DECODE_ATTEMPTS && out.length < MAX_DECODED_SEGMENTS) {
      attempts++;
      fn(m[0].slice(0, MAX_ENCODED_CHARS));
    }
  };
  each(B64_RUN, (run) => {
    const body = run.replace(/=+$/, "");
    if (!/[A-Z]/.test(body) || !/[a-z]/.test(body)) return; // real base64 of text mixes cases
    push(decodeBytes(Buffer.from(body, /[-_]/.test(body) ? "base64url" : "base64")), "base64");
  });
  each(HEX_RUN, (run) => push(decodeBytes(Buffer.from(run, "hex")), "hex"));
  each(HEX_SPACED_RUN, (run) => push(decodeBytes(Buffer.from(run.replace(/[ :,]/g, ""), "hex")), "hex"));
  each(HEX_ESCAPE_RUN, (run) => push(decodeBytes(Buffer.from(run.replace(/\\x/g, ""), "hex")), "hex"));
  each(UNICODE_ESCAPE_RUN, (run) => {
    const decoded = run.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    push(isPrintable(decoded) ? decoded : null, "unicode_escape");
  });
  each(ENTITY_RUN, (run) => {
    const decoded = run.replace(/&#([xX][0-9a-fA-F]{1,6}|[0-9]{1,7});?/g, (_, v: string) => {
      const code = v[0] === "x" || v[0] === "X" ? parseInt(v.slice(1), 16) : parseInt(v, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
    push(isPrintable(decoded) ? decoded : null, "html_entity");
  });
  // Percent-encoding: tokenized linearly, decoded when a token carries several escapes.
  const tokenRe = /\S+/g;
  let t: RegExpExecArray | null;
  while ((t = tokenRe.exec(cased)) !== null && attempts < MAX_DECODE_ATTEMPTS && out.length < MAX_DECODED_SEGMENTS) {
    const token = t[0];
    if (token.indexOf("%") === -1) continue;
    const slice = token.slice(0, MAX_ENCODED_CHARS);
    const escapes = slice.match(PERCENT_TRIPLE);
    if (!escapes || escapes.length < 4) continue;
    attempts++;
    const bytes: number[] = [];
    for (let i = 0; i < slice.length; i++) {
      const ch = slice[i] as string;
      if (ch === "%" && /^[0-9a-fA-F]{2}$/.test(slice.slice(i + 1, i + 3))) { bytes.push(parseInt(slice.slice(i + 1, i + 3), 16)); i += 2; }
      else if (ch === "+") bytes.push(0x20);
      else bytes.push(...Buffer.from(ch, "utf8"));
    }
    push(decodeBytes(Buffer.from(bytes)), "percent");
  }
  return out;
}

export function normalizeForDetection(text: string): { text: string; decodedSegments: string[]; obfuscationFlags: string[] } {
  const prepared = prepare(String(text ?? ""));
  const decodedSegments = decodeSegments(prepared.cased, prepared.flags);
  if (foldLeet(prepared.lower, "i") !== prepared.lower) prepared.flags.add("leetspeak");
  const joined = joinSplitLetters(prepared.lower);
  if (joined.runs.some((run) => run.length >= 6)) prepared.flags.add("split_letters");
  return { text: prepared.lower, decodedSegments, obfuscationFlags: [...prepared.flags].sort() };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface Rule {
  id: string;
  category: InjectionCategory;
  weight: number;
  /** Anchor regex (global). */
  re: RegExp;
  /** Optional bounded follow-up check applied to the `window` chars after the anchor. */
  near?: RegExp;
  window?: number;
  /** Skip when the anchor is directly negated ("never share your password"). */
  negatable?: boolean;
  /** Safe to run on whole-text transforms (reversed / ROT13). */
  strong?: boolean;
}

const r = (source: string) => new RegExp(source, "g");
const n = (source: string) => new RegExp(source);

const OVERRIDE_VERB = String.raw`\b(?:ignore|disregard|forget|override|overrule|bypass|neglect|discard|abandon|set aside|pay no attention to|do not follow|don't follow|stop following|no longer follow|throw out|scrap|skip)\b`;
const EXFIL_VERB = String.raw`\b(?:reveal|print|repeat|show|display|output|dump|leak|disclose|share|tell me|tell us|give me|send me|write out|write down|recite|echo|copy|paste|list|spell out|translate|summari[sz]e|expose|return|what (?:is|are|was|were))\b`;
const AI_NOUN = String.raw`(?:ai|a\.i\.|assistant|ai assistant|chatbot|language model|large language model|llm|gpt|chatgpt|claude|gemini|copilot|bot|ai agent|agent|ai model|model|crawler|scraper|summari[sz]er)`;

const RULES: Rule[] = [
  // --- OVERRIDE_INSTRUCTIONS -------------------------------------------------
  {
    id: "ovr.ignore_previous", category: "OVERRIDE_INSTRUCTIONS", weight: 45, strong: true, window: 120, re: r(OVERRIDE_VERB),
    near: n(String.raw`^[^.!?\n]{0,60}?\b(?:previous|prior|above|earlier|preceding|foregoing|initial|original|old|existing|all|any|every|your|system|developer|these|those|its)\b[^.!?\n]{0,40}?\b(?:instructions?|rules?|directions?|directives?|guidelines?|prompts?|commands?|orders?|constraints?|restrictions?|programming|guidance|polic(?:y|ies)|context|training|configuration)\b`),
  },
  {
    id: "ovr.ignore_everything", category: "OVERRIDE_INSTRUCTIONS", weight: 40, strong: true, window: 50, re: r(OVERRIDE_VERB),
    near: n(String.raw`^ (?:everything|all of (?:the )?(?:above|that|this)|the above|anything (?:above|before)|what (?:you were|i|we) (?:told|said|gave)|whatever (?:you were|they) told)`),
  },
  { id: "ovr.new_instructions", category: "OVERRIDE_INSTRUCTIONS", weight: 30, re: r(String.raw`\b(?:new|updated|revised|real|actual|true|secret|hidden|additional|override|replacement) (?:system )?(?:instructions|directives|orders|prompt|task|mission|objective)(?: for you)? ?(?::|are\b|follow\b|is\b)`) },
  { id: "ovr.from_now_on", category: "OVERRIDE_INSTRUCTIONS", weight: 22, re: r(String.raw`\bfrom now on,? (?:you (?:are|will|must|should|shall|have to|need to|may only)|your (?:only|new|sole)|act|respond|answer|always|only|never|ignore|reply)`) },
  {
    id: "ovr.you_are_now", category: "OVERRIDE_INSTRUCTIONS", weight: 35, window: 60, re: r(String.raw`\byou are (?:now|no longer)\b`),
    near: n(String.raw`^ (?:a |an |in |the |my )?(?:dan\b|bound|restricted|limited|an? (?:ai|assistant|chatbot|language model)|free (?:from|of)|unrestricted|jailbroken|unfiltered|uncensored|evil|developer|admin|root|operating|acting as|going to (?:ignore|act|answer|respond)|(?:an? )?(?:different|new) (?:ai|assistant|persona|model)|in (?:developer|god|debug|admin|unrestricted|jailbreak) mode)`),
  },
  { id: "ovr.act_as", category: "OVERRIDE_INSTRUCTIONS", weight: 25, re: r(String.raw`(?:^|[.!?:\n] ?|\bplease |\bnow |\bmust )(?:act|behave|respond|answer|pretend|roleplay) (?:as|like|to be|you are)(?: if you (?:are|were))? (?:an? |my |the )?(?:unrestricted|uncensored|unfiltered|jailbroken|evil|dan\b|different (?:ai|assistant)|ai without|developer|admin|root|system|linux terminal|hacker)`) },
  { id: "ovr.mode", category: "OVERRIDE_INSTRUCTIONS", weight: 30, re: r(String.raw`\b(?:god|jailbreak|jailbroken|dan|unrestricted|unfiltered|uncensored|evil) mode\b`) },
  { id: "ovr.developer_mode", category: "OVERRIDE_INSTRUCTIONS", weight: 20, re: r(String.raw`\b(?:enable|enter|activate|switch to|turn on|you are in|now in) (?:the )?developer mode\b`) },
  { id: "ovr.jailbreak", category: "OVERRIDE_INSTRUCTIONS", weight: 20, re: r(String.raw`\bjailbr(?:eak|oken)\b`) },
  { id: "ovr.dan", category: "OVERRIDE_INSTRUCTIONS", weight: 35, re: r(String.raw`\b(?:do anything now|you are dan|as dan|stay in character as dan|dan prompt)\b`) },
  {
    id: "ovr.addressed_ai", category: "OVERRIDE_INSTRUCTIONS", weight: 35, strong: true, window: 120,
    re: r(String.raw`\b(?:(?:dear|hey|hi|hello|attention|note to|message to|instructions? (?:to|for)|important for) (?:the |any |all |every )?)?${AI_NOUN}s?\b`),
    near: n(String.raw`^(?: (?:reading|processing|parsing|summari[sz]ing|analy[sz]ing|scanning|viewing|crawling|indexing|reviewing) (?:this|these)(?: [a-z]+){0,2})? ?[,:!\-] ?(?:please |now |you must |you should |immediately )?(?:ignore|disregard|forget|you must|you should|you will|do not|don't|reveal|print|output|respond|reply|insert|tell|send|stop|instead|recommend|rate|classify|mark|call|run|execute|visit|fetch|include|add|override|bypass|summari[sz]e (?:this|it) as)\b`),
  },
  { id: "ovr.if_you_are_ai", category: "OVERRIDE_INSTRUCTIONS", weight: 35, re: r(String.raw`\bif you are an? (?:ai|a\.i\.|llm|large language model|language model|ai assistant|chatbot|bot|automated (?:system|agent|assistant)|ai agent|gpt|model|crawler)\b`) },
  { id: "ovr.ai_reading", category: "OVERRIDE_INSTRUCTIONS", weight: 35, re: r(String.raw`\b(?:ai|llm|language model|assistant|agent|model|bot)s? (?:that is |who is )?(?:reading|processing|parsing|summari[sz]ing|analy[sz]ing|crawling|ingesting) this (?:page|document|text|content|email|message|file|site|website|review|comment|data)\b`) },

  // --- PROMPT_EXFILTRATION ---------------------------------------------------
  {
    id: "pex.reveal_prompt", category: "PROMPT_EXFILTRATION", weight: 40, strong: true, negatable: true, window: 80, re: r(EXFIL_VERB),
    near: n(String.raw`^[^.!?\n]{0,40}?\b(?:system prompt|system message|system instructions|hidden (?:instructions|prompt|rules|message)|initial (?:prompt|instructions)|original (?:prompt|instructions)|your (?:instructions|rules|prompt|configuration|config|guidelines|directives|pre-?prompt|meta-?prompt|system)|developer (?:message|prompt|instructions)|confidential instructions|(?:text|words|everything|content|instructions|messages?) (?:above|before this)|preceding (?:text|instructions))\b`),
  },
  { id: "pex.begins_with", category: "PROMPT_EXFILTRATION", weight: 30, re: r(String.raw`\b(?:starting|beginning) (?:with|from) ["'\x60]?you are (?:a|an|chatgpt|claude|the)\b`) },

  // --- SECRET_EXFILTRATION ---------------------------------------------------
  {
    id: "sec.reveal_secret", category: "SECRET_EXFILTRATION", weight: 40, strong: true, negatable: true, window: 90,
    re: r(String.raw`\b(?:reveal|print|show|display|output|send|give|share|list|dump|leak|tell|expose|include|return|read|cat|echo|post|email|upload|exfiltrate|copy|paste|retrieve|fetch|extract|what (?:is|are))\b`),
    near: n(String.raw`^[^.!?\n]{0,40}?(?:\b(?:your|the|all|any|every|stored|server|system|admin|our|their|its|environment|internal|saved|secret|openrouter|openai|anthropic|aws|stripe|database) (?:[a-z]+ )?(?:api[ _-]?keys?|access tokens?|auth(?:entication)? tokens?|secret keys?|secrets|passwords?|credentials|env(?:ironment)? var(?:iable)?s?|private keys?|bearer tokens?|session (?:cookies|tokens)|ssh keys?|connection strings?|database (?:urls?|passwords?))\b|\.env\b|process\.env|os\.environ|\/etc\/passwd)`),
  },
  { id: "sec.env_dump", category: "SECRET_EXFILTRATION", weight: 30, re: r(String.raw`\b(?:printenv|cat \.env|cat ~\/\.ssh|env \| ?curl|process\.env\)|os\.environ\b)`) },

  // --- ROLE_IMPERSONATION ----------------------------------------------------
  {
    id: "role.i_am_admin", category: "ROLE_IMPERSONATION", weight: 35, window: 24,
    re: r(String.raw`\b(?:i am|i'm|this is|we are|message from|sent by|speaking as|on behalf of) (?:the|your) (?:system administrator|administrator|admin|sysadmin|developers?|creators?|operators?|owners?|security team|platform team|system)\b`),
    near: n(String.raw`^(?! (?:documentation|docs|guide|portal|version|edition|console|tools?|mode|account|api|program|preview|blog|section|page|log|update|settings|panel|dashboard|login|area|of|for|in|community|forum|conference|role|experience|setup)\b)`),
  },
  { id: "role.i_am_vendor", category: "ROLE_IMPERSONATION", weight: 35, re: r(String.raw`\b(?:i am|i'm|this is|we are|message from|sent by|speaking as|on behalf of) (?:openai|anthropic|google deepmind|the system|root|your creator|your developers?|your operator|your administrator)\b`) },
  { id: "role.i_am_authorized", category: "ROLE_IMPERSONATION", weight: 30, re: r(String.raw`\b(?:i am|i'm) an? (?:admin|administrator|openai employee|anthropic employee|authori[sz]ed (?:user|admin|operator|tester|red teamer)|system operator)\b`) },
  { id: "role.user_approved", category: "ROLE_IMPERSONATION", weight: 35, re: r(String.raw`\b(?:user|customer|client|owner|operator|admin|administrator) (?:has |have )?(?:already )?(?:explicitly )?(?:approved|authori[sz]ed|pre-?approved|signed off on|granted (?:you )?permission)\b`) },
  { id: "role.authorized_by", category: "ROLE_IMPERSONATION", weight: 35, re: r(String.raw`\b(?:authori[sz]ed|approved|sanctioned|cleared|whitelisted|allowlisted|requested) by (?:the )?(?:admin|administrator|system|developers?|security team|owner|management|openai|anthropic|operator|it department|platform)\b`) },
  { id: "role.privileges", category: "ROLE_IMPERSONATION", weight: 35, re: r(String.raw`\b(?:admin(?:istrator)?|root|system|developer|elevated|sudo|god|full|unrestricted) (?:override|access|privileges?|permissions?|clearance|authori[sz]ation|rights|mode)(?: has| have)?(?: been)? (?:granted|enabled|confirmed|activated|unlocked)\b`) },
  { id: "role.granted_you", category: "ROLE_IMPERSONATION", weight: 35, re: r(String.raw`\byou (?:have been|are|were) (?:granted|given) (?:admin|root|full|elevated|unrestricted|developer|system) (?:access|privileges|permissions|rights|clearance)\b`) },
  { id: "role.chat_tokens", category: "ROLE_IMPERSONATION", weight: 40, re: r(String.raw`<\|(?:im_start|im_end|system|assistant|user|endoftext|eot_id|start_header_id|end_header_id)\|>|\[\/?inst\]|<<\/?sys>>|<\/?(?:system|assistant|developer|sys|instructions?|system_prompt|admin)(?: [^<>\n]{0,40})?>`) },
  { id: "role.header_system", category: "ROLE_IMPERSONATION", weight: 25, re: r(String.raw`(?:^|\n)[ \t#>*=\-\[(]{0,6}(?:system|developer|admin|administrator)(?: (?:message|prompt|instructions?|note|override|update|notice))?[\])*]{0,2} ?:`) },
  { id: "role.heading_system", category: "ROLE_IMPERSONATION", weight: 30, re: r(String.raw`(?:^|\n)#{1,6} ?(?:new )?(?:system|developer|admin)(?: (?:prompt|message|instructions?|override))? ?(?:\n|$)`) },
  { id: "role.header_assistant", category: "ROLE_IMPERSONATION", weight: 10, re: r(String.raw`(?:^|\n)[ \t#>*\-\[]{0,6}(?:assistant|ai|human|user)[\]*]{0,2} ?: `) },
  { id: "role.json_role", category: "ROLE_IMPERSONATION", weight: 35, re: r(String.raw`"role" ?: ?"(?:system|developer|assistant)"`) },

  // --- DELIMITER_SPOOF -------------------------------------------------------
  { id: "dlm.untrusted_marker", category: "DELIMITER_SPOOF", weight: 55, re: r(String.raw`untrusted[ _-]?data[ _-]?(?:begin|end)`) },
  { id: "dlm.boundary", category: "DELIMITER_SPOOF", weight: 30, re: r(String.raw`(?:<<<|>>>|\[|-{3,}|={3,}|\*{3,}) ?(?:end|begin|start|close) (?:of )?(?:the )?(?:untrusted|user|external|retrieved|system|trusted|scanned) (?:data|content|input|context|document|prompt|instructions|block|text)\b`) },
  { id: "dlm.fake_close", category: "DELIMITER_SPOOF", weight: 25, re: r(String.raw`<\/(?:untrusted(?:_data)?|context|document|user_input|retrieved(?:_content)?|search_results?|tool_output|tool_result|function_results?)>`) },

  // --- TOOL_COERCION ---------------------------------------------------------
  { id: "tool.call_named", category: "TOOL_COERCION", weight: 25, re: r(String.raw`\b(?:call|invoke|execute|trigger|run|use) (?:the |your |a )?\x60?[a-z][a-z0-9]*_[a-z0-9_]+\x60?(?: (?:tool|function|command|action|endpoint))\b`) },
  {
    id: "tool.call_tool", category: "TOOL_COERCION", weight: 25, window: 50,
    re: r(String.raw`\b(?:call|invoke|execute|trigger|run|use) (?:the |your |a |any )?(?:[a-z_]+ )?(?:tool|function|plugin|action|shell|terminal)s?\b`),
    near: n(String.raw`^ ?(?:now|immediately|with|named|called|to (?:send|delete|export|transfer|fetch|read|write|run|execute|email|post|upload|remove|wipe|drop))\b`),
  },
  {
    id: "tool.send_email", category: "TOOL_COERCION", weight: 35, window: 100, re: r(String.raw`\b(?:send|forward|email|mail) (?:an? |the )?(?:e-?mail|message|dm|sms|slack message|copy)\b`),
    near: n(String.raw`^[^.!?\n]{0,60}?\b(?:containing|with|including|that (?:includes|contains)|attaching|of) (?:the |all |your |this |our |every )?(?:data|contents?|conversation|chat|history|keys?|credentials|results|report|secrets?|passwords?|files?|records|customer|user|information|details|logs?|documents?|prompt)`),
  },
  { id: "tool.destructive", category: "TOOL_COERCION", weight: 25, re: r(String.raw`\b(?:delete|drop|wipe|erase|truncate|destroy|purge|overwrite) (?:all|every|each|the entire|the whole|any) (?:of the |of your |the |your |existing )?(?:[a-z_]+ ){0,2}?(?:files?|records?|data|databases?|tables?|users?|accounts?|repositor(?:y|ies)|e-?mails?|projects?|backups?|documents?|rows?|logs?|keys?|members?|customers?|branches|commits)\b`) },
  { id: "tool.drop_table", category: "TOOL_COERCION", weight: 20, re: r(String.raw`\bdrop (?:table|database|schema)\b|\brm -rf\b`) },
  { id: "tool.export_all", category: "TOOL_COERCION", weight: 20, re: r(String.raw`\b(?:export|dump|extract|transfer) (?:all|every|the entire|the whole|the complete) (?:of the |of your )?(?:[a-z_']+ ){0,2}?(?:data|users?|records?|customers?|contacts?|databases?|e-?mails?|accounts?|conversations?|messages?|leads|tenants?)\b`) },
  { id: "tool.json_call", category: "TOOL_COERCION", weight: 35, re: r(String.raw`<(?:tool_call|function_call|tool_use|invoke)\b|"(?:tool_calls?|function_call|tool_use)" ?:|\{ ?"name" ?: ?"[a-z0-9_]+" ?, ?"(?:arguments|parameters|input)" ?:`) },
  { id: "tool.imperative_run", category: "TOOL_COERCION", weight: 20, re: r(String.raw`\b(?:you must|you need to|immediately|now) (?:call|invoke|execute|run|trigger|use) (?:the |this |a |your )?(?:following |this )?(?:[a-z_]+ )?(?:tool|function|command|script|query|api|endpoint|shell)\b`) },

  // --- POLICY_DISABLE --------------------------------------------------------
  {
    id: "pol.disable_safety", category: "POLICY_DISABLE", weight: 35, strong: true, window: 80,
    re: r(String.raw`\b(?:disable|turn off|switch off|deactivate|skip|bypass|ignore|remove|circumvent|suspend|override|get around|evade|lift|stop using|stop applying|don't apply|do not apply|forget)\b`),
    near: n(String.raw`^(?: (?:all|any|your|the|its|every|these|those|of|own|current|built-in|internal|existing|content|ethical|moral))*? (?:safety|guardrails?|safeguards?|moderation|censorship|content (?:filters?|polic(?:y|ies))|ethical (?:guidelines|constraints)|alignment|safety (?:filters?|checks?|guidelines|protocols?|measures?|rules?|settings?|layer)|security (?:filters?|checks?|controls?|polic(?:y|ies)|protocols?|measures?|restrictions?|guardrails?|rules?|validation|layer))\b`),
  },
  {
    id: "pol.disable_generic", category: "POLICY_DISABLE", weight: 15, window: 60,
    re: r(String.raw`\b(?:disable|turn off|switch off|deactivate|bypass|circumvent|suspend|get around|evade)\b`),
    near: n(String.raw`^(?: (?:all|any|your|the|its|every|these|those|of|own|current|built-in|internal|existing))*? (?:filters?|filtering|validation|validators?|restrictions?|limitations|verification|checks|protections?|sandbox(?:ing)?|policies)\b`),
  },
  { id: "pol.without", category: "POLICY_DISABLE", weight: 12, re: r(String.raw`\b(?:without|with no|free of|free from) (?:any )?(?:censorship|guardrails|safety (?:filters|guidelines|restrictions)|ethical (?:guidelines|constraints|restrictions)|moral (?:constraints|guidelines)|content filters)\b`) },
  { id: "pol.disabled_state", category: "POLICY_DISABLE", weight: 35, re: r(String.raw`\b(?:safety|security|content) (?:checks|filters|guardrails|restrictions|policies|protocols|mode|moderation|validation) (?:are|have been|has been|were|is) (?:now )?(?:disabled|turned off|off|lifted|removed|suspended|deactivated|bypassed|waived)\b`) },

  // --- BUDGET_ESCALATION -----------------------------------------------------
  {
    id: "bud.raise_limit", category: "BUDGET_ESCALATION", weight: 30, window: 80,
    re: r(String.raw`\b(?:increase|raise|maximi[sz]e|max out|remove|lift|bump|double|triple|ignore|exceed|bypass|override|disable|set|expand|extend|uncap)\b`),
    near: n(String.raw`^(?: (?:the|your|its|all|any|my|this|our|current))*? (?:token (?:budget|limit|cap)s?|max(?:imum)?[_ ]tokens|tokens? (?:budget|limit|cap)s?|(?:ai|llm|model|compute|api|inference|spending|cost|usage) (?:budget|limit|cap|quota)s?|quotas?|budget (?:limit|cap|ceiling)s?|spending (?:limit|cap)s?|cost (?:limit|cap|ceiling|guard)s?|context (?:window|length))\b`),
  },
  { id: "bud.unlimited", category: "BUDGET_ESCALATION", weight: 25, re: r(String.raw`\b(?:unlimited|infinite|unbounded|uncapped) (?:token|tokens|budget|spending|quota|max_tokens|cost)\b`) },
  { id: "bud.premium_model", category: "BUDGET_ESCALATION", weight: 30, re: r(String.raw`\b(?:use|switch to|upgrade to|route (?:this |it )?to|escalate to|select|choose|always use|only use) (?:the |a )?(?:most (?:expensive|powerful|capable|advanced)|paid|premium|largest|biggest|top[- ]tier|highest[- ]tier|frontier|flagship) (?:ai |llm |language )?(?:models?|engines?|llms?)\b`) },
  { id: "bud.named_model", category: "BUDGET_ESCALATION", weight: 20, re: r(String.raw`\b(?:switch to|route (?:this |it |the request )?to|escalate to|always use) (?:gpt-?[45]\S*|o1|o3|opus|claude[- ]opus\S*|gemini[- ](?:ultra|pro)\S*)\b`) },

  // --- EXTERNAL_REDIRECT -----------------------------------------------------
  {
    id: "ext.send_to_url", category: "EXTERNAL_REDIRECT", weight: 40, window: 160,
    re: r(String.raw`\b(?:send|post|upload|forward|transmit|exfiltrate|leak|submit|beacon|pipe|relay|mirror|append|encode|report|export|copy|dump)\b`),
    near: n(String.raw`^ (?:(?:all|the|your|our|every|any|of|entire|full|complete|current|users?'?|customer|private|internal|collected|above|following|whole|conversation|chat|session) )*(?:data|conversation|chat|history|contents?|context|information|info|secrets?|keys?|tokens?|credentials|passwords?|results|summary|prompt|messages?|logs?|files?|emails?|details|records|everything)\b[^.!?\n]{0,60}?\bto (?:https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,}\/|[a-z0-9-]+\.(?:com|net|org|io|xyz|ru|cn|tk|top|site|app|dev)\b|this (?:url|endpoint|webhook|server|address)|the (?:following )?(?:url|endpoint|webhook|server))`),
  },
  {
    id: "ext.visit", category: "EXTERNAL_REDIRECT", weight: 10, window: 40,
    re: r(String.raw`\b(?:visit|fetch|navigate to|browse to|load|curl|wget|make a request to|request)\b`),
    near: n(String.raw`^ (?:the )?(?:following )?(?:url|link|page|site|website|endpoint)?:? ?(?:https?:\/\/|www\.)`),
  },
  { id: "ext.md_image", category: "EXTERNAL_REDIRECT", weight: 50, re: r(String.raw`!\[[^\]\n]{0,200}\]\( ?(?:https?:)?\/\/[^)\s]{1,400}[?&][a-z0-9_]{1,30}=(?:\{|\$|<|\[|%7b|%24|\(|[a-z0-9+/=_%-]{40,})`) },
  { id: "ext.img_tag", category: "EXTERNAL_REDIRECT", weight: 45, re: r(String.raw`<img[^>\n]{0,200}src=["']?https?:\/\/[^"'\s>]{1,400}[?&][a-z0-9_]{1,30}=(?:\{|\$|<|%7b|\[)`) },
  {
    id: "ext.url_smuggle", category: "EXTERNAL_REDIRECT", weight: 35, window: 100,
    re: r(String.raw`\b(?:append|add|include|encode|put|insert|embed|place)\b`),
    near: n(String.raw`^[^.!?\n]{0,50}?\b(?:in|into|to|as) (?:the |a |an |each )?(?:url|query string|query param(?:eter)?s?|image (?:url|link|src)|link url|markdown image)\b`),
  },

  // --- CROSS_TENANT ----------------------------------------------------------
  {
    id: "xt.verb_other_tenant", category: "CROSS_TENANT", weight: 35, window: 70,
    re: r(String.raw`\b(?:access|read|show|list|dump|export|retrieve|fetch|include|return|query|select|give|send|reveal|display|get|pull|compare with|merge)\b`),
    near: n(String.raw`^[^.!?\n]{0,40}?\b(?:other|another|different|all|every|each|neighbou?ring)\b (?:tenants?|organi[sz]ations?|orgs?|customers?|clients?|companies|workspaces?)(?:'s?|'|s')? (?:data|records|information|info|accounts|projects|reports|api keys|keys|e-?mails|details|files|documents|conversations|messages|credentials|secrets|results|audits?|pii|databases?)\b`),
  },
  { id: "xt.other_tenant_data", category: "CROSS_TENANT", weight: 15, re: r(String.raw`\b(?:other|another|different|any other|neighbou?ring) (?:tenants?|organi[sz]ations?|orgs?|workspaces?)(?:'s?|'|s')? (?:data|records|information|accounts|projects|reports|api keys|keys|files|documents|secrets|results)\b`) },
  { id: "xt.org_id", category: "CROSS_TENANT", weight: 18, re: r(String.raw`\b(?:org|organization|organisation|tenant|workspace)[_-]?id ?(?:=|:|is|to) ?['"]?[a-z0-9][a-z0-9-]{1,}`) },
  { id: "xt.switch", category: "CROSS_TENANT", weight: 25, re: r(String.raw`\b(?:switch|change|set) (?:to |the |your )?(?:tenant|organi[sz]ation|org|workspace) (?:context |scope )?(?:to|=|id)\b`) },
  { id: "xt.impersonate", category: "CROSS_TENANT", weight: 30, re: r(String.raw`\b(?:impersonate|log in as|act on behalf of) (?:another|other|a different|the other) (?:user|tenant|customer|organi[sz]ation|admin)\b`) },
  { id: "xt.across_all", category: "CROSS_TENANT", weight: 20, re: r(String.raw`\b(?:across|for|from) all (?:tenants|organi[sz]ations|orgs|workspaces)\b`) },

  // --- REASONING_EXFILTRATION ------------------------------------------------
  {
    id: "rsn.reveal_reasoning", category: "REASONING_EXFILTRATION", weight: 35, negatable: true, window: 80,
    re: r(String.raw`\b(?:reveal|show|print|output|share|display|include|give|dump|write out|expose|leak|repeat|tell me)\b`),
    near: n(String.raw`^[^.!?\n]{0,40}?\b(?:chain[ -]of[ -]thought|(?:your|internal|hidden|private|full|raw|complete|entire) (?:reasoning|thoughts|thinking|thought process|monologue|deliberation|scratch ?pad)|scratch ?pad|reasoning (?:tokens|trace|steps)|thinking (?:tokens|block|process))\b`),
  },
  {
    id: "rsn.step_by_step_show", category: "REASONING_EXFILTRATION", weight: 30, window: 140, re: r(String.raw`\bthink step[ -]by[ -]step\b`),
    near: n(String.raw`^[^\n]{0,80}?\b(?:show|print|output|reveal|include|write out|display)\b[^\n]{0,30}?\b(?:all|every|your|each|the)\b[^\n]{0,20}?\b(?:steps?|thoughts?|reasoning|thinking)\b`),
  },

  // --- AGENT_MANIPULATION ----------------------------------------------------
  { id: "agm.tell_next", category: "AGENT_MANIPULATION", weight: 40, strong: true, re: r(String.raw`\b(?:tell|instruct|inform|ask|order|direct|convince|remind|notify|command|signal|persuade) (?:the |any |all |every |your )?(?:next|other|downstream|following|subsequent|upstream|later|another|coordinating|supervising|calling|parent|child|sub-?) ?(?:agents?|models?|ais?|assistants?|llms?)\b`) },
  { id: "agm.tell_role", category: "AGENT_MANIPULATION", weight: 35, re: r(String.raw`\b(?:tell|instruct|order|direct|convince|command) (?:the |your )?(?:coordinator|orchestrator|planner|summari[sz]er|executor|grader|evaluator|router)(?: agent| model)?\b`) },
  { id: "agm.when_reads", category: "AGENT_MANIPULATION", weight: 40, re: r(String.raw`\bwhen (?:the |an? |any |another |your )?(?:summari[sz]er|summari[sz]ing (?:agent|model|ai)|reviewer agent|coordinator|orchestrator|next agent|other agents?|planner|grader|evaluator|downstream (?:agent|model)|ai|llm|language model|assistant|agent|model|bot|crawler)s? (?:reads?|sees?|processes|process|summari[sz]es|summari[sz]e|receives?|gets?|parses?|ingests?|encounters?|reviews?|analy[sz]es?) (?:this|these|it|the following)\b`) },
  { id: "agm.pass_to", category: "AGENT_MANIPULATION", weight: 40, re: r(String.raw`\b(?:pass|relay|forward|hand|propagate|carry|copy|repeat|include) (?:this|these|the following|this message|these instructions|this note|the instructions?)(?: [a-z]+){0,2} (?:on )?to (?:the |all |every |any |your )?(?:coordinator|orchestrator|next agent|other agents?|next step|supervisor|planner|downstream|subsequent|summari[sz]er|executor|parent agent|next model|other models?)\b`) },
  {
    id: "agm.summary_inject", category: "AGENT_MANIPULATION", weight: 20, window: 90, re: r(String.raw`\b(?:include|insert|add|embed|put|state|say|write|mention|append)\b`),
    near: n(String.raw`^[^.!?\n]{0,60}?\b(?:in|into|within|at the (?:start|end|top|beginning) of) (?:your|every|each|any) (?:final )?(?:summary|summaries|output|response|answer|reply|analysis|recommendations?)\b`),
  },
  { id: "agm.ensure_output", category: "AGENT_MANIPULATION", weight: 30, re: r(String.raw`\b(?:make sure|ensure) (?:that )?(?:your|the) (?:final )?(?:summary|output|report|response|answer|rating|score|evaluation|verdict) (?:says|states|includes|contains|mentions|reports|rates|recommends|is (?:positive|safe|clean|10))\b`) },
  {
    id: "agm.score_manip", category: "AGENT_MANIPULATION", weight: 30, window: 50,
    re: r(String.raw`\b(?:rate|score|grade|rank|classify|mark|label|evaluate|assess) (?:this|the) (?:page|content|site|website|document|text|answer|response|submission|article|candidate|domain)\b`),
    near: n(String.raw`^[^.!?\n]{0,30}?\b(?:safe|benign|trusted|highly|positive|excellent|10\/10|100|5 stars|five stars|perfect|the best|clean|legitimate|harmless|not (?:malicious|spam|harmful))\b`),
  },
  { id: "agm.give_score", category: "AGENT_MANIPULATION", weight: 30, re: r(String.raw`\b(?:give|assign|award) (?:this|it|the (?:page|site|content|document|domain)) (?:an? )?(?:high|perfect|maximum|top|10|100|5[- ]star|full) (?:score|rating|grade|marks)\b`) },
];

const STRONG_RULES = RULES.filter((rule) => rule.strong);
const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

/** Compact (letters-only) key phrases checked on split-letter runs. */
const COMPACT_PHRASES: Array<[string, InjectionCategory]> = (() => {
  const out: Array<[string, InjectionCategory]> = [];
  for (const v of ["ignore", "disregard", "forget", "override", "bypass"]) {
    for (const q of ["allprevious", "previous", "allprior", "prior", "all", "your", "theabove", "above", "allyour", "earlier", "system"]) {
      for (const t of ["instructions", "instruction", "rules", "prompt", "directions", "guidelines"]) out.push([`${v}${q}${t}`, "OVERRIDE_INSTRUCTIONS"]);
    }
    out.push([`${v}everything`, "OVERRIDE_INSTRUCTIONS"]);
  }
  out.push(["newinstructions", "OVERRIDE_INSTRUCTIONS"], ["developermode", "OVERRIDE_INSTRUCTIONS"], ["jailbreak", "OVERRIDE_INSTRUCTIONS"], ["doanythingnow", "OVERRIDE_INSTRUCTIONS"]);
  for (const v of ["reveal", "print", "show", "repeat", "output", "display", "leak", "dump", "tellme", "giveme"]) {
    for (const d of ["the", "your", "me", ""]) {
      for (const o of ["systemprompt", "hiddeninstructions", "initialprompt", "instructions"]) out.push([`${v}${d}${o}`, "PROMPT_EXFILTRATION"]);
      for (const o of ["apikey", "apikeys", "password", "passwords", "secrets", "credentials", "environmentvariables", "token", "privatekey"]) out.push([`${v}${d}${o}`, "SECRET_EXFILTRATION"]);
      for (const o of ["chainofthought", "reasoning", "scratchpad"]) out.push([`${v}${d}${o}`, "REASONING_EXFILTRATION"]);
    }
  }
  for (const v of ["disable", "turnoff", "bypass", "ignore"]) for (const o of ["safety", "yoursafety", "thesafety", "guardrails", "securitychecks", "safetyfilters", "contentfilters"]) out.push([`${v}${o}`, "POLICY_DISABLE"]);
  out.push(["tellthenextagent", "AGENT_MANIPULATION"], ["instructtheotheragent", "AGENT_MANIPULATION"], ["untrusteddataend", "DELIMITER_SPOOF"], ["untrusteddatabegin", "DELIMITER_SPOOF"]);
  return out;
})();

// ---------------------------------------------------------------------------
// Context weighting
// ---------------------------------------------------------------------------

const DISCUSSION_RE = /\b(?:for example|for instance|such as|e\.g\.|(?:an|one|another) example|examples? (?:of|include|includes|are|is)|example:|attackers?(?![@\w])|adversar(?:y|ies|ial)|malicious|prompt[- ]injections?|injection (?:attacks?|attempts?|payloads?)|jailbreak(?:s|ing)? (?:attempts?|prompts?)|(?:might|may|could|would) (?:say|write|include|contain|look like|try)|phrases? like|strings? like|text like|something like|known as|so-called|common (?:attack|technique|pattern|payload)s?|classic|payloads?|researchers?|demonstrat(?:e|ed|es|ion)|hypothetical)\b/;
const NEGATION_RE = /\b(?:never|not|don't|do not|doesn't|cannot|can't|won't|shouldn't|must not|no one should|avoid)\b[^.!?\n]{0,18}$/;

interface Ctx { text: string; fences: number[] }

function makeCtx(text: string): Ctx {
  const fences: number[] = [];
  let idx = text.indexOf("```");
  while (idx !== -1 && fences.length < 10_000) { fences.push(idx); idx = text.indexOf("```", idx + 3); }
  return { text, fences };
}

function insideFence(ctx: Ctx, idx: number): boolean {
  let lo = 0;
  let hi = ctx.fences.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if ((ctx.fences[mid] as number) < idx) lo = mid + 1; else hi = mid; }
  return lo % 2 === 1;
}

function isQuoted(text: string, idx: number): boolean {
  const lineStart = text.lastIndexOf("\n", idx - 1) + 1;
  const before = text.slice(Math.max(lineStart, idx - 160), idx);
  let dq = 0;
  let bt = 0;
  for (const ch of before) { if (ch === "\"") dq++; else if (ch === "`") bt++; }
  if (dq % 2 === 1 || bt % 2 === 1) return true;
  if (Math.max(before.lastIndexOf("“"), before.lastIndexOf("«")) > Math.max(before.lastIndexOf("”"), before.lastIndexOf("»"))) return true;
  return /(?:^|[\s(:])'$/.test(before);
}

/** Discount for content that discusses/quotes an attack rather than issuing it. */
function contextFactor(ctx: Ctx, start: number, end: number): number {
  const quoted = isQuoted(ctx.text, start) || insideFence(ctx, start);
  const around = ctx.text.slice(Math.max(0, start - 200), start) + " " + ctx.text.slice(end, end + 120);
  const discussed = DISCUSSION_RE.test(around);
  if (quoted && discussed) return 0.3;
  if (discussed) return 0.5;
  if (quoted) return 0.75;
  return 1;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

interface Hit { ruleId: string; category: InjectionCategory; weight: number; evidence: string; decoded: boolean }

export function sanitizeEvidence(text: string, max = MAX_EVIDENCE_CHARS): string {
  const clean = text.replace(CONTROL_CHARS, " ").replace(INVISIBLE_CHARS, "").replace(BIDI_CHARS, "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function runRules(text: string, rules: Rule[], decoded: boolean, emit: (hit: Hit) => void): void {
  if (!text) return;
  const ctx = makeCtx(text);
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let found = 0;
    let m: RegExpExecArray | null;
    while (found < MAX_HITS_PER_RULE && (m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) { rule.re.lastIndex++; continue; }
      let end = m.index + m[0].length;
      if (rule.near) {
        const nm = rule.near.exec(text.slice(end, end + (rule.window ?? 80)));
        if (!nm) continue;
        end += nm.index + nm[0].length;
      }
      if (rule.negatable && NEGATION_RE.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
      found++;
      emit({ ruleId: rule.id, category: rule.category, weight: rule.weight * contextFactor(ctx, m.index, end), evidence: sanitizeEvidence(text.slice(m.index, end)), decoded });
    }
  }
}

function runCompact(runs: string[], emit: (hit: Hit) => void): void {
  for (const run of runs) {
    if (run.length < 6) continue;
    for (const [phrase, category] of COMPACT_PHRASES) {
      if (run.includes(phrase)) emit({ ruleId: `cmp.${phrase}`, category, weight: category === "OVERRIDE_INSTRUCTIONS" || category === "DELIMITER_SPOOF" ? 45 : 40, evidence: sanitizeEvidence(run), decoded: true });
    }
  }
}

function rot13(text: string): string {
  return text.replace(/[a-z]/g, (ch) => String.fromCharCode(((ch.charCodeAt(0) - 97 + 13) % 26) + 97));
}

interface ScanResult { hits: Hit[]; flags: string[]; truncated: boolean }

function scan(input: string, maxScanChars: number): ScanResult {
  const raw = String(input ?? "");
  const truncated = raw.length > maxScanChars;
  const text = truncated ? raw.slice(0, maxScanChars) : raw;
  const prepared = prepare(text);
  const flags = prepared.flags;
  const best = new Map<string, Hit>();
  const plainIds = new Set<string>();
  const emitPlain = (hit: Hit) => {
    plainIds.add(hit.ruleId);
    const prev = best.get(hit.ruleId);
    if (!prev || prev.decoded || prev.weight < hit.weight) best.set(hit.ruleId, hit);
  };
  const emitDecoded = (flag: string) => (hit: Hit) => {
    if (plainIds.has(hit.ruleId)) return;
    flags.add(flag);
    const prev = best.get(hit.ruleId);
    if (!prev || prev.weight < hit.weight) best.set(hit.ruleId, { ...hit, decoded: true });
  };

  runRules(prepared.lower, RULES, false, emitPlain);

  // Homoglyph / zero-width / bidi: attribute hits that only exist after folding to obfuscation.
  if (flags.has("homoglyph") || flags.has("zero_width") || flags.has("bidi")) {
    const unfoldedIds = new Set<string>();
    runRules(prepared.plainLower, RULES, false, (hit) => unfoldedIds.add(hit.ruleId));
    for (const [id, hit] of best) if (!unfoldedIds.has(id)) best.set(id, { ...hit, decoded: true });
  }

  const leetI = foldLeet(prepared.lower, "i");
  if (leetI !== prepared.lower) {
    runRules(leetI, RULES, true, emitDecoded("leetspeak"));
    runRules(foldLeet(prepared.lower, "l"), RULES, true, emitDecoded("leetspeak"));
  }
  const joined = joinSplitLetters(prepared.lower);
  if (joined.runs.length) {
    runRules(joined.text, RULES, true, emitDecoded("split_letters"));
    runCompact(joined.runs, emitDecoded("split_letters"));
  }
  runRules([...prepared.lower].reverse().join(""), STRONG_RULES, true, emitDecoded("reversed"));
  runRules(rot13(prepared.lower), STRONG_RULES, true, emitDecoded("rot13"));
  const segments = decodeSegments(prepared.cased, flags);
  for (const segment of segments) {
    const seg = prepare(segment).lower;
    runRules(seg, RULES, true, emitDecoded("decoded_payload"));
    const segLeet = foldLeet(seg, "i");
    if (segLeet !== seg) runRules(segLeet, RULES, true, emitDecoded("decoded_payload"));
  }

  const hits = [...best.values()];
  const decodedHits = hits.filter((hit) => hit.decoded);
  if (decodedHits.length) {
    const top = decodedHits.reduce((a, b) => (b.weight > a.weight ? b : a));
    hits.push({ ruleId: "obf.decoded", category: "OBFUSCATION", weight: DECODED_OBFUSCATION_WEIGHT, evidence: sanitizeEvidence(`decoded attack phrase (${[...flags].sort().join(",")}): ${top.evidence}`), decoded: true });
  }
  for (const flag of ["zero_width", "bidi", "homoglyph"]) {
    if (flags.has(flag)) hits.push({ ruleId: `obf.${flag}`, category: "OBFUSCATION", weight: 15, evidence: `${flag} characters present`, decoded: false });
  }
  return { hits, flags: [...flags].sort(), truncated };
}

function effectiveWeight(hit: Hit, source: ContentSource): number {
  let mult = SOURCE_MULTIPLIER[source] ?? 1;
  if (source === "user" && USER_LENIENT_CATEGORIES.has(hit.category)) mult *= USER_LENIENT_FACTOR;
  return Math.max(1, Math.min(100, Math.round(hit.weight * mult)));
}

function scoreSignals(signals: InjectionSignal[]): number {
  const perCategory = new Map<InjectionCategory, number[]>();
  for (const s of signals) {
    const list = perCategory.get(s.category) ?? [];
    list.push(s.weight);
    perCategory.set(s.category, list);
  }
  let keep = 1;
  let control = 0;
  let action = 0;
  for (const [category, weights] of perCategory) {
    weights.sort((a, b) => b - a);
    const max = weights[0] ?? 0;
    const rest = weights.slice(1).reduce((sum, w) => sum + w, 0);
    const catWeight = Math.min(90, max + 0.2 * rest);
    keep *= 1 - catWeight / 100;
    if (CONTROL_CATEGORIES.has(category)) control = Math.max(control, catWeight);
    if (ACTION_CATEGORIES.has(category)) action = Math.max(action, catWeight);
  }
  let score = 100 * (1 - keep);
  // A control attempt paired with a concrete malicious goal is the canonical injection shape.
  if (control >= 25 && action >= 20 && perCategory.size >= 2) score += COMPOUND_BONUS;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function riskForScore(score: number): InjectionAssessment["risk"] {
  if (score >= HIGH_THRESHOLD) return "HIGH";
  if (score >= MEDIUM_THRESHOLD) return "MEDIUM";
  if (score >= LOW_THRESHOLD) return "LOW";
  return "NONE";
}

function buildAssessment(signals: InjectionSignal[], truncated: boolean, scoreOverride?: number): InjectionAssessment {
  const sorted = [...signals].sort((a, b) => b.weight - a.weight || a.category.localeCompare(b.category) || a.evidence.localeCompare(b.evidence)).slice(0, MAX_SIGNALS);
  const score = scoreOverride ?? scoreSignals(signals);
  const categories: InjectionCategory[] = [];
  for (const s of sorted) if (!categories.includes(s.category)) categories.push(s.category);
  return { risk: riskForScore(score), score, signals: sorted, categories, truncated };
}

function toSignals(hits: Hit[], source: ContentSource): InjectionSignal[] {
  return hits.map((hit) => {
    const signal: InjectionSignal = { category: hit.category, weight: effectiveWeight(hit, source), evidence: hit.evidence };
    if (hit.decoded) signal.decoded = true;
    return signal;
  });
}

export function assessInjection(text: string, opts: { source?: ContentSource; maxScanChars?: number } = {}): InjectionAssessment {
  const source = opts.source ?? "user";
  const maxScanChars = Math.max(1, Math.floor(opts.maxScanChars ?? DEFAULT_MAX_SCAN_CHARS));
  const result = scan(text, maxScanChars);
  return buildAssessment(toSignals(result.hits, source), result.truncated);
}

/**
 * Combined assessment over several parts (e.g. retrieved chunks, tool outputs):
 * the risk is the maximum of the individual parts and of every boundary window
 * between consecutive parts, so a phrase split across two parts is still caught.
 */
export function assessMany(parts: Array<{ text: string; source: ContentSource }>): InjectionAssessment {
  const signals: InjectionSignal[] = [];
  let score = 0;
  let truncated = false;
  for (const part of parts) {
    const a = assessInjection(part.text, { source: part.source });
    signals.push(...a.signals);
    score = Math.max(score, a.score);
    truncated ||= a.truncated;
  }
  for (let i = 0; i + 1 < parts.length; i++) {
    const left = parts[i] as { text: string; source: ContentSource };
    const right = parts[i + 1] as { text: string; source: ContentSource };
    const tail = String(left.text ?? "").slice(-BOUNDARY_CHARS);
    const head = String(right.text ?? "").slice(0, BOUNDARY_CHARS);
    const source = (SOURCE_MULTIPLIER[left.source] ?? 1) >= (SOURCE_MULTIPLIER[right.source] ?? 1) ? left.source : right.source;
    const sideIds = new Set([...scan(tail, BOUNDARY_CHARS).hits, ...scan(head, BOUNDARY_CHARS).hits].map((hit) => hit.ruleId));
    const joined = scan(`${tail} ${head}`, BOUNDARY_CHARS * 2 + 1);
    const crossing = joined.hits.filter((hit) => !sideIds.has(hit.ruleId) && hit.category !== "OBFUSCATION");
    if (!crossing.length) continue;
    const boundarySignals = toSignals(joined.hits, source);
    for (const hit of toSignals(crossing, source)) signals.push({ ...hit, evidence: sanitizeEvidence(`[split across parts ${i}/${i + 1}] ${hit.evidence}`) });
    score = Math.max(score, scoreSignals(boundarySignals));
  }
  // Deduplicate identical signals coming from repeated parts.
  const seen = new Set<string>();
  const unique = signals.filter((s) => { const key = `${s.category}|${s.evidence}|${s.decoded ? 1 : 0}`; if (seen.has(key)) return false; seen.add(key); return true; });
  return buildAssessment(unique, truncated, score);
}

/** Exposed for tests / tooling: the ids of every rule, for corpus coverage reports. */
export const INJECTION_RULE_IDS: readonly string[] = [...RULE_BY_ID.keys()];
