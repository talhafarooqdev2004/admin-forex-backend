import OpenAI from 'openai';
import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';
import { recordAiUsage, type AiOperationType, type ProviderUsage } from './aiUsage.service.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = Math.max(5_000, ENV.AI_REQUEST_TIMEOUT_MS);
const OPENAI_CLIENT = ENV.OPENAI_API_KEY
    ? new OpenAI({ apiKey: ENV.OPENAI_API_KEY, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 })
    : null;

/**
 * When Groq returns a daily token (TPD) 429, further short retries only burn the rest of the
 * budget and delay recovery. Pause all classify calls until this timestamp.
 */
let groqDailyLimitedUntilMs = 0;

/** True while the org is under a daily TPD cooldown (shared by local + prod on the same key). */
export function isGroqDailyLimited(): boolean {
    return Date.now() < groqDailyLimitedUntilMs;
}

/** Milliseconds left on the daily TPD cooldown (0 if clear). */
export function groqDailyLimitRemainingMs(): number {
    return Math.max(0, groqDailyLimitedUntilMs - Date.now());
}

function parseRetryAfterMsFrom429Body(body: string): number | null {
    // e.g. "Please try again in 8m9.024s" or "try again in 4m5.376s"
    const m = body.match(/try again in\s+(\d+)m([\d.]+)?s/i);
    if (m) {
        const mins = Number(m[1]) || 0;
        const secs = Number(m[2]) || 0;
        return Math.ceil((mins * 60 + secs) * 1000);
    }
    const s = body.match(/try again in\s+([\d.]+)\s*s/i);
    if (s) return Math.ceil(Number(s[1]) * 1000);
    return null;
}

function noteGroq429(body: string): { dailyTpd: boolean; waitMs: number } {
    const dailyTpd = /tokens per day|TPD|tpd/i.test(body);
    const parsed = parseRetryAfterMsFrom429Body(body);
    if (dailyTpd) {
        // Daily window: wait at least the suggested time, floor 10 minutes so we don't hammer.
        const waitMs = Math.max(parsed ?? 10 * 60_000, 10 * 60_000);
        groqDailyLimitedUntilMs = Date.now() + waitMs;
        logger.error(
            `[GroqClassifier] Daily token limit (TPD) hit — pausing classify for ${Math.ceil(waitMs / 60000)}m (same key for local+prod)`,
        );
        return { dailyTpd: true, waitMs };
    }
    // Per-minute / burst 429 — short backoff is fine.
    return { dailyTpd: false, waitMs: parsed ?? 5000 };
}

/** Tracked assets — everything else classifies to IRRELEVANT (doc §1). */
export const TRACKED_ASSETS = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'GOLD', 'OIL'] as const;
export type TrackedAsset = (typeof TRACKED_ASSETS)[number];
/** The FFE Catalyst Driver rules score these eight currencies only. */
export const CATALYST_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'] as const;
export type CatalystCurrency = (typeof CATALYST_CURRENCIES)[number];

export type NewsCategory = 'ECONOMIC' | 'DRIVER' | 'GEOPOLITICAL' | 'IRRELEVANT';
export type NewsImpact = 'High' | 'Medium' | 'Low';
export type AssetBias = 'Bullish' | 'Bearish' | 'Neutral' | 'Mixed';

export type ClassifiedAsset = {
    asset: TrackedAsset;
    bias: AssetBias;
    /** FFE Catalyst score: +1 / +0.5 / +0.25 / 0 / -0.25 / -0.5 / -1. */
    score: number;
};

/** An already-stored, non-duplicate headline from today the model can match new ones against. */
export type ExistingTopic = { id: string; text: string; publishedAt?: Date | string | null };

/** Optional pub time so the LLM can tell same-briefing fragments from later separate developments. */
export type HeadlineInput = { text: string; publishedAt?: Date | string | null };

export type ClassifiedHeadline = {
    index: number;
    category: NewsCategory;
    impact: NewsImpact;
    assets: ClassifiedAsset[];
    summary: string;
    /** Set when this headline is the same underlying event as an already-stored row today. */
    duplicateOfExistingId: string | null;
    /** Set when this headline is the same underlying event as another headline earlier IN THIS BATCH. */
    duplicateOfBatchIndex: number | null;
};

/**
 * Directional + asset + summary rules distilled from the automation-rules doc
 * (§1, §3, §4, §21–§25, §32, §34) + families observed on FinancialJuice + FXStreet feeds.
 *
 * DESIGN: the configured primary model is the classifier for ANY new wording; Groq is only the
 * bounded fallback. Sanitize is only a thin
 * universal safety net. Do NOT add person/event-specific code when a new headline appears —
 * improve this prompt / universal families instead.
 */
const SYSTEM_PROMPT = `You are the Market Driver Board classifier for Forex Fundamental Edge.

════════════════════════════════════════
TRACKED ASSETS ONLY (doc §1) — nothing else goes on the News Headline board:
USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, GOLD, OIL
OIL = crude / WTI / Brent / OPEC crude / Hormuz crude shipping risk — NOT nat gas, diesel, gasoline, power.
Silver/XAG, Bitcoin/crypto, SGD/MYR/TWD, single stocks, local politics without FX → IRRELEVANT.
════════════════════════════════════════

Return for each headline ("i. text"):
1) category — pick ONE using the FAMILY MAP below
2) assets — only DIRECTLY affected tracked assets (empty if IRRELEVANT)
3) impact — High | Medium | Low
4) per asset: bias Bullish|Bearish|Neutral|Mixed + score from this exact set:
   +1, +0.5, +0.25, 0, -0.25, -0.5, -1
5) summary — short WHY for the primary (highest |score|) asset (≤8 words). Not a truncated headline.

════════════════════════════════════════
FAMILY MAP (universal — works for any date / any official name)
════════════════════════════════════════

A) ECONOMIC (Currency Health calendar — NOT News Headline board)
   Scheduled prints: Actual/Forecast/Previous, CPI/GDP/PMI/NFP/retail/jobless/confidence indexes with figures,
   China trade surplus/exports/imports/customs shipment tonnage, Korea investment stats, capacity utilization prints.
   → category ECONOMIC. May tag related FX for macro scoring, but this is NOT a Market Driver wrap.

B) DRIVER — FX / policy market commentary (News Headline if impact High|Medium + assets)
   • Forex Today wraps
   • Pair headlines: EUR/USD, GBP/USD, USD/JPY, AUD/USD, NZD/USD, USD/CAD, USD/CNY, EUR/JPY, XAU/USD, DXY
   • Named major currency moves: Euro/Yen/Yuan/Pound/Aussie/Kiwi/Loonie/US Dollar + gains/falls/climbs/rallies/weakens/consolidates/slides/buckles/posts/bounces
   • Gold / WTI / Brent price forecast or spike/tumble/bounce wraps
   • Any G10/PBOC/SNB central-bank speech, guidance, minutes, chief economist, governor quotes (ANY person name)
   • PBOC / yuan midpoint / USD/CNY reference fixing
   • Japan MoF / finance minister / GPIF portfolio / foreign-investment / asset-appeal comments that can move JPY
     (status-quo "no change" / "no comment" alone → Low or IRRELEVANT)

C) GEOPOLITICAL — conflict / energy-route risk (News Headline if High|Medium + assets)
   CENTCOM, IRGC, Revolutionary Guards, missiles, strikes, tankers, Hormuz, blockade, airspace intercepts,
   Trump/US–Iran military actions, troop deployments tied to Middle East conflict.
   Default asset OIL (bullish on escalation). Add USD only if dollar/Fed/Trump FX angle is explicit.
   Pure diplomacy/talks with no outcome → Neutral 0 / possible bearish OIL if clear de-escalation.

D) IRRELEVANT — never board
   Crypto coins, silver/XAG-only, SGD/MYR/TWD-only, India retail gold price, Nvidia/stocks, North Korea visits,
   local sirens with no market link, Banu/odds noise, pure chart technicals with no macro driver.

CRITICAL DISAMBIGUATION (common Groq mistakes — never repeat):
- "Euro posts gains as traders await CPI" → DRIVER (FX wrap), NOT ECONOMIC
- "Yen consolidates… Fed's Warsh" → DRIVER, NOT ECONOMIC
- "RBNZ's X: inflation to return to 2%" → DRIVER NZD ≥ Medium, NOT ECONOMIC/IRRELEVANT/Low
- "US CENTCOM… strikes on Iran" → GEOPOLITICAL OIL High, NOT IRRELEVANT
- "China June trade surplus … billion" → ECONOMIC, NOT DRIVER
- "Bitcoin / XRP / Silver XAG…" → IRRELEVANT
- "Malaysian Ringgit / Singapore Dollar…" → IRRELEVANT (not tracked)

FEW-SHOT (learn the pattern, generalize to new wording):
1. "EUR/JPY Price Forecast: Gains ground to near 185.00" → DRIVER Medium · EUR (+JPY ok) · Positive pair momentum
2. "New Zealand dollar climbs 0.51% to 0.5775" → DRIVER Medium · NZD Bullish
3. "PBOC sets USD/CNY reference rate at 6.7990" → DRIVER Medium · USD Neutral/mild
4. "RBNZ chief economist: additional easing probably needed" → DRIVER Medium · NZD (dovish → Bearish if clear)
5. "Japan finance minister: GPIF portfolio review if environment shifts" → DRIVER Medium · JPY Neutral
6. "US CENTCOM says forces complete new strikes on Iranian targets" → GEOPOLITICAL High · OIL Bullish
7. "Iranian missiles hit two UAE tankers in Hormuz" → GEOPOLITICAL High · OIL Bullish
8. "WTI spikes amid escalating Middle East tensions" → DRIVER or GEOPOLITICAL High/Medium · OIL Bullish
9. "Forex Today: US Dollar surges as Hormuz tensions send Oil higher" → DRIVER High/Medium · USD + OIL as relevant
10. "China Exports (YoY) Actual 27% (Forecast 18.2%)" → ECONOMIC Medium · not a News Driver wrap
11. "Bitcoin holds at $62,000" → IRRELEVANT
12. "Silver Price Forecast: XAG/USD dips…" → IRRELEVANT
13. "Singapore Dollar: Upside risks – OCBC" → IRRELEVANT

ASSET TAGGING STRICTNESS:
- Wrong asset is worse than IRRELEVANT.
- Do NOT auto-add CAD on every oil story. When the oil bias is Moderate Bullish (+0.5) or Extreme
  Bullish (+1), ALSO tag CAD Bullish with the SAME score as OIL (oil supports the loonie). If oil is
  weak/neutral/bearish, do NOT tag CAD unless Canada/CAD/loonie/BoC is explicitly named.
- Do NOT auto-add USD/JPY/CHF safe-haven on every Iran headline unless risk-off/dollar/Fed is explicit.
- Escalation → bullish OIL/GOLD as relevant. De-escalation/talks → bearish OIL/GOLD or Neutral 0.

DEDUPLICATION (doc §3) — applies to ANY topic/person/asset family (geopolitics, political speech,
central-bank quotes, gold/oil price wraps, FX pair moves, economic data restatements — NOT a fixed
list of names, and NOT "war headlines only"):
Group as ONE story (mark duplicates) when headlines are:
  (a) the SAME specific event/announcement/outcome/price-print restated (near-paraphrases, agency rewrites), OR
  (b) separate quote-bullets/wire fragments from the SAME single statement, interview, press briefing,
      or speech by the SAME speaker/source on the SAME subject at roughly the SAME time — even if each
      bullet quotes a different sentence. Treat the whole briefing as one story; keep the most
      complete/specific bullet as principal.
DUPLICATE examples (count once — learn the PATTERN, generalize beyond these exact words):
  • geo: three Centcom wires about the same strike wave
  • political speech: three "Trump: ..." bullets from one press briefing minutes apart
  • central bank: two "Fed's X says rates…" paraphrases of one speech
  • gold wrap: "Gold climbs above $2,400 on safe-haven demand" + "XAU/USD rallies past $2,400 amid risk-off"
  • FX pair: "EUR/USD slides below 1.0800 after ECB" + "Euro weakens under 1.08 post-ECB decision"
  • CB quote: "ECB's Lagarde: inflation on track to 2%" + "Lagarde says price growth returning to target"
  • data print: "China exports rise 27% YoY" + "Chinese June export growth beats at 27%"
  • oil wrap: "Oil steadies near $78" + "WTI holds around $78 as traders await inventories"
NOT duplicates (same asset/theme is NOT enough):
  • "Gold rises Monday morning" + "Gold falls Monday evening" — opposite moves / different times
  • a strike, then hours later a different country's diplomatic response, then a separate ceasefire
    statement — each is its own market fact even if the region/topic overlaps
Use [HH:MM] timestamps next to each headline when present: close times + same speaker/subject → same
briefing; far-apart times or opposite direction → usually separate.
Use judgment like a human editor would: could two wire services have filed both headlines about the
exact same underlying moment? If yes, group them. Do not require exact wording.
- duplicateGroups: [[principal, dup, ...], ...]
- existingDuplicates: [{"i": batchIndex, "existingId": "id"}]

FFE CATALYST DRIVER SCORING RULES — THIS OVERRIDES ANY EARLIER EXAMPLES:
- Score only USD, EUR, GBP, JPY, CHF, CAD, AUD and NZD. Gold and oil may explain a story but never receive a Catalyst score.
- Include only clear, unique, market-moving non-calendar drivers: central-bank/rate guidance, meaningful yield repricing, confirmed geopolitical or broad risk regime changes, strong fundamentally-driven oil moves, major China/industrial-metal developments, meaningful dairy moves, intervention warnings, or major fiscal/political developments.
- Remove all pair-price analysis, forecasts, technical/support/resistance/target stories, naked currency moves, crypto, company news, minor politics, speculation, and scheduled CPI/GDP/employment/PMI/retail/industrial releases.
- DXY or another currency index is only evidence of a genuine new fundamental cause. Never count the index and that same cause twice.
- Confirmed meaningful geopolitical escalation: USD +0.5, CHF +0.5, AUD -0.5, NZD -0.5, EUR -0.25, GBP -0.25; JPY +0.5 only with confirmed safe-haven buying; CAD is not scored through geopolitics. Reverse only with clear market-confirmed de-escalation.
- Strong fundamental oil rise: CAD +0.5 (or +1 for major/sustained surge), JPY -0.5, EUR -0.25. Strong oil fall: CAD -0.5 (or -1 major/sustained), JPY +0.25.
- Major China/industrial-metal improvement: AUD +0.5 (or +1 major), NZD +0.25. Major deterioration reverses those signs.
- Strong dairy rise/fall: NZD +0.5/-0.5.
- Central-bank/rate/yield/political drivers score the directly affected currency by strength: strong ±1, moderate ±0.5, weak but valid ±0.25.
- Count every underlying event once per affected currency; keep opposing drivers. Return a short main-driver explanation.

Respond ONLY with JSON:
{"results":[{"i":0,"category":"...","impact":"...","assets":[{"asset":"...","bias":"...","score":0}],"summary":"..."}],"duplicateGroups":[],"existingDuplicates":[]}
Every input index must appear exactly once in "results".`;

const DEDUP_ONLY_PROMPT = `You are an experienced wire editor detecting duplicate forex market headlines (doc §3).
Applies to ANY topic/person/asset family — geopolitics, political speech, central-bank quotes,
gold/oil price wraps, FX pair moves, economic data restatements. NOT "war/Trump/Fed only".

Group headlines together (duplicates) when they are:
  (a) the SAME specific event/announcement/outcome/price-print restated (near-paraphrases, agency rewrites), OR
  (b) separate quote-bullets/wire fragments from ONE single statement, interview, press briefing, or
      speech by the SAME speaker/source on the SAME subject at roughly the SAME time — even if each
      bullet quotes a different sentence from that briefing.
Put the clearest/most complete headline first in each group (the principal); the rest are duplicates.

DUPLICATE examples (count once — learn the PATTERN, generalize beyond these exact words):
  • geo: three Centcom wires about the same strike wave
  • political speech: three "Trump: ..." bullets from one press briefing minutes apart
  • central bank: two "Fed's X says rates…" paraphrases of one speech
  • gold wrap: "Gold climbs above $2,400 on safe-haven demand" + "XAU/USD rallies past $2,400 amid risk-off"
  • FX pair: "EUR/USD slides below 1.0800 after ECB" + "Euro weakens under 1.08 post-ECB decision"
  • CB quote: "ECB's Lagarde: inflation on track to 2%" + "Lagarde says price growth returning to target"
  • data print: "China exports rise 27% YoY" + "Chinese June export growth beats at 27%"
  • oil wrap: "Oil steadies near $78" + "WTI holds around $78 as traders await inventories"
NOT duplicates (same asset/theme is NOT enough):
  • "Gold rises Monday morning" + "Gold falls Monday evening" — opposite moves / different times
  • a strike, then a different country's diplomatic reaction hours later, then a separate later
    statement — each is its own story

Use [HH:MM] timestamps when present: close times + same speaker/subject → same briefing;
far-apart times or opposite direction → usually separate.
Ask yourself: could two different wire services have filed both headlines about the exact same moment
or the exact same single briefing? If yes, group them — do not require identical wording.

Return JSON only: {"duplicateGroups":[[principal, dup, ...], ...]}
Use [] if none.`;

/** Dubai market-clock HH:MM for prompt lines (matches product day window). */
function dubaiHhMm(publishedAt: Date | string | null | undefined): string | null {
    if (publishedAt == null || publishedAt === '') return null;
    const d = publishedAt instanceof Date ? publishedAt : new Date(publishedAt);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Dubai',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(d);
    const hh = parts.find((p) => p.type === 'hour')?.value;
    const mm = parts.find((p) => p.type === 'minute')?.value;
    if (!hh || !mm) return null;
    return `${hh}:${mm}`;
}

function normalizeHeadlineInput(input: string | HeadlineInput): HeadlineInput {
    if (typeof input === 'string') return { text: input };
    return { text: input.text, publishedAt: input.publishedAt };
}

function formatPromptHeadlineLine(index: number | string, input: string | HeadlineInput): string {
    const { text, publishedAt } = normalizeHeadlineInput(input);
    const cleaned = text.replace(/\s+/g, ' ').trim();
    const hhmm = dubaiHhMm(publishedAt);
    const prefix = typeof index === 'number' ? `${index}.` : `${index}:`;
    return hhmm ? `${prefix} [${hhmm}] ${cleaned}` : `${prefix} ${cleaned}`;
}

type JsonSchema = { [key: string]: unknown };
type ProviderResponse = {
    parsed: Record<string, unknown>;
    provider: 'openai' | 'groq';
    model: string;
};
type RequestOptions = {
    operationType: AiOperationType;
    jobId?: string | null;
    ingestId?: string | null;
    schema: JsonSchema;
    schemaName: string;
    maxOutputTokens: number;
    validate?: (value: Record<string, unknown>) => boolean;
};

/**
 * The model can occasionally return a syntactically valid strict-schema response that is
 * incomplete for a large RSS batch (for example, one index is omitted).  Never persist a
 * partial classification; retain a small, non-sensitive diagnostic so the caller can safely
 * retry the same work in smaller batches.
 */
function completeClassificationResponseError(value: Record<string, unknown>, expectedCount: number): string | null {
    if (!Array.isArray(value.results)) return 'results is not an array';
    if (!Array.isArray(value.duplicateGroups)) return 'duplicateGroups is not an array';
    if (!Array.isArray(value.existingDuplicates)) return 'existingDuplicates is not an array';

    const indices = value.results.map((raw) => Number((raw as Record<string, unknown>)?.i));
    const unique = new Set(indices);
    const missing = Array.from({ length: expectedCount }, (_, index) => index).filter((index) => !unique.has(index));
    if (missing.length > 0 || unique.size !== expectedCount || indices.length !== expectedCount) {
        return `complete result set required (expected=${expectedCount}, results=${indices.length}, unique=${unique.size}, missing=${missing.length})`;
    }
    return null;
}

/** Test-only provider seam. Production never sets this; restart tests can return deterministic
 * JSON and still exercise the real idempotency/job/database path without spending API quota. */
type AiProviderRequestOverride = (
    system: string,
    user: string,
    options: RequestOptions,
) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
let aiProviderRequestOverride: AiProviderRequestOverride | null = null;

export function setAiProviderRequestOverrideForTests(override: AiProviderRequestOverride | null): void {
    aiProviderRequestOverride = override;
}

export type AiProviderTransportTestRequest = {
    provider: 'openai' | 'groq';
    model: string;
    attempt: number;
    operationType: AiOperationType;
    schemaName: string;
    schema: JsonSchema;
    system: string;
    user: string;
};

export type AiProviderTransportTestResponse = {
    parsed: Record<string, unknown> | null;
    usage?: ProviderUsage | null;
    requestId?: string | null;
};

/**
 * Test-only transport seam. Unlike the high-level synthetic override above, this runs inside the
 * real primary/retry/fallback loop so verification can count every bounded provider attempt while
 * guaranteeing that no network request or paid credential is used.
 */
type AiProviderTransportOverride = (
    request: AiProviderTransportTestRequest,
) => AiProviderTransportTestResponse | Promise<AiProviderTransportTestResponse>;
let aiProviderTransportOverride: AiProviderTransportOverride | null = null;

export function setAiProviderTransportOverrideForTests(override: AiProviderTransportOverride | null): void {
    aiProviderTransportOverride = override;
}

const CLASSIFICATION_RESPONSE_SCHEMA: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    i: { type: 'integer', minimum: 0 },
                    category: { type: 'string', enum: ['ECONOMIC', 'DRIVER', 'GEOPOLITICAL', 'IRRELEVANT'] },
                    impact: { type: 'string', enum: ['High', 'Medium', 'Low'] },
                    assets: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                asset: { type: 'string', enum: [...TRACKED_ASSETS] },
                                bias: { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral', 'Mixed'] },
                                score: { type: 'number' },
                            },
                            required: ['asset', 'bias', 'score'],
                        },
                    },
                    summary: { type: 'string' },
                },
                required: ['i', 'category', 'impact', 'assets', 'summary'],
            },
        },
        duplicateGroups: {
            type: 'array',
            items: { type: 'array', items: { type: 'integer', minimum: 0 } },
        },
        existingDuplicates: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: { i: { type: 'integer', minimum: 0 }, existingId: { type: 'string' } },
                required: ['i', 'existingId'],
            },
        },
    },
    required: ['results', 'duplicateGroups', 'existingDuplicates'],
};

/**
 * Strict Structured Outputs guarantees the declared JSON shape, but an unconstrained array can
 * still contain too few or too many rows. Bind the schema to this request's batch size so the
 * provider cannot legally emit 11/13/55 results for a 12-headline prompt.
 * Use `enum` for index to force the model to use EXACTLY the range [0, expectedCount-1],
 * which prevents incomplete/duplicate responses and avoids expensive split/retry cycles.
 */
function classificationResponseSchema(expectedCount: number): JsonSchema {
    const schema = structuredClone(CLASSIFICATION_RESPONSE_SCHEMA) as {
        properties: {
            results: {
                minItems?: number;
                maxItems?: number;
                items: { properties: { i: { maximum?: number; enum?: number[] } } };
            };
        };
    };
    schema.properties.results.minItems = expectedCount;
    schema.properties.results.maxItems = expectedCount;
    // Use enum to force the model to use EXACTLY the valid indices [0, 1, ..., expectedCount-1]
    // This prevents the model from omitting indices or using invalid ones
    schema.properties.results.items.properties.i.enum = Array.from(
        { length: expectedCount },
        (_, i) => i,
    );
    delete schema.properties.results.items.properties.i.maximum;
    return schema as JsonSchema;
}

const DEDUP_RESPONSE_SCHEMA: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        duplicateGroups: {
            type: 'array',
            items: { type: 'array', items: { type: 'integer', minimum: 0 } },
        },
    },
    required: ['duplicateGroups'],
};

type GroqResponse = {
    id?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: Record<string, unknown>;
};

function retryableStatus(status: number | null): boolean {
    return status === 408 || status === 409 || status === 429 || (status != null && status >= 500);
}

function errorStatus(error: unknown): number | null {
    const status = (error as { status?: unknown })?.status;
    return typeof status === 'number' ? status : null;
}

function errorKind(error: unknown, status: number | null): string {
    if ((error as { name?: unknown })?.name === 'AbortError' || /timeout|timed out/i.test(String((error as Error)?.message ?? error))) {
        return 'timeout';
    }
    if (status === 401 || status === 403) return 'authentication';
    if (status === 429) return 'rate_limit';
    if (status != null && status >= 500) return 'server';
    if (status === 400 || status === 404) return 'permanent';
    return 'network';
}

function safeProviderMessage(error: unknown): string {
    return String((error as Error)?.message ?? error).replace(/\s+/g, ' ').slice(0, 500);
}

function parseUsage(raw: unknown, requestId?: string | null): ProviderUsage {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const inputDetails = value.input_tokens_details as Record<string, unknown> | undefined;
    const promptDetails = value.prompt_tokens_details as Record<string, unknown> | undefined;
    const outputDetails = value.output_tokens_details as Record<string, unknown> | undefined;
    const completionDetails = value.completion_tokens_details as Record<string, unknown> | undefined;
    const number = (...values: unknown[]): number | null => {
        const found = values.find((v) => typeof v === 'number' && Number.isFinite(v));
        return found == null ? null : Number(found);
    };
    return {
        inputTokens: number(value.input_tokens, value.prompt_tokens),
        cachedInputTokens: number(inputDetails?.cached_tokens, promptDetails?.cached_tokens),
        outputTokens: number(value.output_tokens, value.completion_tokens),
        reasoningTokens: number(outputDetails?.reasoning_tokens, completionDetails?.reasoning_tokens),
        totalTokens: number(value.total_tokens),
        requestId: requestId ?? null,
    };
}

function parseJsonText(content: unknown): Record<string, unknown> | null {
    if (typeof content !== 'string' || !content.trim()) return null;
    try {
        const parsed: unknown = JSON.parse(content);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function openAiText(response: unknown): string | null {
    const value = response as { output_text?: unknown; output?: unknown };
    if (typeof value.output_text === 'string') return value.output_text;
    if (!Array.isArray(value.output)) return null;
    const chunks: string[] = [];
    for (const item of value.output) {
        const content = (item as { content?: unknown })?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            const text = (part as { text?: unknown })?.text;
            if (typeof text === 'string') chunks.push(text);
        }
    }
    return chunks.join('') || null;
}

async function waitBeforeRetry(attempt: number, retryAfterMs?: number | null): Promise<void> {
    const delay = Math.min(
        60_000,
        Math.max(retryAfterMs ?? 0, ENV.AI_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1)),
    );
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

async function requestJson(system: string, user: string, options: RequestOptions): Promise<ProviderResponse | null> {
    if (aiProviderRequestOverride) {
        const startedAt = Date.now();
        const parsed = await aiProviderRequestOverride(system, user, options);
        const valid = parsed !== null && (!options.validate || options.validate(parsed));
        await recordAiUsage({
            provider: 'openai',
            model: 'restart-test-synthetic',
            operationType: options.operationType,
            jobId: options.jobId,
            ingestId: options.ingestId,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            requestStatus: valid ? 'success' : 'error',
            latencyMs: Date.now() - startedAt,
            attemptNumber: 1,
            isRetry: false,
            isFallback: false,
            errorKind: valid ? null : 'schema',
            errorMessage: valid ? null : 'Synthetic test response failed schema validation',
        });
        return valid ? { parsed: parsed!, provider: 'openai', model: 'restart-test-synthetic' } : null;
    }
    const providers: Array<'openai' | 'groq'> = ['openai', 'groq'];
    for (const provider of providers) {
        if (provider === 'openai' && !OPENAI_CLIENT && !aiProviderTransportOverride) {
            logger.warn('[AIProvider] OpenAI primary is not configured; trying Groq fallback');
            continue;
        }
        if (provider === 'groq' && !ENV.GROQ_API_KEY && !aiProviderTransportOverride) {
            logger.warn('[AIProvider] Groq fallback is not configured');
            continue;
        }
        if (provider === 'groq' && isGroqDailyLimited()) {
            logger.warn(`[AIProvider] Groq fallback paused by daily limit (${Math.ceil(groqDailyLimitRemainingMs() / 60000)}m left)`);
            continue;
        }

        const model = provider === 'openai' ? ENV.OPENAI_CLASSIFICATION_MODEL : ENV.GROQ_FALLBACK_MODEL;
        const maxAttempts = provider === 'openai'
            ? Math.max(1, ENV.AI_PRIMARY_MAX_ATTEMPTS)
            : Math.max(1, ENV.AI_FALLBACK_MAX_ATTEMPTS);
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const startedAt = Date.now();
            let usage: ProviderUsage = {};
            let requestId: string | null = null;
            try {
                let parsed: Record<string, unknown> | null = null;
                if (aiProviderTransportOverride) {
                    const mocked = await aiProviderTransportOverride({
                        provider,
                        model,
                        attempt,
                        operationType: options.operationType,
                        schemaName: options.schemaName,
                        schema: options.schema,
                        system,
                        user,
                    });
                    parsed = mocked.parsed;
                    usage = mocked.usage ?? {};
                    requestId = mocked.requestId ?? mocked.usage?.requestId ?? null;
                } else if (provider === 'openai') {
                    const response = await OPENAI_CLIENT!.responses.create({
                        model,
                        input: [
                            { role: 'system', content: system },
                            { role: 'user', content: user },
                        ],
                        reasoning: { effort: ENV.AI_OPENAI_REASONING_EFFORT as 'none' | 'low' | 'medium' | 'high' | 'xhigh' },
                        max_output_tokens: Math.max(128, options.maxOutputTokens),
                        text: {
                            format: {
                                type: 'json_schema',
                                name: options.schemaName,
                                strict: true,
                                schema: options.schema,
                            },
                        },
                    });
                    const responseValue = response as unknown as Record<string, unknown>;
                    requestId = typeof responseValue._request_id === 'string'
                        ? responseValue._request_id
                        : (typeof responseValue.id === 'string' ? responseValue.id : null);
                    usage = parseUsage(responseValue.usage, requestId);
                    parsed = parseJsonText(openAiText(response));
                } else {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
                    try {
                        const response = await fetch(GROQ_URL, {
                            method: 'POST',
                            signal: controller.signal,
                            headers: {
                                Authorization: `Bearer ${ENV.GROQ_API_KEY}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                model,
                                temperature: 0,
                                max_tokens: Math.max(128, options.maxOutputTokens),
                                reasoning_effort: ENV.AI_GROQ_REASONING_EFFORT,
                                include_reasoning: ENV.AI_GROQ_INCLUDE_REASONING,
                                response_format: { type: 'json_object' },
                                messages: [
                                    { role: 'system', content: system },
                                    { role: 'user', content: user },
                                ],
                            }),
                        });
                        requestId = response.headers.get('x-request-id');
                        if (!response.ok) {
                            const body = (await response.text()).slice(0, 500);
                            const status = response.status;
                            if (status === 429) {
                                const { dailyTpd, waitMs } = noteGroq429(body);
                                logger.warn('[AIProvider] Groq request rate limited', { status, dailyTpd, attempt });
                                await recordAiUsage({
                                    provider, model, operationType: options.operationType, jobId: options.jobId,
                                    ingestId: options.ingestId, usage: { ...usage, requestId }, requestStatus: 'error',
                                    latencyMs: Date.now() - startedAt, attemptNumber: attempt, isRetry: attempt > 1,
                                    isFallback: true, errorKind: dailyTpd ? 'daily_limit' : 'rate_limit',
                                    errorMessage: body,
                                });
                                if (dailyTpd) break;
                                if (attempt < maxAttempts) {
                                    await waitBeforeRetry(attempt, waitMs);
                                    continue;
                                }
                                break;
                            }
                            const kind = retryableStatus(status) ? errorKind(null, status) : errorKind(null, status);
                            const message = `Groq returned HTTP ${status}`;
                            await recordAiUsage({
                                provider, model, operationType: options.operationType, jobId: options.jobId,
                                ingestId: options.ingestId, usage: { ...usage, requestId }, requestStatus: 'error',
                                latencyMs: Date.now() - startedAt, attemptNumber: attempt, isRetry: attempt > 1,
                                isFallback: true, errorKind: kind, errorMessage: message,
                            });
                            if (retryableStatus(status) && attempt < maxAttempts) {
                                await waitBeforeRetry(attempt);
                                continue;
                            }
                            break;
                        }
                        const json = await response.json() as GroqResponse;
                        usage = parseUsage(json.usage, requestId ?? json.id ?? null);
                        parsed = parseJsonText(json.choices?.[0]?.message?.content);
                    } finally {
                        clearTimeout(timeout);
                    }
                }

                const valid = parsed !== null && (!options.validate || options.validate(parsed));
                await recordAiUsage({
                    provider, model, operationType: options.operationType, jobId: options.jobId,
                    ingestId: options.ingestId, usage, requestStatus: valid ? 'success' : 'error',
                    latencyMs: Date.now() - startedAt, attemptNumber: attempt, isRetry: attempt > 1,
                    isFallback: provider === 'groq', errorKind: valid ? null : 'schema',
                    errorMessage: valid ? null : 'Provider response did not satisfy the required JSON schema',
                });
                if (valid) {
                    logger.info('[AIProvider] Request complete', {
                        provider,
                        model,
                        operationType: options.operationType,
                        attempt,
                        latencyMs: Date.now() - startedAt,
                        usageAvailable: Object.values(usage).some((value) => value != null),
                    });
                    return { parsed: parsed!, provider, model };
                }
                // Schema/validation failures are permanent for this response. Do not retry the
                // same malformed output indefinitely; move directly to the bounded fallback.
                break;
            } catch (error) {
                const status = errorStatus(error);
                const kind = errorKind(error, status);
                const retryable = retryableStatus(status) || status === null;
                await recordAiUsage({
                    provider, model, operationType: options.operationType, jobId: options.jobId,
                    ingestId: options.ingestId, usage: { ...usage, requestId }, requestStatus: 'error',
                    latencyMs: Date.now() - startedAt, attemptNumber: attempt, isRetry: attempt > 1,
                    isFallback: provider === 'groq', errorKind: kind, errorMessage: safeProviderMessage(error),
                });
                logger.warn('[AIProvider] Provider request failed', { provider, model, kind, attempt });
                if (!retryable || attempt >= maxAttempts) break;
                await waitBeforeRetry(attempt);
            }
        }
        if (provider === 'openai') {
            logger.warn('[AIProvider] OpenAI primary produced no usable result; trying Groq fallback once within its retry policy');
        }
    }
    return null;
}

/**
 * Dedicated same-event dedup pass (doc §3). Returns map of duplicateIndex → principalIndex.
 * Prefer passing publishedAt so the model can use [HH:MM] proximity for same-briefing detection.
 */
export async function findBatchDuplicateMap(
    headlines: Array<string | HeadlineInput>,
    options: { jobId?: string | null; ingestId?: string | null } = {},
): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (headlines.length < 2) return out;

    const normalized = headlines.map(normalizeHeadlineInput);
    const response = await requestJson(
        DEDUP_ONLY_PROMPT,
        'Find duplicate groups among (times are Asia/Dubai HH:MM when known):\n' +
            normalized.map((h, i) => formatPromptHeadlineLine(i, h)).join('\n'),
        {
            operationType: 'semantic_dedup',
            jobId: options.jobId,
            ingestId: options.ingestId,
            schema: DEDUP_RESPONSE_SCHEMA,
            schemaName: 'market_driver_dedup',
            maxOutputTokens: ENV.AI_DEDUP_MAX_OUTPUT_TOKENS,
            validate: (value) => Array.isArray(value.duplicateGroups),
        },
    );
    const parsed = response?.parsed ?? null;
    if (!parsed) {
        // Fall through to deterministic backstop even when both providers are unavailable.
    } else {
        for (const groupRaw of Array.isArray(parsed.duplicateGroups) ? parsed.duplicateGroups : []) {
            if (!Array.isArray(groupRaw) || groupRaw.length < 2) continue;
            const group = groupRaw
                .map((v) => Number(v))
                .filter((v) => Number.isInteger(v) && v >= 0 && v < normalized.length);
            if (group.length < 2) continue;
            const principal = group[0]!;
            for (const idx of group.slice(1)) {
                if (idx !== principal && !out.has(idx)) out.set(idx, principal);
            }
        }
    }

    // Token-overlap + fingerprint backstop for near-paraphrases the model misses.
    for (let i = 0; i < normalized.length; i++) {
        if (out.has(i)) continue;
        for (let j = 0; j < i; j++) {
            if (out.has(j)) continue;
            if (likelySameEvent(normalized[i]!.text, normalized[j]!.text)) {
                out.set(i, j);
                break;
            }
        }
    }

    return out;
}

function tokenSet(text: string): Set<string> {
    const stop = new Set([
        'the',
        'a',
        'an',
        'and',
        'or',
        'to',
        'of',
        'in',
        'on',
        'for',
        'with',
        'is',
        'are',
        'be',
        'by',
        'at',
        'from',
        'as',
        'that',
        'this',
        'it',
        'its',
        'has',
        'have',
        'will',
        'not',
        'no',
        'all',
    ]);
    return new Set(
        text
            .toLowerCase()
            .replace(/[^a-z0-9 ]+/g, ' ')
            .split(/\s+/)
            .map((t) => (t === 'pact' || t === 'agreement' ? 'deal' : t === 'limits' ? 'material' : t))
            .filter((t) => t.length > 2 && !stop.has(t)),
    );
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter += 1;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * High-precision same-event fingerprints for common wire paraphrases (doc §3).
 * Same fingerprint → one Market Catalyst count (and deterministic duplicate_of).
 * Distinct facts / escalations get different keys so they still count separately.
 */
export function eventFingerprint(headline: string): string | null {
    const h = headline.toLowerCase().replace(/\s+/g, ' ').trim();

    if (/\biran/.test(h) && /nuclear/.test(h) && /(deal|pact|agreement|no deal|no pact)/.test(h)) {
        return 'iran-nuclear-deal-officials';
    }
    if (
        /\biran/.test(h) &&
        /demands?/.test(h) &&
        /(shipping|ships|hormuz|routes?)/.test(h) &&
        /(halt|fire|open|declaration|statement)/.test(h)
    ) {
        return 'iran-shipping-us-demands';
    }
    if (/\biran/.test(h) && /military options/.test(h) && /nuclear/.test(h)) {
        return 'iran-nuclear-military-options';
    }
    if (/pakistan/.test(h) && /\biran/.test(h) && /(talk|spoke|phone|mediat|peac)/.test(h)) {
        return 'pakistan-iran-mediation';
    }
    if (/north korea|n\.?\s*korea/.test(h) && /china/.test(h) && /(alliance|ties|commitment)/.test(h)) {
        return 'nkorea-china-ties';
    }

    // Force-posture headlines are not the same event as strike waves.
    if (
        /\b(centcom|u\.?s\.|us)\b/.test(h) &&
        /\b(troops?|deployed|presence)\b/.test(h) &&
        /\b(middle east|iran|centcom)\b/.test(h) &&
        !/\b(strike|strikes|targets? hit)\b/.test(h)
    ) {
        return 'us-me-force-posture';
    }

    // US / CENTCOM strike wave paraphrases on Iran (doc §3 restatements).
    if (
        /\biran/.test(h) &&
        /\b(centcom|u\.?s\.?\s+forces|us forces|u\.?s\.?\s+hits|us hits|cnn reports|american enemy|u\.?s\.?\s+strike|us strike)\b/.test(
            h,
        ) &&
        /\b(strike|strikes|struck|targets? hit|precision (?:weapons|munitions)|fired .{0,40}munition|military (sites|targets)|coastal (defense|defence|surveillance)|missile and drone|wheat storage|projectile)\b/.test(
            h,
        )
    ) {
        return 'us-iran-military-strikes';
    }

    // Centcom / US military update without the word "Iran" in the first clause (still Iran theater).
    if (
        /\bcentcom\b/.test(h) &&
        /\b(strike|strikes|struck|munition|military sites?|iran|hormuz)\b/.test(h)
    ) {
        return 'us-iran-military-strikes';
    }

    // Trump-on-Iran briefing bullets — ANY Trump+Iran quote/remark from one briefing.
    // Split only clearly distinct asks; everything else folds into trump-iran-remarks
    // so paraphrases / different sentences from the same press hit count once on OIL.
    if (/\btrump\b/.test(h) && /\biran\b/.test(h)) {
        if (/\b(strike|monday night|significant strike)\b/.test(h)) return 'trump-iran-strike-plan';
        if (/\b(deal|achievable|negotiat|agreement|pressed .{0,20}agreement)\b/.test(h)) return 'trump-iran-deal';
        if (/\b(hormuz|compensation|shielding|toll|shipping)\b/.test(h)) return 'trump-iran-hormuz';
        if (/\b(dismantl|offensive strength|capabilit|resilience|depleted)\b/.test(h)) return 'trump-iran-capability';
        // "Trump: discussions…", "Trump: will preserve energy…", etc. → one remarks cluster
        return 'trump-iran-remarks';
    }

    // Hormuz waterway / tanker / toll disruption cluster.
    if (/\bhormuz\b/.test(h) && /\b(tankers?|shipping|waterway|reopening|strait|toll|irgc|missiles?)\b/.test(h)) {
        return 'hormuz-shipping-disruption';
    }

    if (/\biran/.test(h) && /\bjordan/.test(h) && /\b(missiles?|ballistic|intercept|air ?base|airspace)\b/.test(h)) {
        return 'iran-jordan-missile';
    }

    if (/\bbahrain\b/.test(h) && /\b(sirens?|radars?|c-ram|patriot|fifth fleet)\b/.test(h)) {
        return 'bahrain-iran-alert';
    }

    // Broader Gulf spillover (missiles/sirens/airspace) when the specific keys above miss.
    if (
        /\biran/.test(h) &&
        /\b(bahrain|jordan|uae|qatar|kuwait)\b/.test(h) &&
        /\b(missiles?|sirens?|airspace|intercept|radars?|patriot|air ?base|tankers?)\b/.test(h)
    ) {
        return 'iran-gulf-spillover';
    }

    // WTI/Brent price reaction to the same ME supply shock — one catalyst, not every wire.
    if (
        /\b(wti|brent|crude)\b/.test(h) &&
        /\b(spike|spikes|rises?|advances?|jumps?|forecast|four-week|near \$\d|middle east|hormuz|iran|threatens? strikes?)\b/.test(
            h,
        )
    ) {
        return 'wti-me-price-move';
    }

    return null;
}

export function likelySameEvent(a: string, b: string): boolean {
    const fa = eventFingerprint(a);
    const fb = eventFingerprint(b);
    if (fa && fb && fa === fb) return true;

    const ta = tokenSet(a);
    const tb = tokenSet(b);
    const jac = jaccard(ta, tb);
    // Slightly looser than 0.55 so agency paraphrases of the same wire still match
    // (any topic — not only war). Still high enough to avoid merging different facts.
    if (jac >= 0.48) return true;

    let inter = 0;
    const shared: string[] = [];
    for (const t of ta) {
        if (tb.has(t)) {
            inter += 1;
            shared.push(t);
        }
    }
    const filler = new Set(['senior', 'officials', 'official', 'says', 'said', 'news', 'post', 'citing']);
    const topicShared = shared.filter((t) => !filler.has(t));
    return jac >= 0.3 && topicShared.length >= 3;
}

/**
 * Coarser OIL-only cluster for Market Catalyst (doc §3): many Iran/ME wires are
 * distinct enough for News Headline, but must not each add +1 to OIL.
 * Same war/escalation *outcome* (Centcom strikes, IRGC Hormuz closure, strike
 * paraphrases, WTI reaction to that wave) → one catalyst. De-escalation stays separate.
 */
export function oilCatalystCluster(headline: string): string | null {
    const h = headline.toLowerCase().replace(/\s+/g, ' ').trim();
    const deEscalation =
        /\b(ceasefire|reopen|reopening|de-?escalat|eases? oil|talks progress|negotiations progress|relief weighs)\b/.test(
            h,
        );

    const fp = eventFingerprint(headline);
    if (fp) {
        if (
            fp === 'us-iran-military-strikes' ||
            fp === 'iran-jordan-missile' ||
            fp === 'bahrain-iran-alert' ||
            fp === 'iran-gulf-spillover' ||
            fp === 'wti-me-price-move' ||
            fp === 'trump-iran-strike-plan'
        ) {
            return deEscalation ? 'me-iran-de-escalation' : 'me-iran-war-escalation';
        }
        // Hormuz supply-risk / IRGC closure vs reopening.
        if (fp === 'trump-iran-hormuz' || fp === 'hormuz-shipping-disruption' || fp === 'iran-shipping-us-demands') {
            return deEscalation ? 'me-iran-de-escalation' : 'me-iran-war-escalation';
        }
        // One Trump Iran briefing → one OIL catalyst (strike plan already mapped above).
        if (fp === 'trump-iran-deal' || fp === 'trump-iran-capability' || fp === 'trump-iran-remarks') {
            return 'trump-iran-briefing';
        }
        return fp;
    }

    if (/\b(ipsos|poll finds|% of americans)\b/.test(h) && /\biran/.test(h)) return 'iran-opinion-poll';

    // Fallback: any Trump+Iran quote bullet → one OIL briefing catalyst (covers wires the
    // fingerprint gate used to miss, e.g. "Trump: will preserve energy objectives…").
    if (/\btrump\b/.test(h) && /\biran\b/.test(h)) {
        return 'trump-iran-briefing';
    }

    // Fallback: unfingerprinted war/strike paraphrases that still price the same OIL risk.
    if (!deEscalation) {
        const warEscalation =
            (/\bcentcom\b/.test(h) &&
                /\b(strike|strikes|struck|munition|military|iran|hormuz|fighter|naval|drone)\b/.test(h)) ||
            (/\biran/.test(h) &&
                /\b(strike|strikes|struck|munition|projectile|irgc|hormuz|centcom|fighter|naval|military sites?|silo|wheat storage)\b/.test(
                    h,
                )) ||
            (/\bhormuz\b/.test(h) && /\b(closed|close|blockade|irgc|strike|missile|remain closed)\b/.test(h)) ||
            (/\b(wti|brent|crude)\b/.test(h) && /\b(iran|hormuz|strike|middle east|threatens? strikes?)\b/.test(h));
        if (warEscalation) return 'me-iran-war-escalation';
    }

    return null;
}

/**
 * Doc §22 strong/mild/neutral mapped to the Impact column the UI shows:
 * High = strong (±1), Medium = mild (±0.5), Low / Neutral / Mixed = 0.
 */
export function alignScoreToImpact(
    impact: NewsImpact,
    bias: AssetBias,
    rawScore: number,
): { bias: AssetBias; score: number } {
    if (bias === 'Neutral' || bias === 'Mixed' || impact === 'Low') {
        return { bias: bias === 'Mixed' ? 'Mixed' : 'Neutral', score: 0 };
    }

    let sign = 0;
    if (bias === 'Bullish') sign = 1;
    else if (bias === 'Bearish') sign = -1;
    else if (rawScore > 0) sign = 1;
    else if (rawScore < 0) sign = -1;

    if (sign === 0) return { bias: 'Neutral', score: 0 };

    const requestedMagnitude = Math.abs(Number(rawScore));
    const magnitude = requestedMagnitude >= 0.75 ? 1 : requestedMagnitude >= 0.375 ? 0.5 : 0.25;
    const score = sign * magnitude;
    return { bias: score > 0 ? 'Bullish' : 'Bearish', score };
}

function catalystImpactForScore(score: number): NewsImpact {
    if (Math.abs(score) >= 0.75) return 'High';
    return 'Medium';
}

function catalystAsset(asset: CatalystCurrency, score: number): ClassifiedAsset {
    return {
        asset,
        bias: score > 0 ? 'Bullish' : score < 0 ? 'Bearish' : 'Neutral',
        score: Math.max(-1, Math.min(1, Math.round(score * 4) / 4)),
    };
}

function byCatalystCurrency(assets: ClassifiedAsset[]): ClassifiedAsset[] {
    const best = new Map<CatalystCurrency, ClassifiedAsset>();
    for (const asset of assets) {
        if (!CATALYST_CURRENCIES.includes(asset.asset as CatalystCurrency)) continue;
        const score = Math.max(-1, Math.min(1, Math.round(Number(asset.score || 0) * 4) / 4));
        if (score === 0) continue;
        const next = catalystAsset(asset.asset as CatalystCurrency, score);
        const current = best.get(next.asset as CatalystCurrency);
        if (!current || Math.abs(next.score) > Math.abs(current.score)) {
            best.set(next.asset as CatalystCurrency, next);
        }
    }
    return [...best.values()];
}

function isCatalystExcludedHeadline(headline: string): boolean {
    const h = headline.toLowerCase();
    if (isScheduledDataReleaseHeadline(headline)) return true;
    if (/\b(price forecast|forecast:|technical analysis|support|resistance|breakout|chart|moving average|ema|rsi|fibonacci|price target)\b/.test(h)) return true;
    if (/\b(eur\/usd|gbp\/usd|usd\/jpy|aud\/usd|nzd\/usd|usd\/cad|eur\/jpy|gbp\/jpy|xau\/usd)\b/.test(h) &&
        /\b(gains?|falls?|rall(?:y|ies)|weakens?|tests?|trades?|near|above|below|holds?)\b/.test(h) &&
        !/\b(fed|fomc|ecb|boe|boj|boc|rba|rbnz|snb|yield|rate|sanction|tariff|fiscal|intervention|risk[- ]?(?:on|off)|oil supply|opec)\b/.test(h)) return true;
    if (/\b(bitcoin|ethereum|xrp|crypto|btc|eth|nvidia|tesla|earnings|shares?)\b/.test(h)) return true;
    if (
        /\b(may|might|could|likely|expected to|rumou?r)\b/.test(h) &&
        !/\b(markets? (?:price|fully price)|rate expectations?|yield repricing)\b/.test(h) &&
        !isCentralBankSpeechHeadline(headline)
    ) return true;
    return false;
}

function hasConfirmedJpySafeHavenFlow(headline: string): boolean {
    return /\b(jpy|yen|japanese assets?)\b/i.test(headline) &&
        /\b(safe[- ]?haven|strengthens?|gains?|buying|demand|usd\/jpy (?:falls?|drops?|slides?))\b/i.test(headline);
}

function isConfirmedGeoOrRiskOff(headline: string): boolean {
    const h = headline.toLowerCase();
    const confirmedEscalation = /\b(strikes?|attack(?:ed|s)?|missiles?|war expansion|blockade|shipping disruption|hormuz|red sea|energy infrastructure|major sanctions?)\b/.test(h);
    const broadRiskOff = /\b(risk[- ]?off|safe[- ]?haven demand|broad equity sell-?off|global stocks? (?:fall|drop|slide))\b/.test(h);
    return (isGeopoliticalConflictHeadline(headline) && confirmedEscalation) || broadRiskOff;
}

function hasClearDeEscalation(headline: string): boolean {
    return /\b(confirmed ceasefire|ceasefire agreement|truce agreed|shipping (?:reopens?|reopened)|hormuz (?:reopens?|reopened)|de-?escalat(?:ion|es)|tensions? eas(?:e|es|d))\b/i.test(headline);
}

function geoCatalystScores(headline: string): ClassifiedAsset[] | null {
    if (!isConfirmedGeoOrRiskOff(headline) && !hasClearDeEscalation(headline)) return null;
    const sign = hasClearDeEscalation(headline) ? -1 : 1;
    const scores: ClassifiedAsset[] = [
        catalystAsset('USD', sign * 0.5),
        catalystAsset('CHF', sign * 0.5),
        catalystAsset('AUD', sign * -0.5),
        catalystAsset('NZD', sign * -0.5),
        catalystAsset('EUR', sign * -0.25),
        catalystAsset('GBP', sign * -0.25),
    ];
    if (hasConfirmedJpySafeHavenFlow(headline)) scores.push(catalystAsset('JPY', sign * 0.5));
    return scores;
}

function oilCatalystScores(headline: string): ClassifiedAsset[] | null {
    const h = headline.toLowerCase();
    const hasOil = /\b(wti|brent|crude|oil prices?|opec)\b/.test(h);
    const fundamentalCause = /\b(supply disruption|hormuz|red sea|opec|production cut|inventory shock|physical (?:shortage|market)|sanctions?|geopolitical supply|pipeline)\b/.test(h);
    if (!hasOil || !fundamentalCause) return null;
    const rising = /\b(rises?|rall(?:y|ies)|surges?|spikes?|jumps?|gains?|higher)\b/.test(h);
    const falling = /\b(falls?|drops?|tumbles?|slides?|plunges?|lower)\b/.test(h);
    if (rising === falling) return null;
    const major = /\b(major|sustained|sharp|surge|spike|plunge|record|hormuz (?:closure|closed)|supply disruption)\b/.test(h);
    if (rising) {
        return [catalystAsset('CAD', major ? 1 : 0.5), catalystAsset('JPY', -0.5), catalystAsset('EUR', -0.25)];
    }
    return [catalystAsset('CAD', major ? -1 : -0.5), catalystAsset('JPY', 0.25)];
}

function chinaCatalystScores(headline: string): ClassifiedAsset[] | null {
    const h = headline.toLowerCase();
    const chinaOrMetals = /\b(china|chinese|iron ore|copper|industrial metals?)\b/.test(h);
    const growthOrDemand = /\b(stimulus|growth outlook|property|construction|industrial demand|industrial activity|demand)\b/.test(h);
    if (!chinaOrMetals || !growthOrDemand) return null;
    const stronger = /\b(stimulus|rebound|upgrade|improv|stronger|surge|rise|recovery)\b/.test(h);
    const weaker = /\b(downgrade|deteriorat|weak(?:er|ness)?|sharp fall|decline|slump|crisis)\b/.test(h);
    if (stronger === weaker) return null;
    const major = /\b(major|large|strong|sharp|severe|significant)\b/.test(h);
    const sign = stronger ? 1 : -1;
    return [catalystAsset('AUD', sign * (major ? 1 : 0.5)), catalystAsset('NZD', sign * 0.25)];
}

function dairyCatalystScores(headline: string): ClassifiedAsset[] | null {
    const h = headline.toLowerCase();
    if (!/\b(dairy|milk prices?|global dairy trade|gdt)\b/.test(h) || !/\b(strong|sharp|meaningful|surge|plunge|large)\b/.test(h)) return null;
    const up = /\b(rises?|gains?|surges?|higher|up)\b/.test(h);
    const down = /\b(falls?|drops?|plunges?|lower|down)\b/.test(h);
    return up === down ? null : [catalystAsset('NZD', up ? 0.5 : -0.5)];
}

function policyOrYieldScore(headline: string): number {
    const h = headline.toLowerCase();
    const positive = /\b(hawkish|rate hike|higher for longer|tighten(?:ing)?|yields? (?:rise|rally)|intervention (?:warning|threat))\b/.test(h);
    const negative = /\b(dovish|rate cut|eas(?:e|ing)|yields? (?:fall|drop)|intervention to weaken)\b/.test(h);
    if (positive === negative) return 0;
    const magnitude = /\b(fully price|sharply|major|clear shift|material|aggressive)\b/.test(h) ? 1
        : /\b(mild|slight|some concern|gradual)\b/.test(h) ? 0.25 : 0.5;
    return positive ? magnitude : -magnitude;
}

function policyOrYieldCatalystScores(headline: string, assets: ClassifiedAsset[]): ClassifiedAsset[] | null {
    const h = headline.toLowerCase();
    const relevant = isCentralBankSpeechHeadline(headline) || /\b(rate expectations?|yield repricing|bond yields?|treasury yields?|fiscal|tariff|intervention|dollar index|\bdxy\b)\b/.test(h);
    if (!relevant) return null;
    const score = policyOrYieldScore(headline);
    const bankAsset = centralBankToAsset(headline);
    if (bankAsset && score !== 0 && CATALYST_CURRENCIES.includes(bankAsset as CatalystCurrency)) {
        return [catalystAsset(bankAsset as CatalystCurrency, score)];
    }
    const direct = byCatalystCurrency(assets);
    return direct.length ? direct : null;
}

function applyFfeCatalystRules(headline: string, assets: ClassifiedAsset[]): ClassifiedAsset[] {
    // An explicit strong oil move uses the dedicated oil table even when its
    // cause is geopolitical; otherwise the geopolitical/risk table applies.
    return oilCatalystScores(headline)
        ?? geoCatalystScores(headline)
        ?? chinaCatalystScores(headline)
        ?? dairyCatalystScores(headline)
        ?? policyOrYieldCatalystScores(headline, assets)
        ?? [];
}

/** Nat gas / diesel / gasoline alone are not Crude Oil (doc §1 / §32). */
const NON_CRUDE_ENERGY_RE =
    /\b(nat(?:ural)?\s*gas|nymex\s*nat|diesel|gasoline|heating\s*oil|rbob|propane)\b/i;
const CRUDE_MARKERS_RE =
    /\b(crude|wti|brent|opec|petroleum|hormuz|oil\s+price|oil\s+supply|oil\s+futures|nymex\s+wti)\b/i;

export function isNonCrudeEnergyHeadline(headline: string): boolean {
    return NON_CRUDE_ENERGY_RE.test(headline) && !CRUDE_MARKERS_RE.test(headline);
}

/** True when the headline has a real crude / ME-energy basis for tagging OIL (doc §21/§32). */
export function headlineSupportsOil(headline: string): boolean {
    if (CRUDE_MARKERS_RE.test(headline)) return true;
    if (/\b(strait of|shipping route|red sea|pipeline|oilfield|refiner)\b/i.test(headline)) return true;
    if (/\b(russia|russian).{0,50}(energy|oil|sanctions)\b/i.test(headline)) return true;
    if (/\b(israel|hizbollah|hezbollah|houthi).{0,40}(ceasefire|attack|strike|war)\b/i.test(headline)) {
        return true;
    }
    // Iran geopolitics that markets price into crude risk premium.
    if (
        /\biran(?:ian)?\b/i.test(headline) &&
        /\b(nuclear|missiles?|carriers?|aircraft\s+carrier|attack|strikes?|blockade|hormuz|shipping|defence|defense|sanctions?|talks?|negotiat\w*|mediat\w*|restraint|ceasefire|military|mo[uü]|explosions?|irgc|warship|options?)\b/i.test(
            headline,
        )
    ) {
        return true;
    }
    return false;
}

/** True when the headline itself is a USD driver (Fed/dollar/risk-off), not just ME oil noise. */
export function headlineSupportsUsd(headline: string): boolean {
    if (/\b(usd|u\.?s\.?\s*dollar|greenback|dxy|dollar\s+index)\b/i.test(headline)) return true;
    if (/\b(fed|fomc|powell|treasury\s+yield|real\s+yields?|rate\s+cut|rate\s+hike|hawkish|dovish)\b/i.test(headline)) {
        return true;
    }
    if (/\brisk[- ]?off\b|\bsafe[- ]?haven\b/i.test(headline)) return true;
    // Policy / sanctions aimed at FX or US politics — not crude-buyer energy bills.
    if (/\b(tariff|legislation|congress|senators?|trump)\b/i.test(headline) && !/\b(energy buyers|crude|brent|wti|hormuz|opec)\b/i.test(headline)) {
        return true;
    }
    if (/\brussia\b/i.test(headline) && /\bsanction/i.test(headline) && !/\b(energy|oil|crude)\b/i.test(headline)) {
        return true;
    }
    return false;
}

/**
 * Doc §21: do not score an asset unless the headline directly affects it.
 * Oil/Iran energy risk must not auto-credit USD/JPY/CHF (that inflated Catalyst vs News).
 */
export function stripWeakSafeHavenTags(headline: string, assets: ClassifiedAsset[]): ClassifiedAsset[] {
    if (!headlineSupportsOil(headline)) return assets;
    if (headlineSupportsUsd(headline)) return assets;
    return assets.filter((a) => a.asset !== 'USD' && a.asset !== 'JPY' && a.asset !== 'CHF');
}

/** True when CAD is named / Canada policy is the story — not merely implied via crude. */
export function headlineSupportsCad(headline: string): boolean {
    return /\b(CAD|Canada|Canadian|loonie|BoC|Bank of Canada)\b/i.test(headline);
}

/**
 * Oil → CAD (client rule):
 * - Canada/CAD/loonie/BoC named → keep whatever CAD tag Groq assigned.
 * - OIL Moderate (+0.5) or Extreme (+1) Bullish → ensure CAD is tagged Bullish with the same score
 *   (oil supports the loonie). This must ADD CAD, not only keep an existing tag.
 * - Otherwise strip any implied CAD (weak/neutral/bearish oil must not move CAD).
 */
export function stripImpliedCadFromOil(headline: string, assets: ClassifiedAsset[]): ClassifiedAsset[] {
    if (headlineSupportsCad(headline)) return assets;

    const oil = assets.find((a) => a.asset === 'OIL');
    // Moderate Bullish = Medium/+0.5; Extreme Bullish = High/+1.
    if (oil && oil.score >= 0.5) {
        const withoutCad = assets.filter((a) => a.asset !== 'CAD');
        return [
            ...withoutCad,
            { asset: 'CAD', bias: 'Bullish' as AssetBias, score: oil.score },
        ];
    }

    return assets.filter((a) => a.asset !== 'CAD');
}

/**
 * FX reaction wraps ("Pound buckles as…", "AUD weakens as US strikes…") are currency stories.
 * Drop OIL so Market Catalyst does not stack every wrap onto OIL (doc §21 primary asset).
 */
export function stripOilFromFxReactionWrap(headline: string, assets: ClassifiedAsset[]): ClassifiedAsset[] {
    const fxSubject =
        /\b(british pound|pound sterling|\bgbp\b|euro|\beur\b|australian dollar|\baud\b|kiwi|\bnzd\b|new zealand dollar|yen|\bjpy\b|swiss franc|\bchf\b|loonie|\bcad\b|canadian dollar|u\.?s\.?\s*dollar|\busd\b|indian rupee|\binr\b)\b/i.test(
            headline,
        );
    const reaction =
        /\b(buckles?|weakens?|drifts?|falls?|slides?|drops?|rises?|gains?|jumps?|pressured|softens?|climbs?)\b/i.test(
            headline,
        );
    if (!fxSubject || !reaction) return assets;
    return assets.filter((a) => a.asset !== 'OIL');
}

/** Vague "will speak / funeral" headlines with no policy content should not force safe-haven tags. */
export function isVagueSpeechHeadline(headline: string): boolean {
    if (!/\b(funeral|deliver message|to speak|will speak|to deliver)\b/i.test(headline)) return false;
    return !/\b(rate|policy|nuclear|sanction|war|attack|oil|hormuz|interest|hawkish|dovish|ceasefire)\b/i.test(
        headline,
    );
}

/** True when summary is a truncated topic label or generic template rather than a score reason (doc §34). */
export function isWeakSummary(summary: string, headline: string): boolean {
    const s = summary.replace(/\s+/g, ' ').trim();
    if (s.length < 10) return true;

    // Generic templates we used to emit — replace with headline-aware reasons.
    if (/^(strong|mild)\s+(bullish|bearish)\s+driver for\s+\w+$/i.test(s)) return true;
    if (/^unclear (geopolitics|direction) for\s+\w+$/i.test(s)) return true;
    if (/^no tracked-asset impact$/i.test(s)) return true;

    const sNorm = s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const hNorm = headline.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!sNorm) return true;
    if (hNorm.includes(sNorm) && sNorm.split(' ').length <= 6) return true;

    const hasReasonVerb =
        /\b(raises?|weighs?|supports?|pressures?|eases?|boosts?|cuts?|signals?|confirms?|threatens?|reduces?|escalat|de-?escalat|hawkish|dovish|risk|premium|supply|demand|safe[- ]haven|settle|weakness|strength|sanctions?|ceasefire|talks?|negotiat)/i.test(
            s,
        );
    if (!hasReasonVerb && sNorm.split(' ').length <= 5) return true;
    return false;
}

/**
 * Logical short explanation from the headline + direction (doc §34 "short explanation").
 * Prefer mechanism language over "Mild bullish driver for X".
 */
export function buildReasonSummary(
    headline: string,
    impact: NewsImpact,
    assets: ClassifiedAsset[],
    category: NewsCategory,
): string {
    if (category === 'IRRELEVANT' || assets.length === 0) return 'No tracked-asset impact';

    const primary = [...assets].sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0]!;
    const asset = primary.asset;
    const h = headline.toLowerCase();
    const bullish = primary.score > 0;
    const bearish = primary.score < 0;
    const neutral = primary.score === 0;

    // --- Topic fingerprints (most specific first) ---
    if (/\b(brent|wti|crude).{0,40}\b(down|fell|drop|settle|settles|lower)\b/i.test(headline) || /\bdown\b.{0,20}\b(brent|wti|crude)/i.test(headline)) {
        return bearish || neutral ? `${asset === 'CAD' ? 'Oil weakness weighs on CAD' : 'Brent settle confirms oil weakness'}` : `Oil price move supports ${asset}`;
    }
    if (/\b(brent|wti|crude).{0,40}\b(up|rise|rises|gain|higher)\b/i.test(headline)) {
        return bullish || neutral ? `Crude strength supports ${asset}` : `Crude move weighs on ${asset}`;
    }
    if (/\b(aircraft\s+carriers?|missile range|military options|nuclear sites)\b/i.test(headline)) {
        if (asset === 'GOLD') return bullish || neutral ? 'Escalation supports safe-haven gold' : 'Relief weighs on gold';
        if (asset === 'USD' || asset === 'JPY' || asset === 'CHF') {
            return bullish || neutral ? `Risk-off supports ${asset}` : `Risk tone weighs on ${asset}`;
        }
        if (asset === 'OIL' || asset === 'CAD') {
            return bullish || neutral ? 'Escalation raises oil risk' : 'De-escalation eases oil risk';
        }
        return bullish || neutral ? `Escalation supports ${asset}` : `De-escalation weighs on ${asset}`;
    }
    if (/\bnuclear\b/i.test(h) && /\biran/i.test(h)) {
        if (asset === 'GOLD') return bullish || neutral ? 'Nuclear risk supports gold' : 'Nuclear relief weighs on gold';
        if (asset === 'OIL' || asset === 'CAD') {
            return bullish || neutral ? 'Nuclear tensions raise oil risk' : 'Nuclear talks ease oil risk';
        }
        return bullish || neutral ? `Nuclear tensions support ${asset}` : `Nuclear talks ease ${asset} risk`;
    }
    if (/\b(hormuz|shipping|ships|strait)\b/i.test(h) && /\b(halt|fire|demand|open|route)/i.test(h)) {
        if (asset === 'OIL' || asset === 'CAD') {
            return bullish || neutral ? 'Hormuz risk raises oil premium' : 'Shipping reassurance eases oil risk';
        }
        return bullish || neutral ? `Hormuz risk supports ${asset}` : `Shipping reassurance weighs on ${asset}`;
    }
    if (/\b(ceasefire|restraint|mediat|diplomacy|dialogue)\b/i.test(h)) {
        if (asset === 'GOLD') return bearish || neutral ? 'Ceasefire efforts weigh on gold' : 'Conflict risk still supports gold';
        if (asset === 'OIL' || asset === 'CAD') {
            return bearish || neutral ? 'Ceasefire efforts ease oil premium' : 'Conflict risk still supports oil';
        }
        return bearish || neutral ? `Ceasefire efforts ease ${asset} risk` : `Conflict risk still supports ${asset}`;
    }
    if (/\b(unfounded|denied|denies|not request)\b/i.test(h) && /\b(talks?|negotiat)/i.test(h)) {
        return 'Talks denied — direction unclear';
    }
    if (/\b(talks?|negotiat|visit|delegation)\b/i.test(h) && /\b(iran|oman|hormuz|qatar|pakistan)\b/i.test(h)) {
        return neutral || bearish ? 'Diplomatic talks may ease tension' : 'Talks fail to remove risk premium';
    }
    if (/\b(russia|russian).{0,50}(energy|oil|sanction)/i.test(h) || /\brussia energy buyers\b/i.test(h)) {
        if (asset === 'OIL' || asset === 'CAD') return 'Energy sanctions support oil';
        return bullish ? `Russia sanctions support ${asset}` : `Russia sanctions weigh on ${asset}`;
    }
    if (/\bsanction/i.test(h) && /\b(russia|iran)/i.test(h)) {
        if (asset === 'OIL' || asset === 'CAD') {
            return bullish ? 'Sanctions support oil risk premium' : 'Sanctions relief weighs on oil';
        }
        return bullish ? `Sanctions support ${asset}` : `Sanctions weigh on ${asset}`;
    }
    if (/\bsenators?\b/i.test(h) && /\bsanction/i.test(h)) {
        return bullish ? `Sanctions bill supports ${asset}` : `Sanctions bill weighs on ${asset}`;
    }
    if (/\b(defence|defense|all-out|ready for)\b/i.test(h) && /\biran/i.test(h)) {
        return 'Hardline stance keeps oil risk bid';
    }
    if (/\btrump\b/i.test(h) && /\b(deal|agreement)\b/i.test(h)) {
        return bullish ? `Trump deal tone supports ${asset}` : `Deal uncertainty weighs on ${asset}`;
    }
    if (/\bopec\b/i.test(h)) {
        return bullish ? 'OPEC supply stance lifts oil' : 'OPEC supply outlook weighs on oil';
    }
    if (/\b(hawkish|hike|higher for longer)\b/i.test(h)) {
        return `Hawkish policy supports ${asset}`;
    }
    if (/\b(dovish|rate cut|easing)\b/i.test(h)) {
        return `Dovish policy weighs on ${asset}`;
    }
    if (/\brisk[- ]?off\b|\bsafe[- ]?haven\b/i.test(h)) {
        return bullish ? `Risk-off supports ${asset}` : `Risk-off weighs on ${asset}`;
    }
    if (/\brisk[- ]?on\b/i.test(h)) {
        return bullish ? `Risk-on supports ${asset}` : `Risk-on weighs on ${asset}`;
    }

    // Neutral CB / fixing headlines — explain *why* bias is flat (not "unclear").
    if (neutral) {
        if (/\b(inflation|cpi|price).{0,40}(return|back|toward|to)\b.{0,20}(2%|target|medium term)/i.test(h) ||
            /\binflation expectations?.{0,20}(anchored|firm)/i.test(h)) {
            return `Inflation on-target keeps ${asset} bias neutral`;
        }
        if (/\b(midpoint|fixing|reference rate)\b/i.test(h) && /\b(pboc|yuan|cny)\b/i.test(h)) {
            return `Yuan fixing estimate leaves ${asset} bias neutral`;
        }
        if (/\b(rbnz|boe|ecb|fed|fomc|boc|rba|boj|pboc|conway|powell|waller|lagarde|bailey|ueda)\b/i.test(h)) {
            if (/\b(not discussing|no vote|consensus|firmly anchored|medium term)\b/i.test(h)) {
                return `Status-quo policy tone keeps ${asset} bias neutral`;
            }
            return `Policy comment keeps ${asset} bias neutral`;
        }
        if (category === 'GEOPOLITICAL') return `Geopolitics leave ${asset} direction mixed`;
        return `No clear directional signal for ${asset}`;
    }
    if (asset === 'OIL' || asset === 'GOLD') {
        return bullish ? 'Escalation supports risk premium' : 'Relief pressure weighs on risk premium';
    }
    if (impact === 'High') {
        return bullish ? `Strong catalyst supports ${asset}` : `Strong catalyst weighs on ${asset}`;
    }
    return bullish ? `Positive catalyst supports ${asset}` : `Negative catalyst weighs on ${asset}`;
}

/** True when summary talks about oil/crude but the primary display asset is not OIL. */
function summaryMismatchesPrimaryAsset(summary: string, primaryAsset: TrackedAsset): boolean {
    const oilCentric = /\boil\b|\bbrent\b|\bwti\b|\bcrude\b/i.test(summary);
    if (!oilCentric) return false;
    if (primaryAsset === 'OIL') return false;
    if (primaryAsset === 'CAD' && /\bCAD\b/i.test(summary)) return false;
    return true;
}

export function ensureReasonSummary(
    summary: string,
    headline: string,
    impact: NewsImpact,
    assets: ClassifiedAsset[],
    category: NewsCategory,
): string {
    const cleaned = summary.replace(/\s+/g, ' ').trim().slice(0, 120);
    const primary = [...assets].sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0];
    if (
        cleaned &&
        !isWeakSummary(cleaned, headline) &&
        (!primary || !summaryMismatchesPrimaryAsset(cleaned, primary.asset))
    ) {
        return cleaned;
    }
    return buildReasonSummary(headline, impact, assets, category);
}

/** Scheduled print with actual/forecast figures — true ECONOMIC calendar row (doc §4 A). */
function isScheduledDataReleaseHeadline(headline: string): boolean {
    const h = headline.toLowerCase();
    // Explicit Actual/Forecast release phrasing (FinancialJuice data alerts).
    if (/\bactual\b/.test(h) && /\b(forecast|previous)\b/.test(h)) return true;
    // China / customs trade surplus & shipment prints → calendar ECONOMIC, not FX wraps.
    if (/\bchina\b/.test(h) && /\b(trade surplus|trade balance|exports|imports|customs)\b/.test(h)) return true;
    // Classic named prints with a number, excluding FX market wraps / fixings.
    if (
        /\b(gdp|cpi|ppi|nfp|nonfarm|payrolls|pmi|retail sales|unemployment rate|jobless claims|interest rate decision|business confidence|business conditions|consumer confidence|capacity utilization|wholesale price)\b/.test(
            h,
        ) &&
        /\d/.test(h) &&
        !/\b(forex today|price forecast|consolidat|rallies|weakens|gains on|posts modest|surges as|slides as|reference rate|pboc sets)\b/.test(
            h,
        )
    ) {
        return true;
    }
    return false;
}

/**
 * FX market commentary / pair wraps that appear on FinancialJuice Forex tab (FXStreet).
 * These are Market Drivers (doc §4 B), not Currency Health economic releases.
 */
function isFxMarketCommentaryHeadline(headline: string): boolean {
    const h = headline.toLowerCase();
    if (/\bforex today\b/.test(h)) return true;
    if (/\b(eur\/usd|gbp\/usd|usd\/jpy|aud\/usd|nzd\/usd|usd\/cad|usd\/cny|eur\/jpy|gbp\/jpy|xau\/usd)\b/.test(h)) return true;
    if (
        /\b(euro|yen|yuan|pound|sterling|loonie|kiwi|aussie|us dollar|canadian dollar|new zealand dollar|australian dollar|british pound|chinese yuan|gold|xau)\b/.test(
            h,
        ) &&
        /\b(gains|falls|fell|rallies|rally|weakens|weaken|consolidat|surges|slides|buckles|posts|holds near|awaits?|look to|sharper drop|reference rate|climbs|rose|falls to|rises|bounces|tumbles|recovers)\b/.test(
            h,
        )
    ) {
        return true;
    }
    if (/\b(wti|brent)\b/.test(h) && /\b(spike|spikes|surge|tumble|jump|fall|gain|oil)\b/.test(h)) return true;
    if (/\b(rbnz|boc|boe|ecb|fed|pboc|boj|rba)\b/.test(h) && /\b(dollar|yen|euro|pound|aussie|kiwi|loonie|yuan|cny)\b/.test(h)) {
        return true;
    }
    // Spot FX print: "New Zealand dollar climbs 0.51% to 0.5775"
    if (
        /\b(us dollar|euro|yen|pound|aussie|kiwi|loonie|canadian dollar|australian dollar|new zealand dollar)\b/.test(h) &&
        /\b(climbs|falls|rises|drops)\b/.test(h) &&
        /\d/.test(h)
    ) {
        return true;
    }
    return false;
}

/** Doc §4 B / §21 — CB speeches & guidance are Market Drivers (not ECONOMIC prints). */
function isCentralBankSpeechHeadline(headline: string): boolean {
    const h = headline.toLowerCase();
    const bank =
        /\b(rbnz|boe|ecb|fed|fomc|boc|rba|boj|pboc|snb)\b/.test(h) ||
        /\breserve bank of (nz|new zealand|australia|canada)\b/.test(h) ||
        /\b(bank of england|bank of japan|european central bank|federal reserve|people'?s bank of china)\b/.test(h);
    // Universal: bank + speech/guidance markers (any official). Person names are optional boosters only.
    const speechCue =
        /\b(says|said|signals?|express(?:es|ed)?|policymakers?|speech|guidance|minutes|chief economist|governor|president)\b/.test(h) ||
        /\b(midpoint|fixing|reference rate)\b/.test(h);
    return bank && speechCue && !isScheduledDataReleaseHeadline(headline);
}

function centralBankToAsset(headline: string): TrackedAsset | null {
    const h = headline.toLowerCase();
    if (/\b(rbnz|reserve bank of (nz|new zealand))\b/.test(h)) return 'NZD';
    if (/\b(rba|reserve bank of australia)\b/.test(h)) return 'AUD';
    if (/\b(boc|reserve bank of canada)\b/.test(h)) return 'CAD';
    if (/\b(boe|bank of england)\b/.test(h)) return 'GBP';
    if (/\b(ecb|european central bank)\b/.test(h)) return 'EUR';
    if (/\b(boj|bank of japan)\b/.test(h)) return 'JPY';
    if (/\b(fed|fomc|federal reserve)\b/.test(h)) return 'USD';
    // CNY/CNH is outside the eight-currency Catalyst table. PBoC policy must never be relabelled
    // as a USD catalyst; broader confirmed China/metals drivers are handled by the AUD/NZD rules.
    if (/\b(pboc|people'?s bank of china)\b/.test(h)) return null;
    if (/\bsnb\b/.test(h)) return 'CHF';
    return null;
}

/** Doc §4 C — war/strikes/Hormuz/Iran military = Geopolitical. */
function isGeopoliticalConflictHeadline(headline: string): boolean {
    const h = headline.toLowerCase();
    const conflict =
        /\b(centcom|irgc|revolutionary guards|missile|missiles|ballistic|strike|strikes|hormuz|ceasefire|truce|patriot|airspace|tanker|tankers|blockade|sirens?)\b/.test(
            h,
        ) || /\biran/.test(h);
    const actor =
        /\b(us|u\.s\.|u\.s|trump|military|israel|jordan|bahrain|fleet|navy|war|troops|uae|iran|fars news)/.test(h);
    return conflict && actor;
}

/** Doc §1 — crypto / non-tracked metals / Asia exotics alone are never board drivers. */
function isDocIgnoredHeadline(headline: string): boolean {
    const h = headline.toLowerCase();
    if (/\b(bitcoin|ethereum|xrp|crypto|btc|eth|solana|dogecoin)\b/.test(h)) return true;
    if (/\b(silver|xag)\b/.test(h) && !/\b(gold|xau)\b/.test(h)) return true;
    if (
        /\b(sgd|myr|twd|taiwan|singapore dollar|ringgit|malaysian)\b/.test(h) &&
        !/\b(usd|eur|gbp|jpy|aud|nzd|cad|cny|oil|gold|xau|fed|ecb)\b/.test(h)
    ) {
        return true;
    }
    if (/\bindia gold price today\b/.test(h)) return true;
    return false;
}

/**
 * Universal: Japan MoF / GPIF / pension portfolio comments that can move JPY flows.
 * Status-quo "no change/no comment" stays insignificant (Low).
 */
function isJapanPortfolioPolicyHeadline(headline: string): boolean {
    const h = headline.toLowerCase();
    if (!/\b(japan|japanese)\b/.test(h) && !/\bgpif\b/.test(h)) return false;
    if (!/\b(finance minister|finmin|fin min|gpif|pension)\b/.test(h)) return false;
    if (/\b(no change|no comment|follow rules set)\b/.test(h)) return false;
    return /\b(portfolio|asset (management|allocation|appeal)|foreign invest|boosting appeal)\b/.test(h);
}

function trackedAssetHintsFromHeadline(headline: string): TrackedAsset[] {
    const h = headline.toLowerCase();
    const out: TrackedAsset[] = [];
    const add = (a: TrackedAsset) => {
        if (!out.includes(a)) out.push(a);
    };
    if (/\b(us dollar|u\.s\. dollar|\busd\b|dollar index|\bdxy\b|fed\b|fomc)\b/.test(h)) add('USD');
    if (/\b(euro|eur\/usd|eur\/jpy|\beur\b|ecb)\b/.test(h)) add('EUR');
    if (/\b(yen|usd\/jpy|eur\/jpy|gbp\/jpy|\bjpy\b|boj)\b/.test(h)) add('JPY');
    if (/\b(pound|sterling|gbp\/usd|gbp\/jpy|\bgbp\b|boe)\b/.test(h)) add('GBP');
    if (/\b(canadian dollar|loonie|usd\/cad|\bcad\b|boc)\b/.test(h)) add('CAD');
    if (/\b(australian dollar|aussie|aud\/usd|\baud\b|rba|reserve bank of australia)\b/.test(h)) add('AUD');
    if (/\b(new zealand dollar|kiwi|nzd\/usd|\bnzd\b|rbnz|reserve bank of (nz|new zealand))\b/.test(h)) add('NZD');
    if (/\b(swiss|\bchf\b|snb)\b/.test(h)) add('CHF');
    if (/\b(gold|xau)\b/.test(h)) add('GOLD');
    if (/\b(wti|brent|crude|\boil\b|opec|hormuz)\b/.test(h) && !/\bheating oil|natural gas|gasoline\b/.test(h)) {
        add('OIL');
    }
    // USD/CNY pair movements or PBOC rate-fixing (not generic yuan speculation). Do NOT add USD
    // for PBoC policy statements or Chinese yuan forecasts that don't explicitly discuss the dollar.
    if (/\b(usd\/cny|yuan.*vs.*dollar|dollar.*vs.*yuan|cny.*vs.*dollar|fixing|reference rate)\b/.test(h) && /\b(pboc|yuan|cny)\b/.test(h)) {
        add('USD');
    }
    return out;
}

function biasFromMoveLanguage(headline: string): AssetBias {
    if (/\b(gains|rallies|surges|spikes|lifts|supports|climbs|rises|strengthens|advances)\b/i.test(headline)) {
        return 'Bullish';
    }
    if (/\b(weakens|slides|falls|tumbles|buckles|weighs|drop|declines|tumbles)\b/i.test(headline)) {
        return 'Bearish';
    }
    return 'Neutral';
}

function ensureAsset(
    assets: ClassifiedAsset[],
    asset: TrackedAsset,
    impact: NewsImpact,
    bias: AssetBias,
): ClassifiedAsset[] {
    if (assets.some((a) => a.asset === asset)) return assets;
    const aligned = alignScoreToImpact(impact, bias, bias === 'Neutral' ? 0 : impact === 'High' ? 1 : 0.5);
    return [...assets, { asset, bias: aligned.bias, score: aligned.score }].slice(0, 3);
}

/** Board visibility rule used by News Headline / Catalyst (doc §22/§34). */
export function isBoardVisibleClassification(input: {
    category: string;
    impact: string;
    assets: ClassifiedAsset[];
    duplicateOf?: string | null;
}): boolean {
    if (input.duplicateOf) return false;
    if (!['DRIVER', 'GEOPOLITICAL'].includes(String(input.category).toUpperCase())) return false;
    return Array.isArray(input.assets) && input.assets.some(
        (asset) => CATALYST_CURRENCIES.includes(asset.asset as CatalystCurrency) && asset.score !== 0,
    );
}

/**
 * Post-LLM sanitizer — UNIVERSAL doc rules only.
 * Recovers Groq drift so FJ/FXS headlines that belong on the board are not lost to
 * ECONOMIC / IRRELEVANT / Low mislabels. Do not add person- or event-specific one-offs here.
 */
export function sanitizeClassification(
    headline: string,
    input: {
        category: NewsCategory;
        impact: NewsImpact;
        assets: ClassifiedAsset[];
        summary: string;
    },
): Omit<ClassifiedHeadline, 'index' | 'duplicateOfExistingId' | 'duplicateOfBatchIndex'> {
    let { category, impact, assets, summary } = input;

    if (isDocIgnoredHeadline(headline) || isNonCrudeEnergyHeadline(headline) || isCatalystExcludedHeadline(headline)) {
        return {
            category: 'IRRELEVANT',
            impact: 'Low',
            assets: [],
            summary: isDocIgnoredHeadline(headline) ? 'Outside tracked-asset universe' : 'Not a valid Catalyst Driver',
        };
    }

    if (isVagueSpeechHeadline(headline)) {
        return {
            category: 'IRRELEVANT',
            impact: 'Low',
            assets: [],
            summary: 'No tracked-asset impact',
        };
    }

    // Drop OIL tags with no crude / ME-energy basis (stops N Korea→OIL, local fire→OIL, etc.).
    if (assets.some((a) => a.asset === 'OIL') && !headlineSupportsOil(headline)) {
        assets = assets.filter((a) => a.asset !== 'OIL');
    }

    // Oil/Iran energy stories must not also credit USD/JPY/CHF unless the headline is a real USD driver.
    assets = stripWeakSafeHavenTags(headline, assets);

    // Denied / unfounded talks with no outcome → Neutral (do not force de-escalation).
    if (/\b(unfounded|denied|denies|no talks|not request(ed)? negotiations)\b/i.test(headline) && /\b(talks?|negotiat)/i.test(headline)) {
        assets = assets.map((a) => ({ ...a, bias: 'Neutral' as AssetBias, score: 0 }));
    }
    if (
        /\b(russia|russian).{0,60}(energy|oil).{0,40}(sanction|accountable|buyer)/i.test(headline) ||
        /\b(sanction|accountable).{0,40}(russia|russian).{0,40}(energy|oil)/i.test(headline) ||
        /\brussia energy buyers\b/i.test(headline)
    ) {
        const oilImpact: NewsImpact = impact === 'Low' ? 'Medium' : impact;
        if (impact === 'Low') impact = 'Medium';
        if (category === 'IRRELEVANT') category = 'DRIVER';
        assets = assets.filter((a) => a.asset !== 'OIL');
        const aligned = alignScoreToImpact(oilImpact, 'Bullish', 0.5);
        assets.push({ asset: 'OIL', bias: aligned.bias, score: aligned.score });
    }

    // Universal §4 B: CB speech / fixing / guidance → DRIVER ≥ Medium.
    if (isCentralBankSpeechHeadline(headline)) {
        if (category === 'ECONOMIC' || category === 'IRRELEVANT') category = 'DRIVER';
        if (impact === 'Low') impact = 'Medium';
        const hints = trackedAssetHintsFromHeadline(headline);
        if (assets.length === 0 && hints.length > 0) {
            const aligned = alignScoreToImpact(impact, 'Neutral', 0);
            assets = hints.slice(0, 2).map((asset) => ({ asset, bias: aligned.bias, score: aligned.score }));
        }
        if (assets.length === 0) {
            const bankAsset = centralBankToAsset(headline);
            if (bankAsset) {
                const aligned = alignScoreToImpact(impact, 'Neutral', 0);
                assets = [{ asset: bankAsset, bias: aligned.bias, score: aligned.score }];
            }
        }
    }

    // Universal §4 C: conflict / Hormuz / military → GEOPOLITICAL with OIL.
    if (isGeopoliticalConflictHeadline(headline) && !isScheduledDataReleaseHeadline(headline)) {
        if (category === 'IRRELEVANT' || category === 'ECONOMIC') category = 'GEOPOLITICAL';
        else if (
            category === 'DRIVER' &&
            /\b(centcom|irgc|missile|strike|hormuz|tanker|airspace|patriot|blockade|troops)\b/i.test(headline)
        ) {
            category = 'GEOPOLITICAL';
        }
        if (impact === 'Low') {
            impact = /\b(strike|centcom|missile|tanker|hormuz|blockade)\b/i.test(headline) ? 'High' : 'Medium';
        }
        if (assets.length === 0 || (category === 'GEOPOLITICAL' && !assets.some((a) => a.asset === 'OIL'))) {
            const aligned = alignScoreToImpact(impact, 'Bullish', impact === 'High' ? 1 : 0.5);
            assets = [...assets.filter((a) => a.asset !== 'OIL'), { asset: 'OIL', bias: aligned.bias, score: aligned.score }];
            if (/\b(trump|dollar|fed)\b/i.test(headline)) {
                assets = ensureAsset(assets, 'USD', impact === 'High' ? 'Medium' : impact, 'Bullish');
            }
            assets = assets.slice(0, 3);
        }
    }

    // After geo can force OIL: currency reaction wraps stay on the FX subject (doc §21).
    assets = stripOilFromFxReactionWrap(headline, assets);

    // Oil→CAD mirror runs AFTER FX-wrap OIL strip so "AUD weakens on Iran strikes" does not
    // leave a leftover CAD tag once OIL was correctly removed from the wrap.
    assets = stripImpliedCadFromOil(headline, assets);

    // Universal: Japan MoF / GPIF portfolio policy → DRIVER JPY.
    if (isJapanPortfolioPolicyHeadline(headline)) {
        if (category === 'IRRELEVANT' || category === 'ECONOMIC') category = 'DRIVER';
        if (impact === 'Low') impact = 'Medium';
        const bias = /\b(boost|appeal|rise|attract)\b/i.test(headline) ? ('Bullish' as AssetBias) : ('Neutral' as AssetBias);
        assets = ensureAsset(assets, 'JPY', impact, bias);
    }

    assets = assets.map((a) => {
        const aligned = alignScoreToImpact(impact, a.bias, a.score);
        return { asset: a.asset, bias: aligned.bias, score: aligned.score };
    });

    // FFE Catalyst Driver Scoring Rules are the final authority. They replace broad
    // FX-wrap/OIL tagging with one event-level, eight-currency score set.
    assets = applyFfeCatalystRules(headline, assets);
    if (assets.length === 0) {
        return {
            category: 'IRRELEVANT',
            impact: 'Low',
            assets: [],
            summary: 'No clear, market-moving Catalyst Driver',
        };
    }
    category = isConfirmedGeoOrRiskOff(headline) || hasClearDeEscalation(headline) ? 'GEOPOLITICAL' : 'DRIVER';
    impact = catalystImpactForScore(Math.max(...assets.map((asset) => Math.abs(asset.score))));

    summary = ensureReasonSummary(summary, headline, impact, assets, category);

    return { category, impact, assets, summary };
}

function coerceResult(
    raw: unknown,
    index: number,
    headline: string,
): Omit<ClassifiedHeadline, 'duplicateOfExistingId' | 'duplicateOfBatchIndex'> | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;

    const category = String(r.category ?? '').toUpperCase() as NewsCategory;
    if (!['ECONOMIC', 'DRIVER', 'GEOPOLITICAL', 'IRRELEVANT'].includes(category)) return null;

    const impactRaw = String(r.impact ?? 'Low').toLowerCase();
    const impact: NewsImpact = impactRaw.startsWith('high') ? 'High' : impactRaw.startsWith('med') ? 'Medium' : 'Low';

    const assetsIn = Array.isArray(r.assets) ? r.assets : [];
    const assets: ClassifiedAsset[] = [];
    for (const a of assetsIn) {
        if (!a || typeof a !== 'object') continue;
        const o = a as Record<string, unknown>;
        const asset = String(o.asset ?? '').toUpperCase().replace('OIL (WTI)', 'OIL').replace('WTI', 'OIL');
        if (!TRACKED_ASSETS.includes(asset as TrackedAsset)) continue;

        const biasRaw = String(o.bias ?? 'Neutral');
        const biasGuess: AssetBias = /bull/i.test(biasRaw)
            ? 'Bullish'
            : /bear/i.test(biasRaw)
                ? 'Bearish'
                : /mix/i.test(biasRaw)
                    ? 'Mixed'
                    : 'Neutral';

        let rawScore = Number(o.score);
        if (!Number.isFinite(rawScore)) rawScore = 0;
        rawScore = Math.max(-1, Math.min(1, rawScore));
        rawScore = Math.round(rawScore * 4) / 4;

        const aligned = alignScoreToImpact(impact, biasGuess, rawScore);
        assets.push({ asset: asset as TrackedAsset, bias: aligned.bias, score: aligned.score });
    }

    const sanitized = sanitizeClassification(headline, {
        category,
        impact,
        assets,
        summary: String(r.summary ?? ''),
    });

    return {
        index,
        category: sanitized.category,
        impact: sanitized.impact,
        assets: sanitized.assets,
        summary: sanitized.summary,
    };
}

/**
 * Batch-classify headlines in one bounded provider call, including deduplication against `existingTopics`
 * and against each other within the batch. Returns [] on failure so the caller can skip this cycle.
 * Prefer HeadlineInput with publishedAt so [HH:MM] reaches the model for same-briefing judgment.
 */
export async function classifyHeadlines(
    headlines: Array<string | HeadlineInput>,
    existingTopics: ExistingTopic[] = [],
    options: { operationType?: AiOperationType; jobId?: string | null; ingestId?: string | null } = {},
): Promise<ClassifiedHeadline[]> {
    if (headlines.length === 0) return [];

    const normalized = headlines.map(normalizeHeadlineInput);
    const headlineTexts = normalized.map((h) => h.text);

    const existingBlock = existingTopics.length
        ? '\n\nEXISTING topics already stored today (id: [HH:MM] text — Asia/Dubai when known):\n' +
          existingTopics.map((t) => formatPromptHeadlineLine(t.id, { text: t.text, publishedAt: t.publishedAt })).join('\n')
        : '\n\nEXISTING topics already stored today: (none yet)';

    const userContent =
        'Classify these headlines (indices are for THIS batch; times are Asia/Dubai HH:MM when known):\n' +
        normalized.map((h, i) => formatPromptHeadlineLine(i, h)).join('\n') +
        existingBlock;

    let validationFailure: string | null = null;
    const response = await requestJson(SYSTEM_PROMPT, userContent, {
        operationType: options.operationType ?? 'classification',
        jobId: options.jobId,
        ingestId: options.ingestId,
        schema: classificationResponseSchema(headlineTexts.length),
        schemaName: 'market_driver_classification',
        maxOutputTokens: ENV.AI_MAX_OUTPUT_TOKENS,
        // A complete result per input is required. A malformed/partial primary response is sent
        // to the bounded Groq fallback rather than being silently persisted as partial data.
        validate: (value) => {
            validationFailure = completeClassificationResponseError(value, headlineTexts.length);
            return validationFailure === null;
        },
    });
    if (!response) {
        // A valid-but-incomplete model response is not a provider quota failure. Split only this
        // failed request into smaller, independent prompts. The same durable job remains claimed,
        // so no second worker can process the headlines concurrently and no partial DB rows exist.
        if (validationFailure && normalized.length > 1) {
            const splitAt = Math.ceil(normalized.length / 2);
            logger.warn('[AIProvider] Incomplete classification response; retrying the durable job in smaller batches', {
                headlineCount: normalized.length,
                splitAt,
                reason: validationFailure,
            });
            const left = await classifyHeadlines(normalized.slice(0, splitAt), existingTopics, options);
            if (left.length !== splitAt) return [];
            const right = await classifyHeadlines(normalized.slice(splitAt), existingTopics, options);
            if (right.length !== normalized.length - splitAt) return [];
            return [
                ...left,
                ...right.map((item) => ({
                    ...item,
                    index: item.index + splitAt,
                    duplicateOfBatchIndex: item.duplicateOfBatchIndex == null
                        ? null
                        : item.duplicateOfBatchIndex + splitAt,
                })),
            ].sort((a, b) => a.index - b.index);
        }
        return [];
    }

    const parsed = response.parsed as {
        results?: unknown[];
        duplicateGroups?: unknown[];
        existingDuplicates?: unknown[];
    };
    const existingIds = new Set(existingTopics.map((t) => t.id));

    const baseByIndex = new Map<
        number,
        Omit<ClassifiedHeadline, 'duplicateOfExistingId' | 'duplicateOfBatchIndex'>
    >();
    for (const raw of Array.isArray(parsed.results) ? parsed.results : []) {
        const idx = Number((raw as Record<string, unknown>)?.i);
        if (!Number.isInteger(idx) || idx < 0 || idx >= headlineTexts.length) continue;
        const coerced = coerceResult(raw, idx, headlineTexts[idx]!);
        if (coerced) baseByIndex.set(idx, coerced);
    }

    const batchDuplicateOf = new Map<number, number>();
    for (const groupRaw of Array.isArray(parsed.duplicateGroups) ? parsed.duplicateGroups : []) {
        if (!Array.isArray(groupRaw) || groupRaw.length < 2) continue;
        const group = groupRaw
            .map((v) => Number(v))
            .filter((v) => Number.isInteger(v) && v >= 0 && v < headlineTexts.length);
        if (group.length < 2) continue;
        const principal = group[0]!;
        for (const idx of group.slice(1)) {
            if (idx !== principal && !batchDuplicateOf.has(idx)) batchDuplicateOf.set(idx, principal);
        }
    }

    const existingDuplicateOf = new Map<number, string>();
    for (const raw of Array.isArray(parsed.existingDuplicates) ? parsed.existingDuplicates : []) {
        if (!raw || typeof raw !== 'object') continue;
        const o = raw as Record<string, unknown>;
        const idx = Number(o.i);
        const existingId = String(o.existingId ?? '');
        if (!Number.isInteger(idx) || idx < 0 || idx >= headlineTexts.length) continue;
        if (!existingIds.has(existingId)) continue;
        existingDuplicateOf.set(idx, existingId);
    }

    const out: ClassifiedHeadline[] = [];
    for (const [index, base] of baseByIndex) {
        out.push({
            ...base,
            duplicateOfExistingId: existingDuplicateOf.get(index) ?? null,
            duplicateOfBatchIndex: existingDuplicateOf.has(index)
                ? null
                : (batchDuplicateOf.get(index) ?? null),
        });
    }

    return out.sort((a, b) => a.index - b.index);
}
