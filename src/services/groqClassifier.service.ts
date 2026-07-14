import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 45000;

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

export type NewsCategory = 'ECONOMIC' | 'DRIVER' | 'GEOPOLITICAL' | 'IRRELEVANT';
export type NewsImpact = 'High' | 'Medium' | 'Low';
export type AssetBias = 'Bullish' | 'Bearish' | 'Neutral' | 'Mixed';

export type ClassifiedAsset = {
    asset: TrackedAsset;
    bias: AssetBias;
    /** Market-driver impact score, doc §22: +1 / +0.5 / 0 / -0.5 / -1. */
    score: number;
};

/** An already-stored, non-duplicate headline from today the model can match new ones against. */
export type ExistingTopic = { id: string; text: string };

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
 * DESIGN: Groq is the primary classifier for ANY new wording. Sanitize is only a thin
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
4) per asset: bias Bullish|Bearish|Neutral|Mixed + score matching impact
   High± → ±1 · Medium± → ±0.5 · Low/Neutral/Mixed → 0
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
- Do NOT auto-add CAD on every oil story unless Canada/CAD/loonie/BoC is named.
- Do NOT auto-add USD/JPY/CHF safe-haven on every Iran headline unless risk-off/dollar/Fed is explicit.
- Escalation → bullish OIL/GOLD as relevant. De-escalation/talks → bearish OIL/GOLD or Neutral 0.

DEDUPLICATION (doc §3) — separate lists:
Same specific announcement restated = duplicate. Same region but different facts = NOT duplicate.
When unsure, do NOT mark duplicate.
- duplicateGroups: [[principal, dup, ...], ...]
- existingDuplicates: [{"i": batchIndex, "existingId": "id"}]

Respond ONLY with JSON:
{"results":[{"i":0,"category":"...","impact":"...","assets":[{"asset":"...","bias":"...","score":0}],"summary":"..."}],"duplicateGroups":[],"existingDuplicates":[]}
Every input index must appear exactly once in "results".`;

const DEDUP_ONLY_PROMPT = `You detect duplicate forex market headlines (doc §3).
Two headlines are duplicates ONLY when they report the SAME specific event/announcement/statement (including near-paraphrases from one briefing).
NOT duplicates = same region/topic but different facts.
When unsure, do NOT group them.

Return JSON only: {"duplicateGroups":[[principal, dup, ...], ...]}
Put the clearest/earliest index first in each group. Use [] if none.`;

type GroqResponse = {
    choices?: Array<{ message?: { content?: string } }>;
};

async function groqJson(system: string, user: string): Promise<Record<string, unknown> | null> {
    if (!ENV.GROQ_API_KEY) return null;
    if (isGroqDailyLimited()) {
        logger.warn(
            `[GroqClassifier] Skipping call — daily TPD cooldown ${Math.ceil(groqDailyLimitRemainingMs() / 60000)}m left`,
        );
        return null;
    }
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(GROQ_URL, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    Authorization: `Bearer ${ENV.GROQ_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: ENV.GROQ_MODEL,
                    temperature: 0,
                    response_format: { type: 'json_object' },
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: user },
                    ],
                }),
            });

            if (res.status === 429) {
                const body = (await res.text()).slice(0, 500);
                const { dailyTpd, waitMs } = noteGroq429(body);
                logger.error(`[GroqClassifier] Groq returned 429: ${body.slice(0, 300)}`);
                if (dailyTpd) return null; // do not burn remaining daily budget with short retries
                if (attempt < maxAttempts) {
                    const backoff = Math.max(waitMs, 5000 * attempt);
                    logger.warn(
                        `[GroqClassifier] Rate-limited (429); retrying in ${backoff}ms (attempt ${attempt}/${maxAttempts})`,
                    );
                    await new Promise((r) => setTimeout(r, backoff));
                    continue;
                }
                return null;
            }
            if (!res.ok) {
                logger.error(`[GroqClassifier] Groq returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
                return null;
            }
            const json = (await res.json()) as GroqResponse;
            const content = json.choices?.[0]?.message?.content;
            if (!content) return null;
            return JSON.parse(content) as Record<string, unknown>;
        } catch (error) {
            logger.error(`[GroqClassifier] Request failed: ${(error as Error).message}`);
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }
    return null;
}

/**
 * Dedicated same-event dedup pass (doc §3). Returns map of duplicateIndex → principalIndex.
 */
export async function findBatchDuplicateMap(headlines: string[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (headlines.length < 2) return out;

    const parsed = await groqJson(
        DEDUP_ONLY_PROMPT,
        'Find duplicate groups among:\n' + headlines.map((h, i) => `${i}. ${h.replace(/\s+/g, ' ').trim()}`).join('\n'),
    );
    if (!parsed) return out;

    for (const groupRaw of Array.isArray(parsed.duplicateGroups) ? parsed.duplicateGroups : []) {
        if (!Array.isArray(groupRaw) || groupRaw.length < 2) continue;
        const group = groupRaw
            .map((v) => Number(v))
            .filter((v) => Number.isInteger(v) && v >= 0 && v < headlines.length);
        if (group.length < 2) continue;
        const principal = group[0]!;
        for (const idx of group.slice(1)) {
            if (idx !== principal && !out.has(idx)) out.set(idx, principal);
        }
    }

    // Token-overlap + fingerprint backstop for near-paraphrases the model misses.
    for (let i = 0; i < headlines.length; i++) {
        if (out.has(i)) continue;
        for (let j = 0; j < i; j++) {
            if (out.has(j)) continue;
            if (likelySameEvent(headlines[i]!, headlines[j]!)) {
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
        /\b(centcom|u\.?s\.?\s+forces|us forces|u\.?s\.?\s+hits|us hits|cnn reports)\b/.test(h) &&
        /\b(strike|strikes|targets? hit|precision weapons|military (sites|targets)|coastal (defense|defence|surveillance)|missile and drone)\b/.test(
            h,
        )
    ) {
        return 'us-iran-military-strikes';
    }

    // Trump-on-Iran briefing bullets — split by distinct ask, collapse paraphrases of the same ask.
    if (/\btrump on iran\b/.test(h) || (/\btrump\b/.test(h) && /\biran\b/.test(h) && /\b(planning|seeks|believes|dismantl|targeting)\b/.test(h))) {
        if (/\b(strike|monday night|significant strike)\b/.test(h)) return 'trump-iran-strike-plan';
        if (/\b(deal|achievable|negotiat)\b/.test(h)) return 'trump-iran-deal';
        if (/\b(hormuz|compensation|shielding|toll|shipping)\b/.test(h)) return 'trump-iran-hormuz';
        if (/\b(dismantl|offensive strength|capabilit)/.test(h)) return 'trump-iran-capability';
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
    if (/\b(wti|brent|crude)\b/.test(h) && /\b(spike|spikes|advances?|forecast|four-week|near \$\d|middle east|hormuz)\b/.test(h)) {
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
    if (jac >= 0.55) return true;

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
 */
export function oilCatalystCluster(headline: string): string | null {
    const fp = eventFingerprint(headline);
    if (fp) {
        if (fp === 'iran-jordan-missile' || fp === 'bahrain-iran-alert' || fp === 'iran-gulf-spillover') {
            return 'iran-gulf-spillover';
        }
        // Same Hormuz supply-risk thread (official ask + tanker/IRGC wires).
        if (fp === 'trump-iran-hormuz' || fp === 'hormuz-shipping-disruption' || fp === 'iran-shipping-us-demands') {
            return 'hormuz-shipping-disruption';
        }
        // One Trump Iran briefing → one OIL catalyst (strike plan stays separate as escalation).
        if (fp === 'trump-iran-deal' || fp === 'trump-iran-capability' || fp === 'trump-iran-remarks') {
            return 'trump-iran-briefing';
        }
        return fp;
    }
    const h = headline.toLowerCase();
    if (/\b(ipsos|poll finds|% of americans)\b/.test(h) && /\biran/.test(h)) return 'iran-opinion-poll';
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

    const magnitude = impact === 'High' ? 1 : 0.5;
    const score = sign * magnitude;
    return { bias: score > 0 ? 'Bullish' : 'Bearish', score };
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
 * Keep Market Catalyst aligned with News Headline: oil/Hormuz wires show as OIL only,
 * so do not mirror the same scores onto CAD unless Canada/CAD is in the headline.
 */
export function stripImpliedCadFromOil(headline: string, assets: ClassifiedAsset[]): ClassifiedAsset[] {
    if (headlineSupportsCad(headline)) return assets;
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
        /\b(says|said|speech|guidance|minutes|chief economist|governor|president)\b/.test(h) ||
        /:/.test(h) ||
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
    if (/\b(pboc|people'?s bank of china)\b/.test(h)) return 'USD';
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
    // USD/CNY or yuan vs dollar still affects USD.
    if (/\b(yuan|cny|pboc|usd\/cny)\b/.test(h)) add('USD');
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
    if (!['High', 'Medium'].includes(input.impact)) return false;
    return Array.isArray(input.assets) && input.assets.length > 0;
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

    if (isDocIgnoredHeadline(headline) || isNonCrudeEnergyHeadline(headline)) {
        return {
            category: 'IRRELEVANT',
            impact: 'Low',
            assets: [],
            summary: isDocIgnoredHeadline(headline) ? 'Outside tracked-asset universe' : 'Non-crude energy product ignored',
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

    // Doc §4 A: scheduled data prints belong on Economic Calendar, not News Headline.
    if (isScheduledDataReleaseHeadline(headline) && !isFxMarketCommentaryHeadline(headline)) {
        category = 'ECONOMIC';
        // Keep whatever assets Groq assigned for Currency Health; board filters ECONOMIC out.
    }

    // Drop OIL tags with no crude / ME-energy basis (stops N Korea→OIL, local fire→OIL, etc.).
    if (assets.some((a) => a.asset === 'OIL') && !headlineSupportsOil(headline)) {
        assets = assets.filter((a) => a.asset !== 'OIL');
    }

    // Oil/Iran energy stories must not also credit USD/JPY/CHF unless the headline is a real USD driver.
    assets = stripWeakSafeHavenTags(headline, assets);
    assets = stripImpliedCadFromOil(headline, assets);

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

    // Universal §4 B: FX market wraps → DRIVER ≥ Medium with tracked assets.
    if (
        isFxMarketCommentaryHeadline(headline) &&
        !isScheduledDataReleaseHeadline(headline)
    ) {
        const hints = trackedAssetHintsFromHeadline(headline);
        if (hints.length > 0 || assets.length > 0) {
            if (category === 'ECONOMIC' || category === 'IRRELEVANT') category = 'DRIVER';
            if (impact === 'Low') impact = 'Medium';
            if (assets.length === 0 && hints.length > 0) {
                const bias = biasFromMoveLanguage(headline);
                const aligned = alignScoreToImpact(impact, bias, bias === 'Neutral' ? 0 : 0.5);
                assets = hints.slice(0, 2).map((asset) => ({ asset, bias: aligned.bias, score: aligned.score }));
            }
        }
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

    if (assets.length === 0) {
        category = 'IRRELEVANT';
        impact = 'Low';
    } else if (category === 'IRRELEVANT') {
        category = 'DRIVER';
        if (impact === 'Low') impact = 'Medium';
    }

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
        rawScore = Math.round(rawScore * 2) / 2;

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
 * Batch-classify headlines in one Groq call, including deduplication against `existingTopics`
 * and against each other within the batch. Returns [] on failure so the caller can skip this cycle.
 */
export async function classifyHeadlines(
    headlines: string[],
    existingTopics: ExistingTopic[] = [],
): Promise<ClassifiedHeadline[]> {
    if (headlines.length === 0) return [];
    if (!ENV.GROQ_API_KEY) {
        logger.error('[GroqClassifier] GROQ_API_KEY is not set — skipping classification');
        return [];
    }
    if (isGroqDailyLimited()) {
        logger.warn(
            `[GroqClassifier] Skipping batch of ${headlines.length} — daily TPD cooldown ${Math.ceil(groqDailyLimitRemainingMs() / 60000)}m left`,
        );
        return [];
    }

    const existingBlock = existingTopics.length
        ? '\n\nEXISTING topics already stored today (id: text):\n' +
        existingTopics.map((t) => `${t.id}: ${t.text.replace(/\s+/g, ' ').trim()}`).join('\n')
        : '\n\nEXISTING topics already stored today: (none yet)';

    const userContent =
        'Classify these headlines (indices are for THIS batch):\n' +
        headlines.map((h, i) => `${i}. ${h.replace(/\s+/g, ' ').trim()}`).join('\n') +
        existingBlock;

    const maxAttempts = 4;
    try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            let res: Response;
            try {
                res = await fetch(GROQ_URL, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: {
                        Authorization: `Bearer ${ENV.GROQ_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: ENV.GROQ_MODEL,
                        temperature: 0,
                        response_format: { type: 'json_object' },
                        messages: [
                            { role: 'system', content: SYSTEM_PROMPT },
                            { role: 'user', content: userContent },
                        ],
                    }),
                });
            } finally {
                clearTimeout(timeout);
            }

            if (res.status === 429) {
                const body = (await res.text()).slice(0, 500);
                const { dailyTpd, waitMs } = noteGroq429(body);
                logger.error(`[GroqClassifier] Groq returned 429: ${body.slice(0, 300)}`);
                if (dailyTpd) return [];
                if (attempt < maxAttempts) {
                    const backoff = Math.max(waitMs, 5000 * attempt);
                    logger.warn(
                        `[GroqClassifier] Rate-limited (429); retrying in ${backoff}ms (attempt ${attempt}/${maxAttempts})`,
                    );
                    await new Promise((r) => setTimeout(r, backoff));
                    continue;
                }
                return [];
            }

            if (!res.ok) {
                logger.error(`[GroqClassifier] Groq returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
                return [];
            }

            const json = (await res.json()) as GroqResponse;
            const content = json.choices?.[0]?.message?.content;
            if (!content) return [];

            const parsed = JSON.parse(content) as {
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
                if (!Number.isInteger(idx) || idx < 0 || idx >= headlines.length) continue;
                const coerced = coerceResult(raw, idx, headlines[idx]!);
                if (coerced) baseByIndex.set(idx, coerced);
            }

            const batchDuplicateOf = new Map<number, number>();
            for (const groupRaw of Array.isArray(parsed.duplicateGroups) ? parsed.duplicateGroups : []) {
                if (!Array.isArray(groupRaw) || groupRaw.length < 2) continue;
                const group = groupRaw
                    .map((v) => Number(v))
                    .filter((v) => Number.isInteger(v) && v >= 0 && v < headlines.length);
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
                if (!Number.isInteger(idx) || idx < 0 || idx >= headlines.length) continue;
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

        return [];
    } catch (error) {
        logger.error(`[GroqClassifier] Classification failed: ${(error as Error).message}`);
        return [];
    }
}
