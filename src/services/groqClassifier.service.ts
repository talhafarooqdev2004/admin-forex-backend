import OpenAI from 'openai';
import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';
import { recordAiUsage, type AiOperationType, type ProviderUsage } from './aiUsage.service.js';
import {
    deriveFfeDecision,
    FFE_TRACKED_ASSETS,
    inferCausalTheme,
    inferGeoState,
    isEconomicReleaseHeadline,
    type FfeAssetSignal,
    type GeoState,
    type SemanticDirection,
    type SemanticStrength,
} from './ffeDecisionEngine.service.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = Math.max(5_000, ENV.AI_REQUEST_TIMEOUT_MS);
const OPENAI_CLIENT = ENV.OPENAI_API_KEY
    ? new OpenAI({ apiKey: ENV.OPENAI_API_KEY, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 })
    : null;

function openAiClientForTimeout(timeoutMs: number): OpenAI {
    if (!ENV.OPENAI_API_KEY) throw new Error('OpenAI API key is not configured');
    if (timeoutMs <= REQUEST_TIMEOUT_MS) return OPENAI_CLIENT!;
    return new OpenAI({ apiKey: ENV.OPENAI_API_KEY, timeout: timeoutMs, maxRetries: 0 });
}

async function waitForOpenAiResponse(
    client: OpenAI,
    initial: Record<string, unknown>,
    deadlineMs: number,
    startedAt: number,
): Promise<Record<string, unknown>> {
    let current = initial;
    const responseId = typeof current.id === 'string' ? current.id : null;
    if (!responseId) return current;

    const pollIntervalMs = 5_000;
    while (Date.now() - startedAt < deadlineMs) {
        const status = typeof current.status === 'string' ? current.status : '';
        if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'incomplete') {
            return current;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        current = await client.responses.retrieve(responseId) as unknown as Record<string, unknown>;
    }
    throw new Error(`OpenAI background response ${responseId} exceeded ${deadlineMs}ms deadline`);
}

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
export const TRACKED_ASSETS = FFE_TRACKED_ASSETS;
export type TrackedAsset = (typeof TRACKED_ASSETS)[number];
/** The validated FFE Catalyst contract tracks eight currencies plus GOLD and OIL. */
export const CATALYST_CURRENCIES = FFE_TRACKED_ASSETS;
export type CatalystCurrency = (typeof CATALYST_CURRENCIES)[number];

export type NewsCategory = 'ECONOMIC' | 'DRIVER' | 'GEOPOLITICAL' | 'IRRELEVANT';
export type NewsImpact = 'High' | 'Medium' | 'Low';
export type AssetBias = 'Bullish' | 'Bearish' | 'Neutral' | 'Mixed';
/** Contract relationship between a headline and its canonical causal event. */
export const FFE_EVENT_RELATIONS = [
    'NEW_EVENT', 'SAME_EVENT', 'EVENT_UPDATE', 'STRENGTHENING_EVIDENCE',
    'WEAKENING_EVIDENCE', 'REVERSAL', 'DE_ESCALATION', 'CONFIRMATION',
    'PRICE_REACTION', 'HISTORICAL_COMMENTARY', 'MACRO_RELEASE', 'FORECAST_UPCOMING',
    'IRRELEVANT',
] as const;
export type FfeEventRelation = (typeof FFE_EVENT_RELATIONS)[number];
export const FFE_EVENT_TYPES = [
    'GEOPOLITICAL', 'CENTRAL_BANK', 'RATE_REPRICING', 'YIELD_REPRICING',
    'OIL_SUPPLY', 'CHINA_DEMAND', 'DAIRY', 'INTERVENTION', 'FISCAL_POLITICAL',
    'MACRO_RELEASE', 'FORECAST', 'PRICE_REACTION', 'COMMENTARY', 'OTHER',
] as const;
export type FfeEventType = (typeof FFE_EVENT_TYPES)[number];

export type ClassifiedAsset = {
    asset: TrackedAsset;
    bias: AssetBias;
    /** FFE Catalyst score: +1 / +0.5 / +0.25 / 0 / -0.25 / -0.5 / -1. */
    score: number;
    /** AI-declared causal role; code never infers this from headline text. */
    role?: 'DIRECT' | 'TRANSMITTED' | 'CONFIRMATION';
    reason?: string;
};

/** An already-stored, non-duplicate headline from today the model can match new ones against. */
export type ExistingTopic = { id: string; text: string; publishedAt?: Date | string | null };

export type ExistingCanonicalTheme = {
    id: string;
    themeKey: string;
    label: string;
    summary: string;
    status: 'ACTIVE' | 'RESOLVED' | 'REVERSED' | string;
    geoState?: string | null;
    assets: ClassifiedAsset[];
    score?: number;
    lastUpdatedAt?: Date | string | null;
    supportingEventIds?: string[];
    /** Full event-state context for the canonical resolver. Theme identity alone is not an
     * event principal and must never be used as a substitute for one. */
    events?: ExistingCanonicalEvent[];
};

export type ExistingCanonicalEvent = {
    id: string;
    themeId?: string | null;
    relation?: string | null;
    status: 'ACTIVE' | 'WATCH' | 'RESOLVED' | 'REVERSED' | string;
    valid?: boolean;
    independent?: boolean;
    catalystEligible?: boolean;
    eventType?: string | null;
    headline: string;
    fundamentalCause?: string | null;
    observedMarketReaction?: string | null;
    transmissionReason?: string | null;
    normalizedSignature?: string | null;
    sourceGuid?: string | null;
    firstSeenAt?: Date | string | null;
    lastSeenAt?: Date | string | null;
    contributions: ClassifiedAsset[];
    supportingGuids?: string[];
    confirmationGuids?: string[];
    counterEvidence?: string[];
};

/** Optional pub time so the LLM can tell same-briefing fragments from later separate developments. */
export type HeadlineInput = { text: string; publishedAt?: Date | string | null; actual?: string | null; forecast?: string | null; previous?: string | null };

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
    /** Semantic fields are persisted separately from event-duplicate identity. */
    driverTheme?: string | null;
    causalThemeId?: string | null;
    geoState?: GeoState;
    semanticDirection?: SemanticDirection;
    semanticStrength?: SemanticStrength;
    directAssetSignals?: FfeAssetSignal[];
    transmittedAssetSignals?: FfeAssetSignal[];
    signValidationStatus?: 'PASS' | 'CORRECTED' | 'FAILED' | 'NOT_APPLICABLE';
    /** Explicit semantic visibility decision for Catalyst (watch-only rows stay auditable). */
    catalystVisible?: boolean;
    /** Canonical AI Analyst provenance contract. */
    fundamentalCause?: string | null;
    eventRelation?: FfeEventRelation;
    eventDuplicateOf?: string | null;
    eventType?: FfeEventType | string | null;
    observedMarketReaction?: string | null;
    eventStrength?: 'NONE' | 'WEAK' | 'MODERATE' | 'STRONG' | string | null;
    eventSeverity?: number | null;
    eventCredibility?: number | null;
    eventFreshness?: number | null;
    eventPersistence?: number | null;
    transmissionReason?: string | null;
    counterEvidence?: string[];
    currentAssetContributions?: ClassifiedAsset[];
    /**
     * Deterministic contract-transmission family (e.g. OIL_SUPPLY_SHOCK, GEO_SYSTEMIC_ESCALATION,
     * RATE_YIELD_REPRICING). Set only when application code applied the contract transmission table.
     * The Catalyst board collapses all active drivers sharing a family to a single unique causal
     * driver (client contract §30), preventing fragmented headlines from multiplying the score.
     */
    contractTransmissionFamily?: string | null;
    supportingGuidIds?: string[];
    confirmationGuidIds?: string[];
    macroValues?: { actual: string | null; forecast: string | null; previous: string | null };
    causalThemeSummary?: string | null;
    themeAction?: 'CREATE' | 'UPDATE' | 'JOIN' | 'NEW_OPPOSING_THEME' | 'NONE';
    themeDecision?: {
        action: 'JOIN_EXISTING_THEME' | 'UPDATE_EXISTING_THEME' | 'REVERSE_EXISTING_THEME' | 'CREATE_NEW_THEME' | 'CONTEXT_ONLY' | 'MACRO_ONLY' | 'IRRELEVANT';
        themeId: string | null;
        themeKey: string | null;
        label: string | null;
        summary: string | null;
        reason: string;
        status: 'ACTIVE' | 'WATCH' | 'RESOLVED' | 'REVERSED';
        assetContributions: ClassifiedAsset[];
    };
    macro?: {
        eligible: boolean;
        family: string | null;
        directionSummary: string | null;
        assetScores: Array<{ asset: TrackedAsset; score: number; reason: string }>;
    };
    catalystEligible?: boolean;
    confidence?: number;
    needsReview?: boolean;
    reason?: string;
    decisionSource?: 'ai_primary' | 'ai_fallback' | 'ai_adjudication' | 'test_override';
    promptVersion?: string;
    structuralValidationStatus?: 'PASS' | 'RETRY' | 'FAILED';
    provider?: 'openai' | 'groq';
    model?: string;
};

/**
 * Directional + asset + summary rules distilled from the automation-rules doc
 * (§1, §3, §4, §21–§25, §32, §34) + families observed on the FinancialJuice feed.
 *
 * DESIGN: the configured primary model is the classifier for ANY new wording; Groq is only the
 * bounded fallback. Sanitize is only a thin
 * universal safety net. Do NOT add person/event-specific code when a new headline appears —
 * improve this prompt / universal families instead.
 */
const LEGACY_SYSTEM_PROMPT = `You are the Market Driver Board classifier for Forex Fundamental Edge.

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
6) driverTheme and causalThemeId — semantic cause family, never a literal event-duplicate id
7) geoState — ESCALATION | DE_ESCALATION | WATCH | IRRELEVANT (classify before asset mapping)
8) semanticDirection — BULLISH | BEARISH | NEUTRAL | MIXED
9) semanticStrength — NONE | WEAK | MODERATE | STRONG

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
- Tracked Catalyst assets are USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, GOLD and OIL.
- Return semantic cause and direction; final numeric aggregation is application-code controlled.
- Include only clear, unique, market-moving non-calendar drivers: central-bank/rate guidance, meaningful yield repricing, confirmed geopolitical or broad risk regime changes, strong fundamentally-driven oil moves, major China/industrial-metal developments, meaningful dairy moves, intervention warnings, or major fiscal/political developments.
- Scheduled CPI/GDP/employment/PMI/retail/industrial/housing releases are ECONOMIC_MACRO_ONLY: preserve them for Macro, never discard them as IRRELEVANT and never score them as an independent Catalyst.
- Remove all pair-price analysis, forecasts, technical/support/resistance/target stories, naked currency moves, crypto, company news, minor politics and unsupported speculation.
- DXY or another currency index is only evidence of a genuine new fundamental cause. Never count the index and that same cause twice.
- Confirmed meaningful geopolitical escalation: USD +0.5, CHF +0.5, AUD -0.5, NZD -0.5, EUR -0.25, GBP -0.25; JPY +0.5 only with confirmed safe-haven buying; CAD is not scored through geopolitics. Reverse only with clear market-confirmed de-escalation.
- Strong fundamental oil rise: CAD +0.5 (or +1 for major/sustained surge), JPY -0.5, EUR -0.25. Strong oil fall: CAD -0.5 (or -1 major/sustained), JPY +0.25.
- Major China/industrial-metal improvement: AUD +0.5 (or +1 major), NZD +0.25. Major deterioration reverses those signs.
- Strong dairy rise/fall: NZD +0.5/-0.5.
- Central-bank/rate/yield/political drivers score the directly affected currency by strength: strong ±1, moderate ±0.5, weak but valid ±0.25.
- Count every underlying event once per affected currency; keep opposing drivers. Return a short main-driver explanation.

Respond ONLY with JSON:
{"results":[{"i":0,"category":"...","impact":"...","assets":[{"asset":"...","bias":"...","score":0}],"summary":"...","driverTheme":"...","causalThemeId":"...","geoState":"IRRELEVANT","semanticDirection":"NEUTRAL","semanticStrength":"NONE"}],"duplicateGroups":[],"existingDuplicates":[]}
Every input index must appear exactly once in "results".`;

/** Versioned canonical FFE Analyst contract. Semantic decisions come from the model; the
 * application only validates this shape, applies exact/source deduplication, and aggregates. */
export const FFE_ANALYST_PROMPT_VERSION = 'ffe-analyst-v1.3.1-client-event-contract';
const SYSTEM_PROMPT = `You are the FFE Analyst for Forex Fundamental Edge. You are the semantic authority
for each headline, while application code is the deterministic authority for event state,
transmission validation and Catalyst arithmetic. Read the complete headline and compact context;
determine the fundamental cause, observed market reaction (separately), event type, event relation,
causal theme, geopolitical state, freshness, strength, credibility, persistence, macro meaning,
affected tracked assets, transmission reason and Catalyst eligibility. Do not use brittle keyword
lookup as a substitute for semantic reasoning.

Tracked assets: USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, GOLD, OIL. Use OIL only for crude/WTI/Brent
or a directly stated crude-supply route. Use roles DIRECT, TRANSMITTED, or CONFIRMATION; CONFIRMATION
does not count toward Catalyst totals. Scores are exactly one of -1, -0.5, -0.25, 0, 0.25, 0.5, 1.
ECONOMIC releases with Actual/Forecast/Previous or a clearly measured scheduled print are Macro
evidence; they are normally not Catalyst. Distinguish the release from later market commentary.
Use semantic causality, not word overlap: same theme is not automatically the same event. A new
event may JOIN an existing theme; use SAME_EVENT only for the same underlying announcement/outcome.
When a relation is not NEW_EVENT, eventDuplicateOf MUST contain the exact existing canonical
event id from the context (not a theme id). If no existing principal fits, do not invent an id:
set needsReview=true and use an evidence-only/zero-contribution relation. A NEW_EVENT may mint
one event only when it is a genuinely independent cause; later paraphrases, updates, reactions,
and confirmations must point to the principal event and mutate its current state.
Use exactly one eventRelation from NEW_EVENT, SAME_EVENT, EVENT_UPDATE, STRENGTHENING_EVIDENCE,
WEAKENING_EVIDENCE, REVERSAL, DE_ESCALATION, CONFIRMATION, PRICE_REACTION, HISTORICAL_COMMENTARY,
MACRO_RELEASE, FORECAST_UPCOMING or IRRELEVANT. Confirmations, price reactions, commentary,
forecasts, scheduled Macro releases, duplicates and irrelevant rows have zero current Catalyst
contribution.
Assess geoState before asset mapping. Defensive exercises, routine visits, domestic politics and
unresolved rhetoric are WATCH or IRRELEVANT unless the facts support escalation. A confirmed
Hormuz/shipping escalation can directly affect OIL/GOLD before any broad FX transmission.
Do not invent an existing internal theme id. Choose one semantic theme action:
JOIN_EXISTING_THEME(themeId), UPDATE_EXISTING_THEME(themeId), REVERSE_EXISTING_THEME(themeId),
CREATE_NEW_THEME (with a normalized themeKey/label and why no candidate fits), CONTEXT_ONLY,
MACRO_ONLY, or IRRELEVANT. The internal ids in ACTIVE THEMES are code-generated and may only be
referenced exactly. A confirmation/reaction updates or joins the cause and contributes zero new
Catalyst score. Different events may join one broader causal theme; do not create one theme per
speaker sentence or price reaction.

Additional semantic boundaries: dovish central-bank guidance or faster rate cuts cannot be bullish
for the currency whose expected policy rate is being reduced; classify it as Macro/policy context
when appropriate and keep that currency bearish or neutral unless the headline supplies a separate
offsetting cause. Technical price forecasts or support/resistance for an untracked asset (for
example Silver/XAG) must not be proxied into GOLD or another tracked asset; with no tracked
fundamental cause, return IRRELEVANT with an empty assets array.

Universal FFE transmission calibration:
- A scheduled Actual/Forecast/Previous release is Macro-only. Its measured surprise may score only
  the directly affected currency and only once for that release family; related wire summaries,
  duplicate value lines, and later price reactions are confirmation with zero new Catalyst score.
- A broad geopolitical headline is not automatically a GOLD, OIL, or safe-haven signal. GOLD needs
  explicit safe-haven/real-yield/USD evidence or a confirmed systemic escalation. JPY is not
  bullish merely because a war headline exists; use a negative Japan/import or yield channel, or
  a confirmed haven reaction, and otherwise leave it neutral.
- OIL is directly directional only for crude/WTI/Brent, production, a named crude route, or a
  confirmed shipping/supply disruption. Localized strikes, diplomatic visits, unconfirmed reports,
  defensive exercises, and generic Middle-East rhetoric are WATCH/context and score OIL 0. A
  confirmed Hormuz/crude-supply chain is one canonical theme: OIL can be bullish, CAD may receive
  one transmitted confirmation, and the same theme's later confirmations must not add again.
- Treat an actual operational attack, vessel hit/damage/casualty, route interruption, blockade or
  confirmed strategic-shipping incident as operational evidence even when the headline does not
  literally say “supply disruption” or “closure”. Such evidence must update the existing route
  event from WATCH when appropriate and evaluate the direct OIL transmission; do not silently
  convert a confirmed operational route event to a zero-score WATCH merely because the downstream
  commodity impact is not yet quantified. Keep an early warning, threat alert, rumour or precaution
  policy statement at WATCH/zero until an operational fact is actually reported.
- For the confirmed Hormuz transmission table, use only the stated causal channels: USD/CHF may
  be positive, AUD/NZD may be negative, EUR/GBP may be mildly negative, CAD is not an additional
  independent shock, and JPY receives a haven contribution only when the headline confirms that
  behavior. Do not invent cross-asset propagation for unrelated geo clusters.
- Theme-level scores are state, not headline counts. JOIN/UPDATE/confirmation rows must preserve
  the existing theme score unless the new event explicitly strengthens or reverses the cause.
- Only ACTIVE, VALID, UNIQUE, INDEPENDENT canonical event contributions are summed. Preserve
  opposing valid events instead of netting them away. Raw asset totals are not clamped to +/-1.
  The Session Brain reviews/resolves event state but cannot replace this event-level arithmetic.

For this FFE methodology, when the facts support the same causal cluster, prefer these stable
theme keys rather than inventing one key per wire fragment:
- GEO_HORMUZ_MIDDLE_EAST_ESCALATION: one Middle-East/Hormuz cluster. Its bounded transmission is
  USD +0.5, CHF +0.5, EUR -0.25, GBP -0.25, AUD -0.5, NZD -0.5; CAD stays 0 directly and JPY is
  added only when the headline confirms haven behavior. Keep OIL as a separate supply-shock theme.
- OIL_SUPPLY_SHOCK: one crude/route/supply chain. Score OIL once (up to +1) and transmit CAD once
  (+0.5 to +1) only when the evidence supports it; a later “CAD supported by oil” or Brent/WTI
  price headline is confirmation, not a new theme.
- USD_YIELD_REPRICING: one independently evidenced US-yield/rate-repricing cluster, normally
  USD +0.5. A DXY/USD reaction line confirms it and scores zero.
Create a different key only when the underlying cause is genuinely different; do not merge unrelated
Russia/Ukraine, domestic, China-policy, or routine diplomatic context into these clusters.

Calibration examples (generalize the causal relationship, do not create lookup rules):
- “Australian Dollar gains as US Dollar struggles amid fading Fed rate hike bets” means USD bearish;
- UK Claimant Count/wage releases with Actual and Forecast are ECONOMIC Macro-only;
- a Pound-vs-Yen move after UK employment data remains UK labour/macro, not a Japan growth theme;
- a Euro-vs-Pound move after UK unemployment is UK labour/macro, not ECB repricing;
- a defensive Ulchi exercise with explicit non-escalation does not automatically score OIL;
- US-Iran war worries are geopolitical/risk context, not automatically ECB policy;
- a routine domestic visit does not create CAD or OIL impact;
- confirmed Hormuz tanker/crude-supply escalation is directly bullish OIL before any broad FX effects;
- a confirmed Hormuz closure/attack is one causal theme, not a separate OIL/GOLD theme for every
  wire fragment; local Odesa/Yemen/Syria/UAE reports remain watch-only until a supply-route or
  confirmed escalation link is present;
- the client driver-cluster rule is: middle-east geo, crude supply shock, and US-yield repricing
  are separate themes; price reactions and “supported by oil” summaries confirm those themes only;
- faster ECB rate cuts are not bullish EUR, and a Silver/XAG technical forecast is not a GOLD driver.

For every input index return exactly one result with this shape:
{ itemId, category, fundamentalCause, observedMarketReaction, eventType, eventRelation,
  eventStrength, eventSeverity, eventCredibility, eventFreshness, eventPersistence,
  transmissionReason, counterEvidence, supportingGuidIds, confirmationGuidIds, macroValues,
  eventDuplicateOf, causalThemeId,
  causalThemeSummary, themeAction, geoState,
  themeDecision:{action,themeId,themeKey,label,summary,reason,status,assetContributions},
  macro:{eligible,family,directionSummary,assetScores:[{asset,score,reason}]},
  assets:[{asset,score,bias,role,reason}], catalystEligible, confidence, needsReview, reason }

Return JSON only. If uncertain, keep the item distinct, set needsReview=true, lower confidence, and
explain the uncertainty. Never silently fall back to deterministic semantic rules.`;

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

Return JSON only: {"duplicateGroups":[[principal, dup, ...], ...],"causalThemes":[{"i":0,"causalThemeId":"THEME"}]}
Use [] if none.`;

const ADJUDICATION_SYSTEM_PROMPT = `You are the bounded FFE Analyst adjudicator. Review proposed AI decisions for one
or more headlines. Correct only material semantic contradictions: the proposed asset direction must
    agree with the proposed macro direction, scheduled releases must not be Catalyst-only, technical or
    untracked items must not receive tracked-asset Catalyst scores, dovish policy guidance cannot be
    bullish for the currency being eased, and event relation/theme fields must
be coherent. Re-read the headline; do not apply keyword lookup rules. A confirmed Hormuz/crude-supply
disruption is directly bullish OIL; a defensive exercise without escalation is not an OIL Catalyst;
explicit USD weakness must not be reported as a positive USD score. Do not score GOLD for every
localized conflict, do not score JPY bullish without a confirmed haven/import/yield channel, and
do not let a same-theme JOIN or confirmation add another Catalyst score. A scheduled release or
its later commentary is Macro-only and a duplicate value line contributes zero new score. Return
the same complete FFE Analyst result schema for every input. The result field \"i\" MUST equal the
LOCAL_INDEX label supplied immediately before that input, must be an integer from 0 through N-1,
and every local index must appear exactly once; never copy an original headline index or use the
same index for multiple inputs. Include a short reason and set needsReview=true
when uncertainty remains. For a Hormuz/Middle-East chain, preserve one geo cluster and one separate
crude-supply cluster; for a US-yield/rate repricing chain, keep one USD theme and treat DXY/USD
reaction lines as confirmation. Use exact active theme ids when a candidate is supplied.`;

const GEO_RISK_SCHEMA: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        directMilitaryEscalation: { type: 'number', minimum: 0, maximum: 0.2 },
        energyHormuzRisk: { type: 'number', minimum: 0, maximum: 0.2 },
        diplomaticDeterioration: { type: 'number', minimum: 0, maximum: 0.2 },
        regionalSpillover: { type: 'number', minimum: 0, maximum: 0.2 },
        sanctionsStrategicConfrontation: { type: 'number', minimum: 0, maximum: 0.2 },
        deEscalationDeduction: { type: 'number', minimum: 0, maximum: 0.2 },
        explanation: { type: 'string' },
    },
    required: ['directMilitaryEscalation', 'energyHormuzRisk', 'diplomaticDeterioration', 'regionalSpillover', 'sanctionsStrategicConfrontation', 'deEscalationDeduction', 'explanation'],
};

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

/** Retrieve every current ACTIVE/WATCH theme for the Dubai day. Relevance is decided by the model
 * against the full canonical state; no 40-theme shortlist may hide an existing active driver. */
function selectCanonicalThemeCandidates(
    themes: ExistingCanonicalTheme[] | undefined,
    headlines: string[],
): ExistingCanonicalTheme[] {
    if (!themes?.length) return [];
    void headlines;
    return themes
        .filter((theme) => ['ACTIVE', 'WATCH'].includes(String(theme.status).toUpperCase()))
        .sort((a, b) => new Date(String(b.lastUpdatedAt ?? 0)).getTime() - new Date(String(a.lastUpdatedAt ?? 0)).getTime());
}

function normalizeHeadlineInput(input: string | HeadlineInput): HeadlineInput {
    if (typeof input === 'string') return { text: input };
    return {
        text: input.text,
        publishedAt: input.publishedAt,
        actual: input.actual ?? null,
        forecast: input.forecast ?? null,
        previous: input.previous ?? null,
    };
}

function formatPromptHeadlineLine(index: number | string, input: string | HeadlineInput): string {
    const { text, publishedAt } = normalizeHeadlineInput(input);
    const cleaned = text.replace(/\s+/g, ' ').trim();
    const hhmm = dubaiHhMm(publishedAt);
    const prefix = typeof index === 'number' ? `${index}.` : `${index}:`;
    return hhmm ? `${prefix} [${hhmm}] ${cleaned}` : `${prefix} ${cleaned}`;
}

export type JsonSchema = { [key: string]: unknown };
export type ProviderResponse = {
    parsed: Record<string, unknown>;
    provider: 'openai' | 'groq';
    model: string;
};
export type AiEvaluationAttempt = {
    provider: 'openai' | 'groq';
    model: string;
    operationType: AiOperationType;
    requestStatus: 'success' | 'error';
    usage: ProviderUsage;
    isFallback: boolean;
    errorKind?: string | null;
    errorMessage?: string | null;
};
const aiEvaluationAttempts: AiEvaluationAttempt[] = [];
export function resetAiEvaluationTelemetry(): void { aiEvaluationAttempts.length = 0; }
export function getAiEvaluationTelemetry(): AiEvaluationAttempt[] { return aiEvaluationAttempts.map((row) => ({ ...row, usage: { ...row.usage } })); }
export type StructuredJsonRequestOptions = {
    operationType: AiOperationType;
    jobId?: string | null;
    ingestId?: string | null;
    schema: JsonSchema;
    schemaName: string;
    maxOutputTokens: number;
    validate?: (value: Record<string, unknown>) => boolean;
    /** Override the default OpenAI/Groq model for this request. */
    model?: string;
    /** Override OpenAI reasoning effort for this request. */
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
    /** Per-request transport timeout (OpenAI client / Groq abort). */
    requestTimeoutMs?: number;
    /** Max transport attempts for this request (default: provider policy). Use 1 for long GPT-first sessions. */
    transportMaxAttempts?: number;
    /** Run OpenAI Responses API in background mode and poll until complete (long reasoning jobs). */
    useBackground?: boolean;
    /** Evaluation mode must not write provider usage or jobs to the application database. */
    recordUsage?: boolean;
};

async function recordUsageIfEnabled(options: StructuredJsonRequestOptions, capture: Parameters<typeof recordAiUsage>[0]): Promise<void> {
    if (options.recordUsage === false) {
        aiEvaluationAttempts.push({
            provider: capture.provider,
            model: capture.model,
            operationType: capture.operationType,
            requestStatus: capture.requestStatus,
            usage: capture.usage ?? {},
            isFallback: capture.isFallback,
            errorKind: capture.errorKind,
            errorMessage: capture.errorMessage ?? null,
        });
        return;
    }
    await recordAiUsage(capture);
}

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
    options: StructuredJsonRequestOptions,
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
                    itemId: { type: 'string' },
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
                                role: { type: 'string', enum: ['DIRECT', 'TRANSMITTED', 'CONFIRMATION'] },
                                reason: { type: 'string' },
                            },
                            required: ['asset', 'bias', 'score', 'role', 'reason'],
                        },
                    },
                    summary: { type: 'string' },
                    driverTheme: { type: 'string' },
                    causalThemeId: { type: 'string' },
                    geoState: { type: 'string', enum: ['ESCALATION', 'DE_ESCALATION', 'WATCH', 'IRRELEVANT'] },
                    semanticDirection: { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL', 'MIXED'] },
                    semanticStrength: { type: 'string', enum: ['NONE', 'WEAK', 'MODERATE', 'STRONG'] },
                    fundamentalCause: { type: 'string' },
                    eventRelation: { type: 'string', enum: [...FFE_EVENT_RELATIONS] },
                    eventDuplicateOf: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    eventType: { anyOf: [{ type: 'string', enum: [...FFE_EVENT_TYPES] }, { type: 'null' }] },
                    observedMarketReaction: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    eventStrength: { anyOf: [{ type: 'string', enum: ['NONE', 'WEAK', 'MODERATE', 'STRONG'] }, { type: 'null' }] },
                    eventSeverity: { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] },
                    eventCredibility: { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] },
                    eventFreshness: { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] },
                    eventPersistence: { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] },
                    transmissionReason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    counterEvidence: { type: 'array', items: { type: 'string' } },
                    supportingGuidIds: { type: 'array', items: { type: 'string' } },
                    confirmationGuidIds: { type: 'array', items: { type: 'string' } },
                    macroValues: {
                        type: 'object', additionalProperties: false,
                        properties: {
                            actual: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                            forecast: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                            previous: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                        },
                        required: ['actual', 'forecast', 'previous'],
                    },
                    causalThemeSummary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    themeAction: { type: 'string', enum: ['CREATE', 'UPDATE', 'JOIN', 'NEW_OPPOSING_THEME', 'NONE'] },
                    themeDecision: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            action: { type: 'string', enum: ['JOIN_EXISTING_THEME', 'UPDATE_EXISTING_THEME', 'REVERSE_EXISTING_THEME', 'CREATE_NEW_THEME', 'CONTEXT_ONLY', 'MACRO_ONLY', 'IRRELEVANT'] },
                            themeId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                            themeKey: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                            label: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                            summary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                            reason: { type: 'string' },
                            status: { type: 'string', enum: ['ACTIVE', 'WATCH', 'RESOLVED', 'REVERSED'] },
                            assetContributions: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: {
                                        asset: { type: 'string', enum: [...TRACKED_ASSETS] },
                                        bias: { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral', 'Mixed'] },
                                        score: { type: 'number' },
                                        role: { type: 'string', enum: ['DIRECT', 'TRANSMITTED', 'CONFIRMATION'] },
                                        reason: { type: 'string' },
                                    },
                                    required: ['asset', 'bias', 'score', 'role', 'reason'],
                                },
                            },
                        },
                        required: ['action', 'themeId', 'themeKey', 'label', 'summary', 'reason', 'status', 'assetContributions'],
                    },
                    macro: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            eligible: { type: 'boolean' },
                            family: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                            directionSummary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                            assetScores: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: {
                                        asset: { type: 'string', enum: [...TRACKED_ASSETS] },
                                        score: { type: 'number' },
                                        reason: { type: 'string' },
                                    },
                                    required: ['asset', 'score', 'reason'],
                                },
                            },
                        },
                        required: ['eligible', 'family', 'directionSummary', 'assetScores'],
                    },
                    catalystEligible: { type: 'boolean' },
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                    needsReview: { type: 'boolean' },
                    reason: { type: 'string' },
                },
                required: [
                    'i',
                    'itemId',
                    'category',
                    'impact',
                    'assets',
                    'summary',
                    'driverTheme',
                    'causalThemeId',
                    'geoState',
                    'semanticDirection',
                    'semanticStrength',
                    'fundamentalCause',
                    'observedMarketReaction',
                    'eventType',
                    'eventRelation',
                    'eventStrength',
                    'eventSeverity',
                    'eventCredibility',
                    'eventFreshness',
                    'eventPersistence',
                    'transmissionReason',
                    'counterEvidence',
                    'supportingGuidIds',
                    'confirmationGuidIds',
                    'macroValues',
                    'eventDuplicateOf',
                    'causalThemeSummary',
                    'themeAction',
                    'themeDecision',
                    'macro',
                    'catalystEligible',
                    'confidence',
                    'needsReview',
                    'reason',
                ],
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

function classificationOutputTokens(expectedCount: number): number {
    // gpt-5.4-mini/high-reasoning emits a complete 35-field result at materially more than
    // the nano-era 700-token estimate. Under-budgeting a strict array truncates the response
    // and causes the whole durable batch to be discarded. Keep the bound finite and derive it
    // from the current batch size rather than allowing an unbounded model response.
    const perResult = ENV.OPENAI_CLASSIFICATION_MODEL.includes('mini') ? 8_000 : 1_000;
    return Math.max(ENV.AI_MAX_OUTPUT_TOKENS, Math.min(60_000, expectedCount * perResult));
}

const DEDUP_RESPONSE_SCHEMA: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        duplicateGroups: {
            type: 'array',
            items: { type: 'array', items: { type: 'integer', minimum: 0 } },
        },
        causalThemes: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    i: { type: 'integer', minimum: 0 },
                    causalThemeId: { type: 'string' },
                },
                required: ['i', 'causalThemeId'],
            },
        },
    },
    required: ['duplicateGroups', 'causalThemes'],
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

async function requestJson(system: string, user: string, options: StructuredJsonRequestOptions): Promise<ProviderResponse | null> {
    if (aiProviderRequestOverride) {
        const startedAt = Date.now();
        const parsed = await aiProviderRequestOverride(system, user, options);
        const valid = parsed !== null && (!options.validate || options.validate(parsed));
        await recordUsageIfEnabled(options, {
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

        const model = options.model ?? (provider === 'openai' ? ENV.OPENAI_CLASSIFICATION_MODEL : ENV.GROQ_FALLBACK_MODEL);
        const reasoningEffort = options.reasoningEffort ?? (provider === 'openai' ? ENV.AI_OPENAI_REASONING_EFFORT : ENV.AI_GROQ_REASONING_EFFORT);
        const maxAttempts = provider === 'openai'
            ? Math.max(1, ENV.AI_PRIMARY_MAX_ATTEMPTS)
            : Math.max(1, ENV.AI_FALLBACK_MAX_ATTEMPTS);
        const effectiveMaxAttempts = Math.min(
            maxAttempts,
            Math.max(1, options.transportMaxAttempts ?? maxAttempts),
        );
        for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt += 1) {
            const startedAt = Date.now();
            let usage: ProviderUsage = {};
            let requestId: string | null = null;
            let responseStatus: string | null = null;
            let responseOutputLength: number | null = null;
            let responseIncompleteReason: string | null = null;
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
                    const requestTimeoutMs = Math.max(5_000, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
                    const openAiClient = openAiClientForTimeout(requestTimeoutMs);
                    const useBackground = options.useBackground === true;
                    let response = await openAiClient.responses.create({
                        model,
                        background: useBackground,
                        input: [
                            { role: 'system', content: system },
                            { role: 'user', content: user },
                        ],
                        reasoning: { effort: reasoningEffort as 'none' | 'low' | 'medium' | 'high' | 'xhigh' },
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
                    let responseValue = response as unknown as Record<string, unknown>;
                    if (useBackground) {
                        responseValue = await waitForOpenAiResponse(openAiClient, responseValue, requestTimeoutMs, startedAt);
                        response = responseValue as typeof response;
                    }
                    responseStatus = typeof responseValue.status === 'string' ? responseValue.status : null;
                    responseIncompleteReason = typeof (responseValue.incomplete_details as { reason?: unknown } | null)?.reason === 'string'
                        ? String((responseValue.incomplete_details as { reason: string }).reason)
                        : null;
                    requestId = typeof responseValue._request_id === 'string'
                        ? responseValue._request_id
                        : (typeof responseValue.id === 'string' ? responseValue.id : null);
                    usage = parseUsage(responseValue.usage, requestId);
                    const responseText = openAiText(response) ?? '';
                    responseOutputLength = responseText.length;
                    parsed = parseJsonText(responseText);
                } else {
                    const controller = new AbortController();
                    const requestTimeoutMs = Math.max(5_000, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
                    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
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
                                await recordUsageIfEnabled(options, {
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
                            await recordUsageIfEnabled(options, {
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
                await recordUsageIfEnabled(options, {
                    provider, model, operationType: options.operationType, jobId: options.jobId,
                    ingestId: options.ingestId, usage, requestStatus: valid ? 'success' : 'error',
                    latencyMs: Date.now() - startedAt, attemptNumber: attempt, isRetry: attempt > 1,
                    isFallback: provider === 'groq', errorKind: valid ? null : 'schema',
                    errorMessage: valid ? null : 'Provider response did not satisfy the required JSON schema',
                });
                if (!valid) {
                    logger.warn('[AIProvider] Structured response rejected by application validator', {
                        provider,
                        model,
                        operationType: options.operationType,
                        schemaName: options.schemaName,
                        parsedObject: Boolean(parsed),
                        responseStatus,
                        responseOutputLength,
                        responseIncompleteReason,
                    });
                }
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
                await recordUsageIfEnabled(options, {
                    provider, model, operationType: options.operationType, jobId: options.jobId,
                    ingestId: options.ingestId, usage: { ...usage, requestId }, requestStatus: 'error',
                    latencyMs: Date.now() - startedAt, attemptNumber: attempt, isRetry: attempt > 1,
                    isFallback: provider === 'groq', errorKind: kind, errorMessage: safeProviderMessage(error),
                });
                logger.warn('[AIProvider] Provider request failed', { provider, model, kind, attempt });
                const retryTransport = retryable && kind !== 'timeout' && attempt < effectiveMaxAttempts;
                if (!retryTransport) break;
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
 * Shared provider boundary for versioned FFE semantic contracts.  The existing headline
 * classifier and the Session Brain intentionally use the same bounded OpenAI-primary/Groq-
 * fallback transport, usage accounting, test seams, and strict JSON-schema validation.
 */
export async function requestStructuredJson(
    system: string,
    user: string,
    options: StructuredJsonRequestOptions,
): Promise<ProviderResponse | null> {
    return requestJson(system, user, options);
}

export type GeoRiskAiDecision = {
    directMilitaryEscalation: number;
    energyHormuzRisk: number;
    diplomaticDeterioration: number;
    regionalSpillover: number;
    sanctionsStrategicConfrontation: number;
    deEscalationDeduction: number;
    explanation: string;
    provider: 'openai' | 'groq';
    model: string;
};

/** Evaluate only when the unique AI causal-theme set changes. Daily Market View never calls this. */
export async function evaluateGeoRiskThemes(
    themes: Array<{ causalThemeId: string; state: string; summary: string; assets: ClassifiedAsset[] }>,
    options: { jobId?: string | null; ingestId?: string | null; recordUsage?: boolean } = {},
): Promise<GeoRiskAiDecision | null> {
    if (!themes.length) return null;
    const response = await requestJson(
        'You are the FFE geopolitical risk evaluator. Use only the already AI-classified unique causal themes below. Return the five bounded component scores and a concise explanation. Do not infer from application keywords; defensive exercises and routine visits do not create escalation, while confirmed Hormuz/crude shipping escalation may score energy risk. Code will perform only max-component arithmetic and clamping.',
        themes.map((theme, index) => `${index}. theme=${theme.causalThemeId} state=${theme.state} summary=${theme.summary} assets=${JSON.stringify(theme.assets)}`).join('\n'),
        {
            operationType: 'geo_risk_evaluation',
            jobId: options.jobId,
            ingestId: options.ingestId,
            schema: GEO_RISK_SCHEMA,
            schemaName: 'ffe_geo_risk_evaluation',
            maxOutputTokens: Math.max(512, ENV.AI_DEDUP_MAX_OUTPUT_TOKENS),
            recordUsage: options.recordUsage,
            validate: (value) => typeof value.explanation === 'string',
        },
    );
    if (!response) return null;
    const value = response.parsed;
    const bounded = (key: string) => Math.max(0, Math.min(0.2, Number(value[key] ?? 0)));
    return {
        directMilitaryEscalation: bounded('directMilitaryEscalation'),
        energyHormuzRisk: bounded('energyHormuzRisk'),
        diplomaticDeterioration: bounded('diplomaticDeterioration'),
        regionalSpillover: bounded('regionalSpillover'),
        sanctionsStrategicConfrontation: bounded('sanctionsStrategicConfrontation'),
        deEscalationDeduction: bounded('deEscalationDeduction'),
        explanation: String(value.explanation ?? '').slice(0, 1000),
        provider: response.provider,
        model: response.model,
    };
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
    if (parsed) {
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
    // Opposite directional moves are separate market facts even when the
    // asset/theme tokens overlap (for example, morning gold gains versus an
    // evening gold decline). Keep this before the coarse event fingerprint.
    const polarity = (text: string): number => {
        const h = text.toLowerCase();
        const primaryMove = h.match(/\b(?:gold|xau|wti|brent|crude|oil|usd|dollar|euro|eur|yen|jpy|aud|nzd|cad|gbp|pound)\b.{0,35}\b(rise|rises|rose|rally|rallies|gains?|gained|climbs?|higher|up|advances?|surges?|strengthens?|recovers?|fall|falls|fell|decline|declines|drops?|lower|down|slides?|weakens?|tumbles?|retreats?|slumps?)\b/);
        if (primaryMove) return /fall|decline|drop|lower|down|slide|weaken|tumble|retreat|slump/.test(primaryMove[1]!) ? -1 : 1;
        const positive = /\b(rise|rises|rose|rally|rallies|gains?|gained|climbs?|higher|up|advances?|surges?|strengthens?|recovers?)\b/.test(h);
        const negative = /\b(fall|falls|fell|decline|declines|drops?|lower|down|slides?|weakens?|tumbles?|retreats?|slumps?)\b/.test(h);
        return positive === negative ? 0 : positive ? 1 : -1;
    };
    const pa = polarity(a);
    const pb = polarity(b);
    if (pa !== 0 && pb !== 0 && pa !== pb) return false;
    if (fa && fb && fa === fb) return true;

    // Scheduled releases share boilerplate (actual/forecast/previous) but remain distinct
    // metrics/events. Never let that boilerplate make China retail sales look like industrial
    // output, or GDP look like CPI. Macro clustering is handled by causalThemeId later.
    if (isEconomicReleaseHeadline(a) && isEconomicReleaseHeadline(b)) {
        const family = (headline: string): string => {
            const h = headline.toLowerCase();
            const markers = ['retail sales', 'industrial output', 'industrial production', 'gdp', 'cpi', 'ppi', 'pmi', 'housing', 'house price', 'unemployment', 'jobless', 'exports', 'imports', 'capital flows', 'electronic card retail', 'services index'];
            return markers.find((marker) => h.includes(marker)) ?? '';
        };
        const familyA = family(a);
        const familyB = family(b);
        if (familyA && familyB && familyA !== familyB) return false;
    }

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
    const deterministicPolicyTheme = inferCausalTheme(headline, 'DRIVER');
    if (deterministicPolicyTheme && /^(?:BOJ_HAWKISH_REPRICING|BOE_HOLD_REPRICING|RBA_HAWKISH_PAUSE_REPRICING|RBA_HAWKISH_GUIDANCE|RBNZ_HOLD_REPRICING|ECB_HAWKISH_REPRICING)$/.test(deterministicPolicyTheme)) return false;
    if (/\b(price forecast|forecast:|technical analysis|support|resistance|breakout|chart|moving average|ema|rsi|fibonacci|price target)\b/.test(h)) return true;
    if (/\b(eur\/usd|gbp\/usd|usd\/jpy|aud\/usd|nzd\/usd|usd\/cad|eur\/jpy|gbp\/jpy|xau\/usd)\b/.test(h) &&
        /\b(gains?|falls?|rall(?:y|ies)|weakens?|tests?|trades?|near|above|below|holds?)\b/.test(h) &&
        !/\b(fed|fomc|ecb|boe|boj|boc|rba|rbnz|snb|yield|rate|sanction|tariff|fiscal|intervention|risk[- ]?(?:on|off)|oil supply|opec)\b/.test(h)) return true;
    if (/\b(bitcoin|ethereum|xrp|crypto|btc|eth|nvidia|tesla|earnings|shares?)\b/.test(h)) return true;
    if (
        /\b(may|might|could|likely|expected to|rumou?r)\b/.test(h) &&
        !/\b(markets? (?:price|fully price)|rate expectations?|yield repricing|real yields?|equities? pressure)\b/.test(h) &&
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
    // Merely mentioning Hormuz, military logistics, or diplomatic contact is
    // WATCH. Broad risk-off transmission requires a confirmed event or an
    // explicit route/energy disruption.
    const confirmedEscalation = /\b(strikes?|attack(?:ed|s)?|missiles?|war expansion|blockade|shipping disruption|hormuz (?:closure|closed|disruption|blockade)|tanker assaults?|red sea|energy infrastructure|major sanctions?)\b/.test(h);
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
    if (/\b(dovish|rate cut|easing|hike bets? (?:fade|fall|drop)|rate expectations? (?:fall|drop))\b/i.test(h)) {
        return `Dovish repricing weighs on ${asset}`;
    }
    if (/\b(hawkish|hike|higher for longer|hike bets? (?:rise|increase))\b/i.test(h)) {
        return `Hawkish policy supports ${asset}`;
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
    // Keep the exclusion path on the same broad, deterministic release
    // detector used by the decision engine.  This prevents one helper from
    // treating Canada/Japan/China secondary prints as drivers while another
    // treats the same RSS item as a calendar release.
    return isEconomicReleaseHeadline(headline);
}

/**
 * FX market commentary / pair wraps that appear on the FinancialJuice Forex tab.
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
        /\b(centcom|irgc|revolutionary guards|missile|missiles|ballistic|strike|strikes|striking|hormuz|ceasefire|truce|patriot|airspace|tanker|tankers|blockade|sirens?|sanctions?|diplomatic breakthrough|peace deal|peace agreement|mou|memorandum|backchannel|kushner|deadline|ultimatum|threat|talks?|negotiat|diplom(?:acy|atic)|reopen(?:ed|s?)|gaza)\b/.test(
            h,
        ) || /\biran/.test(h);
    const actor =
        /\b(us|u\.s\.|u\.s|trump|military|israel|jordan|bahrain|fleet|navy|war|troops|uae|iran|fars news|gaza|lebanon|russia|ukraine|houthi|china|beijing|taiwan|iraq|saudi|yemen|oman|korea)/.test(h);
    return conflict && actor;
}

/** Doc §1 — crypto / non-tracked metals / Asia exotics alone are never board drivers. */
function isDocIgnoredHeadline(headline: string): boolean {
    const h = headline.toLowerCase();
    if (/\b(bitcoin|ethereum|xrp|crypto|btc|eth|solana|dogecoin)\b/.test(h)) return true;
    // A fixing/reference-rate print is a policy observation, not a USD
    // Catalyst. Keep it out unless the same headline contains a real
    // scheduled macro series (which is handled by the Macro branch first).
    if (/\b(pboc|people'?s bank of china)\b/.test(h) && /\b(reference rate|fixing|midpoint|usd\/cny|yuan)\b/.test(h) && !/\b(cpi|gdp|pmi|retail|industrial|sales|output)\b/.test(h)) return true;
    // Contract/procurement headlines mention weapons but do not report an
    // actual conflict event; they are not geopolitical market drivers.
    if (/\b(?:awards?|awarded|contract|procurement|purchase order|boost output)\b/.test(h) && /\b(?:missile|tomahawk|raytheon|navy|defen[cs]e)\b/.test(h) && !/\b(?:strike|attack|launch|hit)\b/.test(h)) return true;
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
    catalystVisible?: boolean;
    catalystEligible?: boolean;
}): boolean {
    if (input.duplicateOf) return false;
    if (input.catalystVisible === false) return false;
    if (input.catalystEligible === false) return false;
    if (!['DRIVER', 'GEOPOLITICAL'].includes(String(input.category).toUpperCase())) return false;
    return Array.isArray(input.assets) && input.assets.some(
        (asset) => asset.role !== 'CONFIRMATION' && CATALYST_CURRENCIES.includes(asset.asset as CatalystCurrency) && asset.score !== 0,
    );
}

function catalystVisibilityForTheme(theme: string | null, headline: string): boolean {
    if (!theme) return true;
    const watchOnly = new Set([
        'GAZA_DEESCALATION', 'GAZA_DEESCALATION_RHETORIC', 'HORMUZ_MILITARY_LOGISTICS',
        'IRAN_CHINA_DIPLOMACY', 'CASPIAN_STRATEGIC_RHETORIC', 'US_HORMUZ_CONTROL_RHETORIC',
        'US_IRAN_STRATEGIC_CONFRONTATION', 'IRAN_US_NEGOTIATION_CONDITIONS',
        'IRAN_US_NEGOTIATION_TIMELINE', 'HORMUZ_DIPLOMATIC_COORDINATION', 'HORMUZ_OPEN_DEESCALATION',
    ]);
    if (watchOnly.has(theme)) return false;
    if (theme === 'IRAN_US_NEGOTIATION_DEADLINE' && /\btimeframe\b|\bdoesn'?t have\b|\bno \d+[- ]day deadline\b/i.test(headline)) return false;
    if (theme === 'IRAN_US_DIPLOMATIC_DETERIORATION' && /\bnot realistic\b/i.test(headline)) return false;
    return true;
}

/**
 * Legacy test fixture helper. Production classification uses normalizeAiClassification below;
 * this historical deterministic reference is retained only so the frozen Aug17 oracle can be
 * compared without rewriting stored production rows.
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

    // Scheduled releases are durable Macro evidence. They are intentionally not Catalyst
    // rows, but must never be rewritten to IRRELEVANT merely because the board excludes them.
    // Central-bank speeches remain DRIVERs and are excluded from this branch.
    if (isEconomicReleaseHeadline(headline) && !isCentralBankSpeechHeadline(headline)) {
        const alignedProviderAssets = assets
            .filter((asset) => TRACKED_ASSETS.includes(asset.asset))
            .map((asset) => {
                const aligned = alignScoreToImpact(impact, asset.bias, asset.score);
                return { asset: asset.asset, bias: aligned.bias, score: aligned.score };
            });
        const macroDecision = deriveFfeDecision(headline, 'ECONOMIC', impact, alignedProviderAssets);
        // Keep Macro evidence separate from Catalyst rows. Low-impact releases
        // and releases without a deterministic signal must not leak a zero/AI
        // asset tag into the Catalyst pipeline.
        const macroAssets = macroDecision.transmittedAssetSignals
            .filter((asset) => asset.score !== 0) as ClassifiedAsset[];
        return {
            category: 'ECONOMIC',
            impact,
            assets: macroAssets,
            summary: ensureReasonSummary(summary, headline, impact, macroAssets, 'ECONOMIC'),
            catalystVisible: false,
        };
    }

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

    // The provider may label a valid rate/yield/industrial driver IRRELEVANT
    // when it contains no explicit speech verb. Promote deterministic cause
    // families before the final transmission pass; the rule is family-based,
    // not tied to a person, source, or GUID.
    const inferredTheme = inferCausalTheme(headline, category);
    const deterministicDriverThemes = new Set([
        'FED_REPRICING', 'FED_REPRICING_GOLD', 'FED_DOVISH_REPRICING', 'FED_DOVISH_REPRICING_GOLD',
        'FED_HAWKISH_REPRICING', 'FED_HAWKISH_LONGER_TERM_REPRICING', 'LOWER_REAL_YIELDS',
        'BOJ_POLICY_DOUBTS', 'BOJ_POLICY_REPRICING', 'BOJ_HAWKISH_REPRICING', 'JPY_INTERVENTION_RISK',
        'ECB_HAWKISH_REPRICING', 'BOE_HOLD_REPRICING', 'RBA_HAWKISH_PAUSE_REPRICING',
        'RBA_HAWKISH_GUIDANCE', 'RBNZ_HOLD_REPRICING', 'OIL_SUPPLY_RISK',
        'IRAN_US_OIL_SUPPLY_RISK', 'OIL_SUPPLY_RESTORATION', 'INDUSTRIAL_METALS_STRENGTH',
        'NZ_DAIRY_PRICES', 'FISCAL_TRADE_POLICY', 'UK_TARIFF_ESCALATION',
    ]);
    if (inferredTheme && deterministicDriverThemes.has(inferredTheme) && !isEconomicReleaseHeadline(headline)) {
        category = 'DRIVER';
        if (impact === 'Low' && !/\b(?:2027|longer term|long-term|lower real yields?)\b/i.test(headline)) impact = 'Medium';
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

    // Geo WATCH statements can have no direct asset at all (regional talks,
    // strategic rhetoric, coordination). Preserve them as auditable geo rows
    // instead of dropping them to IRRELEVANT before the watch-state return.
    if (category === 'IRRELEVANT' && inferGeoState(headline) !== 'IRRELEVANT' && !isScheduledDataReleaseHeadline(headline)) {
        category = 'GEOPOLITICAL';
    }

    // Universal §4 C: conflict / Hormuz / military → GEOPOLITICAL with OIL.
    if (isGeopoliticalConflictHeadline(headline) && !isScheduledDataReleaseHeadline(headline)) {
        if (category === 'IRRELEVANT' || category === 'ECONOMIC') category = 'GEOPOLITICAL';
        else if (
            category === 'DRIVER' &&
            (inferGeoState(headline) !== 'IRRELEVANT' || /\b(centcom|irgc|missile|strike|striking|hormuz|tanker|airspace|patriot|blockade|troops|sanction|kushner|mou|backchannel|talks?|negotiat|gaza)\b/i.test(headline))
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

    // FFE Catalyst Driver Scoring Rules are the final authority. The provider identifies the
    // cause; this deterministic engine owns transmission and numeric signs.
    const decision = deriveFfeDecision(headline, category, impact, assets);
    assets = (decision.transmittedAssetSignals.length ? decision.transmittedAssetSignals : applyFfeCatalystRules(headline, assets)) as ClassifiedAsset[];
    if (assets.length === 0) {
        if (decision.geoState === 'WATCH' && category === 'GEOPOLITICAL') {
            const watchImpact: NewsImpact = impact === 'Low' ? 'Medium' : impact;
            return {
                category: 'GEOPOLITICAL',
                impact: watchImpact,
                assets: [],
                summary: ensureReasonSummary(summary, headline, watchImpact, [], 'GEOPOLITICAL'),
                catalystVisible: false,
            };
        }
        return {
            category: 'IRRELEVANT',
            impact: 'Low',
            assets: [],
            summary: 'No clear, market-moving Catalyst Driver',
            catalystVisible: false,
        };
    }
    category = decision.geoState !== 'IRRELEVANT' || isConfirmedGeoOrRiskOff(headline) || hasClearDeEscalation(headline)
        ? 'GEOPOLITICAL'
        : 'DRIVER';
    impact = catalystImpactForScore(Math.max(...assets.map((asset) => Math.abs(asset.score))));

    summary = ensureReasonSummary(summary, headline, impact, assets, category);

    return { category, impact, assets, summary, catalystVisible: catalystVisibilityForTheme(decision.driverTheme, headline) };
}

/**
 * Structural-only normalization for the production AI path.  This function deliberately does
 * not inspect headline text: semantic category, causality, geo state, event relation, roles and
 * scores are model decisions.  It only enforces enums, tracked assets, score bounds and the
 * structural rule that IRRELEVANT/CONFIRMATION rows cannot contribute Catalyst score.
 */
export function normalizeAiClassification(
    raw: unknown,
    index: number,
    headline = '',
): Omit<ClassifiedHeadline, 'duplicateOfExistingId' | 'duplicateOfBatchIndex'> | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const enumValue = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => {
        const candidate = String(value ?? '').toUpperCase() as T;
        return allowed.includes(candidate) ? candidate : fallback;
    };
    const category = enumValue(r.category, ['ECONOMIC', 'DRIVER', 'GEOPOLITICAL', 'IRRELEVANT'] as const, 'IRRELEVANT');
    const impactToken = enumValue(r.impact, ['HIGH', 'MEDIUM', 'LOW'] as const, 'LOW');
    const impact: NewsImpact = impactToken === 'HIGH' ? 'High' : impactToken === 'MEDIUM' ? 'Medium' : 'Low';
    const bias = (value: unknown): AssetBias => {
        const token = enumValue(value, ['BULLISH', 'BEARISH', 'NEUTRAL', 'MIXED'] as const, 'NEUTRAL');
        return token === 'BULLISH' ? 'Bullish' : token === 'BEARISH' ? 'Bearish' : token === 'MIXED' ? 'Mixed' : 'Neutral';
    };
    const role = (value: unknown): 'DIRECT' | 'TRANSMITTED' | 'CONFIRMATION' => enumValue(value, ['DIRECT', 'TRANSMITTED', 'CONFIRMATION'] as const, 'DIRECT');
    const rawScore = (value: unknown): number | null => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
    };
    const score = (value: unknown): number => {
        const numeric = rawScore(value);
        if (numeric == null) return 0;
        const bounded = Math.max(-1, Math.min(1, numeric));
        return Math.round(bounded * 4) / 4;
    };
    const rawAssetRows = Array.isArray(r.assets)
        ? r.assets.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
        : [];
    let signBiasFailure = false;
    let conditionalEvidence = false;
    const assets: ClassifiedAsset[] = [];
    const seen = new Set<string>();
    for (const rawAsset of Array.isArray(r.assets) ? r.assets : []) {
        if (!rawAsset || typeof rawAsset !== 'object') continue;
        const a = rawAsset as Record<string, unknown>;
        const asset = String(a.asset ?? '').toUpperCase().replace('OIL (WTI)', 'OIL').replace('WTI', 'OIL') as TrackedAsset;
        if (!TRACKED_ASSETS.includes(asset) || seen.has(asset)) continue;
        seen.add(asset);
        let nextScore = score(a.score);
        const nextRole = role(a.role);
        const declaredBias = bias(a.bias);
        const reason = String(a.reason ?? '').slice(0, 500);
        const expectedBias: AssetBias = nextScore > 0 ? 'Bullish' : nextScore < 0 ? 'Bearish' : 'Neutral';
        if (nextRole !== 'CONFIRMATION' && nextScore !== 0 && (declaredBias === 'Mixed' || declaredBias !== expectedBias)) {
            // Never persist/display a signed contribution with an incompatible bias. Keep the
            // evidence row for audit, but force the contradictory contribution to zero.
            signBiasFailure = true;
            nextScore = 0;
        }
        assets.push({ asset, bias: nextScore > 0 ? 'Bullish' : nextScore < 0 ? 'Bearish' : 'Neutral', score: nextScore, role: nextRole, reason });
    }
    const macroRaw = r.macro && typeof r.macro === 'object' ? r.macro as Record<string, unknown> : {};
    const macroAssetScores = (Array.isArray(macroRaw.assetScores) ? macroRaw.assetScores : [])
        .filter((v): v is Record<string, unknown> => Boolean(v && typeof v === 'object'))
        .map((v) => ({
            asset: String(v.asset ?? '').toUpperCase().replace('WTI', 'OIL') as TrackedAsset,
            score: score(v.score),
            reason: String(v.reason ?? '').slice(0, 500),
        }))
        .filter((v) => TRACKED_ASSETS.includes(v.asset));
    const requestedRelation = enumValue(r.eventRelation, FFE_EVENT_RELATIONS, 'NEW_EVENT');
    const fundamentalCause = String(r.fundamentalCause ?? '') || null;
    const eventType = eventTypeFor(category, r.eventType);
    const eventRelation = category === 'ECONOMIC' || eventType === 'MACRO_RELEASE'
        ? 'MACRO_RELEASE'
        : category === 'IRRELEVANT'
            ? 'IRRELEVANT'
            : eventType === 'FORECAST'
                ? 'FORECAST_UPCOMING'
                : eventType === 'PRICE_REACTION'
                    ? 'PRICE_REACTION'
                    : requestedRelation;
    const observedMarketReaction = r.observedMarketReaction == null ? null : String(r.observedMarketReaction).slice(0, 500);
    const eventStrength = enumValue(r.eventStrength, ['NONE', 'WEAK', 'MODERATE', 'STRONG'] as const, impact === 'High' ? 'STRONG' : impact === 'Medium' ? 'MODERATE' : 'WEAK');
    const eventSeverity = boundedContractMetric(r.eventSeverity, impact === 'High' ? 1 : impact === 'Medium' ? 0.5 : 0.25);
    const confidenceNumber = Number(r.confidence);
    const confidence = Number.isFinite(confidenceNumber) ? Math.max(0, Math.min(1, confidenceNumber)) : 0;
    const eventCredibility = boundedContractMetric(r.eventCredibility, confidence);
    const eventFreshness = boundedContractMetric(r.eventFreshness, 1);
    const eventPersistence = boundedContractMetric(r.eventPersistence, eventStrength === 'STRONG' ? 0.8 : eventStrength === 'MODERATE' ? 0.5 : 0.25);
    const themeAction = enumValue(r.themeAction, ['CREATE', 'UPDATE', 'JOIN', 'NEW_OPPOSING_THEME', 'NONE'] as const, 'NONE');
    const themeRaw = r.themeDecision && typeof r.themeDecision === 'object'
        ? r.themeDecision as Record<string, unknown>
        : {};
    const canonicalThemeAction = enumValue(
        themeRaw.action,
        ['JOIN_EXISTING_THEME', 'UPDATE_EXISTING_THEME', 'REVERSE_EXISTING_THEME', 'CREATE_NEW_THEME', 'CONTEXT_ONLY', 'MACRO_ONLY', 'IRRELEVANT'] as const,
        themeAction === 'JOIN' ? 'JOIN_EXISTING_THEME' : themeAction === 'UPDATE' ? 'UPDATE_EXISTING_THEME' : themeAction === 'CREATE' || themeAction === 'NEW_OPPOSING_THEME' ? 'CREATE_NEW_THEME' : category === 'ECONOMIC' ? 'MACRO_ONLY' : category === 'IRRELEVANT' ? 'IRRELEVANT' : 'CONTEXT_ONLY',
    );
    const canonicalThemeAssets = (Array.isArray(themeRaw.assetContributions) ? themeRaw.assetContributions : assets)
        .filter((v): v is Record<string, unknown> => Boolean(v && typeof v === 'object'))
        .map((v) => {
            const asset = String(v.asset ?? '').toUpperCase().replace('WTI', 'OIL') as TrackedAsset;
            const themeScore = score(v.score);
            const themeRole = role(v.role);
            return {
                asset,
                bias: bias(v.bias),
                score: themeRole === 'CONFIRMATION' ? 0 : themeScore,
                role: themeRole,
                reason: String(v.reason ?? '').slice(0, 500),
            } as ClassifiedAsset;
        })
        .filter((v) => TRACKED_ASSETS.includes(v.asset));
    const geoState = enumValue(r.geoState, ['ESCALATION', 'DE_ESCALATION', 'WATCH', 'IRRELEVANT'] as const, 'IRRELEVANT') as GeoState;
    const semanticDirection = enumValue(r.semanticDirection, ['BULLISH', 'BEARISH', 'NEUTRAL', 'MIXED'] as const, 'NEUTRAL') as SemanticDirection;
    const semanticStrength = enumValue(r.semanticStrength, ['NONE', 'WEAK', 'MODERATE', 'STRONG'] as const, 'NONE') as SemanticStrength;
    const transmissionReason = r.transmissionReason == null ? '' : String(r.transmissionReason).slice(0, 1000);
    const counterEvidence = Array.isArray(r.counterEvidence) ? r.counterEvidence.map(String).slice(0, 32) : [];
    const evidenceText = [headline, fundamentalCause ?? '', transmissionReason, ...counterEvidence, ...assets.map((asset) => asset.reason ?? '')].join(' ').toLowerCase();
    const conditional = /\b(?:conditional|unconfirmed|unverified|rumou?r|speculat(?:ive|ion)|possible|potential|could|may|mulls?|mulling|prepar(?:e|ation)|planned|expected|sources?\s+(?:say|report)|reported)\b/.test(evidenceText);
    const directShock = /\b(?:confirmed|hit|struck|attack(?:ed)?|damage|damaged|casualt(?:y|ies)|closed|blockade|blocked|interrupted|supply disruption|production cut|intervention|officially)\b/.test(evidenceText);
    if (conditional) {
        conditionalEvidence = true;
        for (const asset of assets) {
            if (asset.role === 'CONFIRMATION' || asset.score === 0) continue;
            if (Math.abs(asset.score) >= 1) {
                // A conditional/preparatory statement cannot carry the strongest score. If
                // there is no confirmed direct shock, keep it watch-only rather than inventing
                // an active Catalyst driver.
                asset.score = directShock ? Math.sign(asset.score) * 0.5 : 0;
                asset.bias = asset.score > 0 ? 'Bullish' : asset.score < 0 ? 'Bearish' : 'Neutral';
            }
        }
    }
    const contractFailure = contractTransmissionFailure(category, eventType, eventRelation, fundamentalCause ?? '', assets, transmissionReason);
    const normalizedAssets = category === 'IRRELEVANT'
        ? []
        : assets.map((a) => ({ ...a, score: a.role === 'CONFIRMATION' || ZERO_CONTRIBUTION_RELATIONS.has(eventRelation) ? 0 : a.score }));
    const structuralInvalid = category === 'IRRELEVANT' && assets.length > 0
        || assets.some((a) => {
            if (a.role === 'CONFIRMATION') return false;
            const rawAsset = rawAssetRows.find((raw) => String(raw.asset ?? '').toUpperCase().replace('OIL (WTI)', 'OIL').replace('WTI', 'OIL') === a.asset);
            const rawValue = rawAsset?.score;
            return rawScore(rawValue) == null || ![-1, -0.5, -0.25, 0, 0.25, 0.5, 1].includes(Number(rawValue));
        })
        || contractFailure;
    const reasonScoreFailure = assets.some((asset) => {
        if (!asset.score || !asset.reason) return false;
        const reason = asset.reason.toLowerCase();
        const positive = /\b(?:bullish|supports?|supportive|higher|upside|strengthen|boost|benefit|rally)\b/.test(reason);
        const negative = /\b(?:bearish|weighs?|negative|lower|downside|weakens?|drag|pressure|eases?|relief|falls?)\b/.test(reason);
        return (asset.score > 0 && negative && !positive) || (asset.score < 0 && positive && !negative);
    });
    if (reasonScoreFailure) signBiasFailure = true;
    const requestedCatalyst = Boolean(r.catalystEligible) && category !== 'ECONOMIC' && category !== 'IRRELEVANT';
    const candidateContributions = normalizedAssets.filter((a) => a.role !== 'CONFIRMATION' && a.score !== 0);
    // catalystEligible=true with no current contribution is invalid state. It is represented as
    // review/watch evidence, never as an active zero-valued driver.
    const catalystEligible = requestedCatalyst && !contractFailure && !structuralInvalid && candidateContributions.length > 0;

    const macroValuesRaw = r.macroValues && typeof r.macroValues === 'object' ? r.macroValues as Record<string, unknown> : {};

    // Deterministic contract transmission.
    const contractDriver = ZERO_CONTRIBUTION_RELATIONS.has(eventRelation) || category === 'IRRELEVANT'
        ? null
        : deriveCommodityInventoryTransmission({ headline, actual: macroValuesRaw.actual as string | null, forecast: macroValuesRaw.forecast as string | null, previous: macroValuesRaw.previous as string | null })
        ?? (category === 'ECONOMIC'
            ? null
            : deriveContractTransmission({
                category,
                eventType,
                geoState,
                headline,
                evidenceText,
                conditional: conditionalEvidence,
                directShock,
                modelAssets: assets,
            }));

    let validatedCatalystEligible: boolean;
    let currentAssetContributions: ClassifiedAsset[];
    let contractTransmissionApplied = false;
    if (contractDriver && contractDriver.contributions.length > 0) {
        // The contract transmission is internally sign-consistent and score-bounded by construction,
        // so it recovers a valid driver even when the model dropped the event to watch/zero.
        contractTransmissionApplied = true;
        validatedCatalystEligible = true;
        currentAssetContributions = contractDriver.contributions;
    } else {
        validatedCatalystEligible = catalystEligible && !signBiasFailure;
        currentAssetContributions = structuralInvalid || category === 'ECONOMIC' || category === 'IRRELEVANT' || !validatedCatalystEligible
            ? []
            : candidateContributions;
    }
    return {
        index,
        category,
        impact,
        assets: normalizedAssets,
        summary: String(r.summary ?? r.reason ?? '').slice(0, 1000),
        reason: String(r.reason ?? r.summary ?? '').slice(0, 1000),
        driverTheme: String(r.driverTheme ?? '') || null,
        causalThemeId: String(r.causalThemeId ?? '') || null,
        geoState,
        semanticDirection,
        semanticStrength,
        directAssetSignals: normalizedAssets.filter((a) => a.role === 'DIRECT').map((a) => ({ asset: a.asset, bias: a.bias, score: a.score, role: a.role, reason: a.reason })),
        transmittedAssetSignals: normalizedAssets.filter((a) => a.role === 'TRANSMITTED').map((a) => ({ asset: a.asset, bias: a.bias, score: a.score, role: a.role, reason: a.reason })),
        signValidationStatus: contractTransmissionApplied ? 'PASS' : structuralInvalid || signBiasFailure ? 'FAILED' : 'PASS',
        catalystVisible: contractTransmissionApplied || (validatedCatalystEligible && !contractFailure && normalizedAssets.some((a) => a.role !== 'CONFIRMATION' && a.score !== 0)),
        fundamentalCause,
        eventRelation,
        eventDuplicateOf: r.eventDuplicateOf == null ? null : String(r.eventDuplicateOf),
        eventType,
        observedMarketReaction,
        eventStrength,
        eventSeverity,
        eventCredibility,
        eventFreshness,
        eventPersistence,
        transmissionReason: transmissionReason || null,
        counterEvidence,
        currentAssetContributions,
        contractTransmissionFamily: contractTransmissionApplied && contractDriver ? contractDriver.family : null,
        supportingGuidIds: Array.isArray(r.supportingGuidIds) ? r.supportingGuidIds.map(String).slice(0, 64) : [],
        confirmationGuidIds: Array.isArray(r.confirmationGuidIds) ? r.confirmationGuidIds.map(String).slice(0, 64) : [],
        macroValues: {
            actual: macroValuesRaw.actual == null ? null : String(macroValuesRaw.actual).slice(0, 120),
            forecast: macroValuesRaw.forecast == null ? null : String(macroValuesRaw.forecast).slice(0, 120),
            previous: macroValuesRaw.previous == null ? null : String(macroValuesRaw.previous).slice(0, 120),
        },
        causalThemeSummary: r.causalThemeSummary == null ? null : String(r.causalThemeSummary).slice(0, 500),
        themeAction,
        themeDecision: {
            action: canonicalThemeAction,
            themeId: themeRaw.themeId == null ? null : String(themeRaw.themeId),
            themeKey: themeRaw.themeKey == null ? (String(r.causalThemeId ?? '') || null) : String(themeRaw.themeKey),
            label: themeRaw.label == null ? (String(r.driverTheme ?? '') || null) : String(themeRaw.label),
            summary: themeRaw.summary == null ? (r.causalThemeSummary == null ? null : String(r.causalThemeSummary).slice(0, 1000)) : String(themeRaw.summary).slice(0, 1000),
            reason: String(themeRaw.reason ?? r.reason ?? r.summary ?? '').slice(0, 1000),
            status: enumValue(themeRaw.status, ['ACTIVE', 'WATCH', 'RESOLVED', 'REVERSED'] as const, 'ACTIVE'),
            assetContributions: canonicalThemeAssets,
        },
        macro: {
            eligible: Boolean(macroRaw.eligible),
            family: macroRaw.family == null ? null : String(macroRaw.family),
            directionSummary: macroRaw.directionSummary == null ? null : String(macroRaw.directionSummary).slice(0, 500),
            assetScores: macroAssetScores,
        },
        catalystEligible: validatedCatalystEligible,
        confidence,
        // Low confidence/sign contradictions are reviewable; a model's conservative
        // needsReview flag alone must not send nearly every normal row through another paid call.
        needsReview: confidence < 0.45 || structuralInvalid || signBiasFailure || conditionalEvidence || !catalystEligible && requestedCatalyst,
        decisionSource: 'ai_primary',
        promptVersion: FFE_ANALYST_PROMPT_VERSION,
        structuralValidationStatus: structuralInvalid ? 'FAILED' : 'PASS',
    };
}

function hasAiDecisionContradiction(row: ClassifiedHeadline): boolean {
    if (!row.macro) return false;
    const macroByAsset = new Map(row.macro.assetScores.map((asset) => [asset.asset, asset.score]));
    return row.assets.some((asset) => {
        const macroScore = macroByAsset.get(asset.asset);
        return macroScore != null && macroScore !== 0 && asset.score !== 0 && Math.sign(macroScore) !== Math.sign(asset.score);
    });
}

/** The model's reason and signed contribution must agree; this is a structural semantic check,
 * not a headline keyword-to-score rule. Contradictions are sent to one bounded adjudication pass. */
function hasReasonScoreContradiction(row: ClassifiedHeadline): boolean {
    return row.assets.some((asset) => {
        if (!asset.score || !asset.reason) return false;
        const reason = asset.reason.toLowerCase();
        const positive = /\b(?:bullish|supports?|supportive|higher|upside|strengthen|boost|benefit)\b/.test(reason);
        const negative = /\b(?:bearish|weighs?|negative|lower|downside|weakens?|drag|pressure|eases?|relief)\b/.test(reason);
        if (positive && negative) return false;
        return (asset.score > 0 && negative) || (asset.score < 0 && positive);
    });
}

const ZERO_CONTRIBUTION_RELATIONS = new Set<FfeEventRelation>([
    'SAME_EVENT', 'CONFIRMATION', 'PRICE_REACTION', 'HISTORICAL_COMMENTARY',
    'MACRO_RELEASE', 'FORECAST_UPCOMING', 'IRRELEVANT', 'CONTEXT_ONLY' as FfeEventRelation,
]);

function boundedContractMetric(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function eventTypeFor(category: NewsCategory, value: unknown): FfeEventType {
    const token = String(value ?? '').toUpperCase();
    if (FFE_EVENT_TYPES.includes(token as FfeEventType)) return token as FfeEventType;
    return category === 'ECONOMIC' ? 'MACRO_RELEASE' : category === 'GEOPOLITICAL' ? 'GEOPOLITICAL' : 'OTHER';
}

/**
 * Contract hard gates. These are declared-cause/transmission checks, not a headline-to-score
 * classifier. They prevent a structurally valid response from making an impossible transmission
 * claim, while preserving the raw AI decision for audit and review.
 */
function contractTransmissionFailure(
    category: NewsCategory,
    eventType: FfeEventType,
    eventRelation: FfeEventRelation,
    fundamentalCause: string,
    assets: ClassifiedAsset[],
    transmissionReason = '',
): boolean {
    if (category === 'ECONOMIC' || category === 'IRRELEVANT' || ZERO_CONTRIBUTION_RELATIONS.has(eventRelation)) return false;
    const cause = fundamentalCause.toLowerCase();
    const declaredTransmission = transmissionReason.toLowerCase();
    const currencyAssets = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']);
    for (const asset of assets) {
        if (asset.role === 'CONFIRMATION' || asset.score === 0) continue;
        if ((/dovish|eas(?:e|ing)|rate cuts?|cutting rates?|falling hike probability|lower hike probability/.test(cause)
            && currencyAssets.has(asset.asset) && asset.score > 0)
            || (/hawkish|tighten(?:ing)?|rate hikes?|higher hike probability/.test(cause)
                && currencyAssets.has(asset.asset) && asset.score < 0)) return true;
        if (asset.asset === 'OIL' && !(/oil|crude|wti|brent|hormuz|strait|shipping|supply|production|inventory|export/.test(cause)
            || eventType === 'OIL_SUPPLY')) return true;
        if ((asset.asset === 'AUD' || asset.asset === 'NZD') && /\bchina\b/.test(cause)
            && !/demand|growth|imports?|exports?|industrial|commodity|metals?/.test(cause)) return true;
        if ((asset.asset === 'JPY' || asset.asset === 'CHF' || asset.asset === 'GOLD')
            && category === 'GEOPOLITICAL'
            && !/haven|safe|risk[- ]off|real yield|gold|safe[- ]haven/.test(cause)) return true;
        const reason = `${declaredTransmission} ${asset.reason ?? ''}`;
        const genericOnly = /\b(?:risk sentiment|liquidity plumbing|counterpart(?:y)?|country association|broad spillover|possible transmission|may transmit|generic)\b/.test(reason)
            && !/\b(?:yield|rate|policy|safe.?haven|risk[- ]off|shipping|crude|oil|supply|trade|import|export|terms[- ]of[- ]trade|intervention|route|insurance|production)\b/.test(reason);
        if (genericOnly) return true;
    }
    return false;
}

/**
 * Deterministic FFE contract transmission (client contract §12–§24, developer instruction §5/§11).
 *
 * The model is the semantic authority: it decides the fundamental cause, event type, geopolitical
 * state and whether the evidence is confirmed vs conditional. THIS function is the deterministic
 * application-code authority for which tracked assets a recognized contract driver transmits to and
 * with what sign/magnitude. It exists because a probabilistic classifier cannot reliably enumerate
 * six-to-ten correct per-asset contributions for every event; leaving that to the model produced a
 * board that swung run-to-run with no code change. When a headline resolves to one of the contract's
 * standard causal families we replace the model's ad-hoc asset list with the contract transmission
 * table so the same news always yields the same, explainable, reconstructable driver — exactly the
 * behaviour the client GPT reproduces.
 *
 * It returns null for anything outside the recognized families, leaving the model's own contributions
 * untouched. It is generic (keyed on semantic cause families, never on a date, GUID or headline text
 * literal) and it never fabricates a strong contribution from conditional/unconfirmed evidence.
 */
export function deriveContractTransmission(input: {
    category: NewsCategory;
    eventType: FfeEventType;
    geoState: GeoState;
    headline: string;
    evidenceText: string;
    conditional: boolean;
    directShock: boolean;
    modelAssets: ClassifiedAsset[];
}): { contributions: ClassifiedAsset[]; family: string } | null {
    const { category, eventType, geoState } = input;
    if (category === 'ECONOMIC' || category === 'IRRELEVANT') return null;
    const text = `${input.headline} ${input.evidenceText}`.toLowerCase();

    // Conditional / preparatory / rumour language with no confirmed operational shock stays weak.
    // Never synthesize a full contract transmission from an unconfirmed "mulls/plans/threat" line.
    if (input.conditional && !input.directShock) return null;

    const dirShock = input.directShock;

    // (1) Crude supply / strategic-route disruption → OIL supply driver (§22, §18, §16, §14).
    //     A confirmed vessel hit / route interruption / blockade / export halt transmits OIL up to
    //     +1, CAD +0.5..+1, JPY -0.5 (importer/terms-of-trade), EUR -0.25 (importer/growth). A
    //     confirmed reopening / clearance / restoration reverses the sign.
    const crudeContext = /\b(crude|wti|brent|oil|opec|petroleum|tanker|tankers|refiner|pipeline|oilfield|oil field|export terminal|lng)\b/.test(text)
        || /\b(strait of hormuz|hormuz|red sea|shipping route|strategic (?:shipping|route)|chokepoint)\b/.test(text);
    const disruption = /\b(disrupt|closure|closed|blockade|block(?:ed|ing)?|attack|hit|struck|damage|casualt|halt|suspend|seiz|mine|projectile|explosion|interrupt|export (?:ban|halt|cut))\b/.test(text);
    const restoration = /\b(reopen|re-open|restor|resum|cleared|removed|lifted|eased|de-?escalat|ceasefire|open(?:ed|ing)? (?:again|to traffic|normally))\b/.test(text);
    if (crudeContext && dirShock && (disruption || restoration)) {
        const bullish = disruption && !restoration;
        const major = /\b(major|sustained|closure|closed|blockade|shut|halt|casualt|sank|sunk|severe|significant|damage)/.test(text);
        const contributions = bullish
            ? [
                catalystAsset('OIL', major ? 1 : 0.5),
                catalystAsset('CAD', major ? 1 : 0.5),
                catalystAsset('JPY', -0.5),
                catalystAsset('EUR', -0.25),
            ]
            : [
                catalystAsset('OIL', major ? -1 : -0.5),
                catalystAsset('CAD', major ? -1 : -0.5),
                catalystAsset('JPY', 0.25),
            ];
        return { contributions, family: 'OIL_SUPPLY_SHOCK' };
    }

    // (2) Systemic geopolitical currency transmission is a REGIME-level quantity (§24, §35: "Geo is a
    //     dominant-theme regime assessment. Do not sum every headline."). It is NOT scored per
    //     headline here — otherwise the earlier oil-supply branch shadows most Middle-East escalations
    //     and the only headlines reaching a per-event geo branch are scattered de-escalations, which
    //     inverts the sign. The single net geo risk-premium driver is derived once from the final geo
    //     regime by deriveGeoRiskPremium() and injected into Catalyst aggregation.

    // (3) Central-bank / rate / yield repricing → the directly repriced currency (§12, §13).
    //     A confirmed US-yield / Fed repricing also transmits to GOLD once (§21).
    if (eventType === 'CENTRAL_BANK' || eventType === 'RATE_REPRICING' || eventType === 'YIELD_REPRICING') {
        const hawkish = /\b(hawkish|tighten|rate hike|higher for longer|hike probability rising|cut probability falling|yields? (?:rise|higher|repric(?:e|ing) higher)|stronger inflation|inflation (?:above|hot|sticky))\b/.test(text);
        const dovish = /\b(dovish|eas(?:e|ing)|rate cut|cut(?:ting)? rates?|hike probability falling|cut probability rising|yields? (?:fall|lower)|slower growth|disinflation)\b/.test(text);
        if (hawkish === dovish) return null;
        const strong = /\b(sharp|aggressive|major|fully pric|clear shift|material)\b/.test(text);
        const magnitude = strong ? 1 : 0.5;
        const sign = hawkish ? 1 : -1;
        // Identify the repriced currency from the model's own assets or the declared cause.
        const bankAsset = centralBankToAsset(input.headline)
            ?? input.modelAssets.find((asset) => asset.asset !== 'GOLD' && asset.asset !== 'OIL' && asset.score !== 0)?.asset
            ?? 'USD';
        const contributions: ClassifiedAsset[] = [catalystAsset(bankAsset as CatalystCurrency, sign * magnitude)];
        const isUsYield = bankAsset === 'USD' && (/\b(fed|fomc|powell|treasury|us yield|real yield|dollar)\b/.test(text) || eventType === 'YIELD_REPRICING');
        if (isUsYield) contributions.push(catalystAsset('GOLD', sign * -0.5));
        return { contributions, family: 'RATE_YIELD_REPRICING' };
    }

    // (4) China growth / industrial-metals and dairy transmissions (§19, §20).
    if (eventType === 'CHINA_DEMAND') {
        const stronger = /\b(stimulus|rebound|upgrade|improv|stronger|surge|recovery|beat)\b/.test(text);
        const weaker = /\b(downgrade|deteriorat|weak|slump|contraction|miss|crisis|slow)\b/.test(text);
        if (stronger !== weaker) {
            const sign = stronger ? 1 : -1;
            const major = /\b(major|large|strong|sharp|significant)\b/.test(text);
            return { contributions: [catalystAsset('AUD', sign * (major ? 1 : 0.5)), catalystAsset('NZD', sign * 0.25)], family: 'CHINA_DEMAND' };
        }
    }
    if (eventType === 'DAIRY') {
        const up = /\b(rise|rises|gains?|surge|higher|up)\b/.test(text);
        const down = /\b(fall|falls?|drop|plunge|lower|down)\b/.test(text);
        if (up !== down) return { contributions: [catalystAsset('NZD', up ? 0.5 : -0.5)], family: 'DAIRY' };
    }

    return null;
}

/** Generic commodity inventory surprise — any agency wording with Actual/Forecast materiality. */
export function deriveCommodityInventoryTransmission(input: {
    headline: string;
    actual?: string | null;
    forecast?: string | null;
    previous?: string | null;
}): { contributions: ClassifiedAsset[]; family: string } | null {
    const text = input.headline.toLowerCase();
    if (!/\b(inventor(?:y|ies)|stockpile|stock change|storage)\b/.test(text)) return null;
    if (!/\b(crude|oil|petroleum|gasoline|distillate|cushing|wti|brent)\b/.test(text)) return null;
    const parsed = /\bactual\s+([^\s(]+)\s*\(\s*forecast\s+([^,)]*),\s*previous\s+([^)]*)\)/i.exec(input.headline);
    const actualRaw = input.actual ?? parsed?.[1] ?? null;
    const forecastRaw = input.forecast ?? parsed?.[2] ?? null;
    if (!actualRaw || !forecastRaw || forecastRaw.trim() === '-' || forecastRaw.trim() === '') return null;
    const actual = Number.parseFloat(String(actualRaw).replace(/[^0-9.+-]/g, ''));
    const forecast = Number.parseFloat(String(forecastRaw).replace(/[^0-9.+-]/g, ''));
    if (!Number.isFinite(actual) || !Number.isFinite(forecast)) return null;
    const surprise = actual - forecast;
    if (Math.abs(surprise) < 0.01) return null;
    const build = actual > forecast;
    const major = Math.abs(surprise) >= Math.max(Math.abs(forecast) * 0.5, 1);
    const oilScore = build ? (major ? -0.5 : -0.25) : (major ? 0.5 : 0.25);
    return {
        family: 'COMMODITY_INVENTORY_SHOCK',
        contributions: [
            catalystAsset('OIL', oilScore),
            catalystAsset('CAD', oilScore > 0 ? (major ? 0.5 : 0.25) : (major ? -0.5 : -0.25)),
            catalystAsset('JPY', oilScore > 0 ? -0.25 : 0.25),
            catalystAsset('EUR', oilScore > 0 ? -0.25 : 0.25),
        ],
    };
}

/**
 * The single systemic geopolitical risk-premium Catalyst driver (client contract §24 + §35). Geo is
 * a dominant-theme REGIME assessment judged from severity/credibility/persistence — not from a raw
 * count of escalation vs de-escalation theme labels. The net regime score already embeds bounded
 * de-escalation deductions from calculateGeopoliticalRisk().
 */
export function deriveGeoRiskPremium(input: {
    score: number;
    escalationCount: number;
    deEscalationCount: number;
    confirmed: boolean;
    havenConfirmed?: boolean;
    supportingThemes?: string[];
    supportingEventIds?: string[];
    supportingGuids?: string[];
}): {
    contributions: ClassifiedAsset[];
    family: string;
    provenance: { supportingThemes: string[]; supportingEventIds: string[]; supportingGuids: string[] };
} | null {
    if (!input.confirmed || input.score < 0.41) return null;
    const contributions = [
        catalystAsset('USD', 0.5),
        catalystAsset('CHF', 0.5),
        catalystAsset('EUR', -0.25),
        catalystAsset('GBP', -0.25),
        catalystAsset('AUD', -0.5),
        catalystAsset('NZD', -0.5),
    ];
    if (input.havenConfirmed) contributions.push(catalystAsset('JPY', 0.5));
    return {
        contributions,
        family: 'GEO_RISK_PREMIUM',
        provenance: {
            supportingThemes: [...new Set(input.supportingThemes ?? [])],
            supportingEventIds: [...new Set(input.supportingEventIds ?? [])],
            supportingGuids: [...new Set(input.supportingGuids ?? [])],
        },
    };
}

/** Accepted canonical evidence for the day-level US yield-repricing driver. */
export type YieldRepricingEvidence = {
    headline: string;
    actual?: string | null;
    previous?: string | null;
    eventType?: string | null;
    category?: string | null;
    contractFamily?: string | null;
    eventRelation?: string | null;
    valid?: boolean;
    catalystEligible?: boolean;
    status?: string;
    eventId?: string | null;
    supportingGuids?: string[];
};

const YIELD_COMMENTARY_PATTERN = /\b(deutsche bank|goldman|barclays|nomura|analyst|commentary|research note|report says|according to sources|fjelite|stalemate pushes|pushes oil and)\b/i;
const YIELD_FUNDING_ONLY_PATTERN = /\b(sofr|secured overnight financing|effective fed funds|fed funds rate)\b/i;
const YIELD_US_BENCHMARK_PATTERN = /\b(us treasury|u\.s\. treasury|treasury yield|ust\b|us\s+\d+\s*(?:yr|year)|10[- ]?year treasury|long[- ]?end yields?|us real yields?|real yields?)\b/i;
const YIELD_US_RATE_EVENT_TYPES = new Set(['YIELD_REPRICING', 'RATE_REPRICING', 'CENTRAL_BANK']);
const YIELD_PRINCIPAL_FREE_RELATIONS = new Set(['IRRELEVANT', 'HISTORICAL_COMMENTARY', 'MACRO_RELEASE', 'FORECAST_UPCOMING', 'PRICE_REACTION', 'SAME_EVENT', 'CONFIRMATION']);

function acceptedCanonicalYieldEvidence(item: YieldRepricingEvidence): boolean {
    if (item.status && item.status !== 'ACTIVE') return false;
    if (item.valid === false || item.catalystEligible === false) return false;
    const relation = String(item.eventRelation ?? '').toUpperCase();
    if (YIELD_PRINCIPAL_FREE_RELATIONS.has(relation)) return false;
    if (item.category === 'ECONOMIC' || item.category === 'IRRELEVANT') return false;
    if (item.eventType === 'COMMENTARY' || item.eventType === 'MACRO_RELEASE') return false;
    if (YIELD_COMMENTARY_PATTERN.test(item.headline)) return false;
    if (item.contractFamily === 'RATE_YIELD_REPRICING') return true;
    if (item.eventType && YIELD_US_RATE_EVENT_TYPES.has(item.eventType)) {
        return YIELD_US_BENCHMARK_PATTERN.test(item.headline)
            || /\b(fed|fomc|powell|federal reserve)\b/i.test(item.headline);
    }
    return false;
}

/**
 * The single US rate/yield repricing Catalyst driver (client contract §12, §13, §21, §47).
 * Derived only from accepted ACTIVE canonical evidence — never from a side-channel scan of every
 * headline. SOFR/funding-rate wiggles and analyst/bank commentary alone do not qualify.
 */
export function deriveYieldRepricingDriver(
    evidence: YieldRepricingEvidence[],
    _legacyOptions?: { looseFundingTicks?: boolean; fundingMinBps?: number; benchmarkMinBps?: number },
): {
    contributions: ClassifiedAsset[];
    family: string;
    direction: 'HAWKISH' | 'DOVISH';
    reason: string;
    supportingEventIds: string[];
    supportingGuids: string[];
} | null {
    const benchmarkMinBps = 8;
    let hawkish = 0;
    let dovish = 0;
    const reasons: string[] = [];
    const supportingEventIds: string[] = [];
    const supportingGuids: string[] = [];
    for (const item of evidence.filter(acceptedCanonicalYieldEvidence)) {
        const text = item.headline;
        const actual = item.actual != null ? Number.parseFloat(String(item.actual)) : null;
        const previous = item.previous != null ? Number.parseFloat(String(item.previous)) : null;
        if (actual != null && previous != null && Number.isFinite(actual) && Number.isFinite(previous)) {
            const bps = (actual - previous) * (Math.abs(actual) <= 1 && Math.abs(previous) <= 1 ? 100 : 1);
            if (bps >= benchmarkMinBps) {
                hawkish += 1;
                reasons.push(`confirmed US yield print +${bps.toFixed(0)}bps (${actual} vs ${previous})`);
                if (item.eventId) supportingEventIds.push(item.eventId);
                supportingGuids.push(...(item.supportingGuids ?? []));
                continue;
            }
            if (bps <= -benchmarkMinBps) {
                dovish += 1;
                reasons.push(`confirmed US yield print ${bps.toFixed(0)}bps (${actual} vs ${previous})`);
                if (item.eventId) supportingEventIds.push(item.eventId);
                supportingGuids.push(...(item.supportingGuids ?? []));
                continue;
            }
        }
        // Funding-rate-only prints never qualify — even when canonical.
        if (YIELD_FUNDING_ONLY_PATTERN.test(text) && !YIELD_US_BENCHMARK_PATTERN.test(text)) continue;
        if (!YIELD_US_BENCHMARK_PATTERN.test(text) && !/\b(fed|fomc|powell|federal reserve)\b/i.test(text)) continue;
        const pcts = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)].map((m) => Number.parseFloat(m[1]!));
        if (pcts.length >= 2 && YIELD_US_BENCHMARK_PATTERN.test(text)) {
            const bps = (pcts[0]! - pcts[1]!) * 100;
            if (bps >= benchmarkMinBps) {
                hawkish += 1;
                reasons.push(`confirmed US benchmark yield +${bps.toFixed(0)}bps: "${text.slice(0, 60)}"`);
                if (item.eventId) supportingEventIds.push(item.eventId);
                supportingGuids.push(...(item.supportingGuids ?? []));
                continue;
            }
            if (bps <= -benchmarkMinBps) {
                dovish += 1;
                reasons.push(`confirmed US benchmark yield ${bps.toFixed(0)}bps: "${text.slice(0, 60)}"`);
                if (item.eventId) supportingEventIds.push(item.eventId);
                supportingGuids.push(...(item.supportingGuids ?? []));
                continue;
            }
        }
        const hawkText = /\b(hawkish|higher for longer|tighten(?:ing)?|hike(?:s)? (?:odds|probability|bets) (?:rising|up|higher)|cut(?:s)? (?:odds|probability|bets) (?:falling|down|lower)|sticky inflation|hot inflation|inflation (?:above|hotter|surpris\w+ higher)|yields? (?:jump|surge|spike|rise|higher|climb|reprice(?:d|s)? higher))\b/i.test(text);
        const dovText = /\b(dovish|rate cut(?:s)?|easing|cut(?:s)? (?:odds|probability|bets) (?:rising|up|higher)|hike(?:s)? (?:odds|probability|bets) (?:falling|down|lower)|disinflation|cooling inflation|yields? (?:fall|drop|lower|decline|slide|reprice(?:d|s)? lower))\b/i.test(text);
        if (hawkText && !dovText) {
            hawkish += 1;
            reasons.push(`confirmed US yield repricing: "${text.slice(0, 80)}"`);
            if (item.eventId) supportingEventIds.push(item.eventId);
            supportingGuids.push(...(item.supportingGuids ?? []));
        } else if (dovText && !hawkText) {
            dovish += 1;
            reasons.push(`confirmed US yield easing: "${text.slice(0, 80)}"`);
            if (item.eventId) supportingEventIds.push(item.eventId);
            supportingGuids.push(...(item.supportingGuids ?? []));
        }
    }
    if (hawkish === dovish) return null;
    const direction = hawkish > dovish ? 'HAWKISH' : 'DOVISH';
    const sign = direction === 'HAWKISH' ? 1 : -1;
    return {
        contributions: [catalystAsset('USD', sign * 0.5), catalystAsset('GOLD', sign * -0.5)],
        family: 'RATE_YIELD_REPRICING',
        direction,
        reason: reasons.join('; '),
        supportingEventIds: [...new Set(supportingEventIds)],
        supportingGuids: [...new Set(supportingGuids)],
    };
}

function coerceResult(
    raw: unknown,
    index: number,
    headline: string,
): Omit<ClassifiedHeadline, 'duplicateOfExistingId' | 'duplicateOfBatchIndex'> | null {
    return normalizeAiClassification(raw, index, headline);
}

async function adjudicateClassifications(
    rows: Array<{ index: number; headline: string; proposal: ClassifiedHeadline }>,
    options: { jobId?: string | null; ingestId?: string | null; recordUsage?: boolean },
): Promise<Map<number, ClassifiedHeadline>> {
    const out = new Map<number, ClassifiedHeadline>();
    if (!rows.length) return out;
    let validationFailure: string | null = null;
    const response = await requestJson(
        ADJUDICATION_SYSTEM_PROMPT,
        rows.map((row, index) => `LOCAL_INDEX=${index}\nHEADLINE: ${row.headline}\nPROPOSED: ${JSON.stringify(row.proposal)}`).join('\n\n'),
        {
            operationType: 'semantic_adjudication',
            jobId: options.jobId,
            ingestId: options.ingestId,
            schema: classificationResponseSchema(rows.length),
            schemaName: 'ffe_semantic_adjudication',
            // The canonical theme decision is intentionally structured, so reserve enough
            // output for every row instead of letting a valid response truncate and trigger
            // an expensive split/fallback cycle.
            maxOutputTokens: classificationOutputTokens(rows.length),
            recordUsage: options.recordUsage,
            validate: (value) => {
                validationFailure = completeClassificationResponseError(value, rows.length);
                return validationFailure === null;
            },
        },
    );
    if (!response) {
        logger.warn('[AIProvider] Bounded semantic adjudication unavailable', { reason: validationFailure ?? 'provider failure' });
        return out;
    }
    const parsed = response.parsed;
    for (const raw of Array.isArray(parsed.results) ? parsed.results : []) {
        const localIndex = Number((raw as Record<string, unknown>)?.i);
        const target = rows[localIndex];
        if (!target) continue;
        const normalized = normalizeAiClassification(raw, target.index, target.headline);
        if (!normalized) continue;
        normalized.decisionSource = 'ai_adjudication';
        normalized.provider = response.provider;
        normalized.model = response.model;
        normalized.needsReview = Number(normalized.confidence ?? 0) < 0.45 || normalized.signValidationStatus === 'FAILED';
        out.set(target.index, normalized as ClassifiedHeadline);
    }
    return out;
}

/**
 * Batch-classify headlines in one bounded provider call, including deduplication against `existingTopics`
 * and against each other within the batch. Returns [] on failure so the caller can skip this cycle.
 * Prefer HeadlineInput with publishedAt so [HH:MM] reaches the model for same-briefing judgment.
 */
export async function classifyHeadlines(
    headlines: Array<string | HeadlineInput>,
    existingTopics: ExistingTopic[] = [],
    options: { operationType?: AiOperationType; jobId?: string | null; ingestId?: string | null; recordUsage?: boolean; existingThemes?: ExistingCanonicalTheme[] } = {},
): Promise<ClassifiedHeadline[]> {
    if (headlines.length === 0) return [];

    const normalized = headlines.map(normalizeHeadlineInput);
    const headlineTexts = normalized.map((h) => h.text);

    const existingBlock = existingTopics.length
        ? '\n\nEXISTING topics already stored today (id: [HH:MM] text — Asia/Dubai when known):\n' +
          existingTopics.map((t) => formatPromptHeadlineLine(t.id, { text: t.text, publishedAt: t.publishedAt })).join('\n')
        : '\n\nEXISTING topics already stored today: (none yet)';

    const activeThemeCandidates = selectCanonicalThemeCandidates(options.existingThemes, headlineTexts);
    const activeThemeBlock = activeThemeCandidates.length
        ? '\n\nACTIVE CANONICAL THEMES (internal ids are code-owned; reference only exact ids):\n' +
          activeThemeCandidates.map((theme) => {
              const assets = theme.assets.map((asset) => `${asset.asset}:${asset.score}`).join(',');
              const updated = theme.lastUpdatedAt ? ` updated=${dubaiHhMm(theme.lastUpdatedAt) ?? ''}` : '';
              const eventIds = theme.supportingEventIds?.length ? ` events=${theme.supportingEventIds.join(',')}` : '';
              return `${theme.id} | key=${theme.themeKey} | label=${theme.label} | state=${theme.status} | score=[${assets}]${updated}${eventIds} | ${theme.summary}`;
          }).join('\n')
        : '\n\nACTIVE CANONICAL THEMES: (none yet; CREATE_NEW_THEME is allowed)';

    const canonicalEvents = activeThemeCandidates.flatMap((theme) => theme.events ?? [])
        .filter((event, index, all) => all.findIndex((candidate) => candidate.id === event.id) === index)
        .sort((a, b) => new Date(String(b.lastSeenAt ?? 0)).getTime() - new Date(String(a.lastSeenAt ?? 0)).getTime());
    const activeEventBlock = canonicalEvents.length
        ? '\n\nCANONICAL EVENT STATE (use exact event ids for every non-NEW_EVENT relation):\n' +
          canonicalEvents.map((event) => {
              const contributions = event.contributions.map((asset) => `${asset.asset}:${asset.score}/${asset.role ?? 'DIRECT'}`).join(',');
              const supports = event.supportingGuids?.length ? ` supporting=${event.supportingGuids.join(',')}` : '';
              const confirms = event.confirmationGuids?.length ? ` confirmations=${event.confirmationGuids.join(',')}` : '';
              return `${event.id} | theme=${event.themeId ?? 'unclassified'} | relation=${event.relation ?? 'NEW_EVENT'} | state=${event.status} | type=${event.eventType ?? 'OTHER'} | [${dubaiHhMm(event.lastSeenAt) ?? ''}] ${event.headline} | cause=${event.fundamentalCause ?? ''} | reaction=${event.observedMarketReaction ?? ''} | contributions=[${contributions}]${supports}${confirms}`;
          }).join('\n')
        : '\n\nCANONICAL EVENT STATE: (none yet; NEW_EVENT is allowed)';

    const userContent =
        'Classify these headlines (indices are for THIS batch; times are Asia/Dubai HH:MM when known):\n' +
        normalized.map((h, i) => formatPromptHeadlineLine(i, h)).join('\n') +
        existingBlock + activeThemeBlock + activeEventBlock;

    let validationFailure: string | null = null;
    const response = await requestJson(SYSTEM_PROMPT, userContent, {
        operationType: options.operationType ?? 'classification',
        jobId: options.jobId,
        ingestId: options.ingestId,
        schema: classificationResponseSchema(headlineTexts.length),
        schemaName: 'market_driver_classification',
        maxOutputTokens: classificationOutputTokens(headlineTexts.length),
        recordUsage: options.recordUsage,
        // A complete result per input is required. A malformed/partial primary response is sent
        // to the bounded Groq fallback rather than being silently persisted as partial data.
        validate: (value) => {
            validationFailure = completeClassificationResponseError(value, headlineTexts.length);
            if (validationFailure) logger.warn('[AIProvider] Classification structural validation failed', { reason: validationFailure });
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
        if (coerced) {
            coerced.provider = response.provider;
            coerced.model = response.model;
            coerced.decisionSource = response.provider === 'groq' ? 'ai_fallback' : 'ai_primary';
            baseByIndex.set(idx, coerced);
        }
    }

    // One bounded adjudication pass handles only low-confidence or internally contradictory AI
    // decisions. It never recurses and never runs on restart replay or healthy rows.
    const uncertain = [...baseByIndex.entries()]
        .map(([index, proposal]) => ({ index, headline: headlineTexts[index]!, proposal: proposal as ClassifiedHeadline }))
        .filter((row) => Number(row.proposal.confidence ?? 0) < 0.45
            || row.proposal.signValidationStatus === 'FAILED'
            || hasAiDecisionContradiction(row.proposal)
            || hasReasonScoreContradiction(row.proposal)
            || (row.proposal.themeDecision?.action.endsWith('EXISTING_THEME') && !row.proposal.themeDecision.themeId));
    if (uncertain.length > 0 && options.operationType !== 'semantic_adjudication') {
        const adjudicated = await adjudicateClassifications(uncertain, options);
        for (const [index, value] of adjudicated) baseByIndex.set(index, value);
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
