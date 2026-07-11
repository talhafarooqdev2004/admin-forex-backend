import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 45000;

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
 * Directional + asset + summary rules distilled from the automation-rules doc (§1, §3, §21–§25, §32, §34).
 * Dedup is reported as a SEPARATE sparse list (not a per-item pointer) — models otherwise anchor on index 0.
 */
const SYSTEM_PROMPT = `You are a forex Market Driver Board classifier for Forex Fundamental Edge.

TRACKED ASSETS ONLY (doc §1): USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, GOLD, OIL.
OIL means Crude Oil / WTI / Brent / OPEC crude supply — NOT natural gas, diesel, gasoline, heating oil, or power.

For each headline ("i. text") return:
1) category:
   - ECONOMIC = scheduled data releases (CPI, GDP, PMI, NFP, retail sales, unemployment)
   - DRIVER = CB speeches/guidance, yields, intervention, risk-on/off, OPEC/crude supply, sanctions/tariffs, fiscal
   - GEOPOLITICAL = war, strikes, ceasefire, Hormuz/energy-route risk, nuclear talks, military escalation
   - IRRELEVANT = crypto, single stocks, pure technicals, sports, celebrity, local non-market news, OR no CLEAR direct effect on a tracked asset
2) assets: ONLY assets DIRECTLY affected. Empty when IRRELEVANT. Do NOT invent a weak link.
3) impact: High | Medium | Low (materiality for markets)
4) For each asset: bias = Bullish | Bearish | Neutral | Mixed, and score MUST match impact:
   - High + Bullish → +1; High + Bearish → -1
   - Medium + Bullish → +0.5; Medium + Bearish → -0.5
   - Low → score 0 + bias Neutral
   - Neutral/Mixed bias → score 0
5) summary: short REASON for the PRIMARY (highest-|score|) asset (<= 8 words). Must explain WHY for THAT asset, never a truncated headline.
   If assets include OIL + GOLD + USD, write the reason for the strongest score (usually OIL on energy risk) — e.g. "Escalation raises oil risk", not a gold/USD line.
   If CAD is tagged from crude, say how oil affects CAD: "Oil weakness weighs on CAD".
   Good: "Escalation raises oil risk", "Talks ease Hormuz risk", "Hawkish Fed supports USD", "Brent settle confirms oil weakness"
   Bad: "US demands Iran", "Iran tensions", "N Korea-China", "Fire in Iran", "Pakistan-Iran talks"

ASSET RULES (strict — wrong asset is worse than IRRELEVANT):
- Tag OIL only for crude/WTI/Brent price moves, OPEC, crude supply disruption, Hormuz/shipping crude risk, Iran energy escalation that affects crude, crude-linked sanctions.
- Natural gas / diesel / gasoline / heating-oil futures alone → IRRELEVANT (not OIL).
- A local industrial fire, routine political speech, or North Korea–China alliance with NO energy/oil/sanctions/supply angle → IRRELEVANT (do not force OIL).
- Vague "leader will speak" / funeral messaging with no policy content → IRRELEVANT or Low Neutral — do NOT force USD.
- Fed/macro reports that only mention Middle East as background → do NOT auto-tag OIL unless the headline is about crude/energy risk itself.
- Risk-off fear → may be USD/JPY/CHF/GOLD. Risk-on relief → may be AUD/NZD/CAD.
- Rising crude → OIL + CAD bullish. Falling crude → OIL + CAD bearish.
- Russia / energy-buyer sanctions that threaten crude supply → BULLISH OIL (supply risk), not bearish.
- Escalation (attack, carriers in missile range, military options, blockade, Hormuz threat) → bullish OIL/GOLD as relevant. Do NOT also tag USD/JPY/CHF unless the headline explicitly mentions risk-off, the dollar, Fed, or yields.
- De-escalation (talks, ceasefire, restraint urges, mediation) → bearish OIL/GOLD, or Neutral 0 if no outcome yet. Same: no automatic USD tag.
- Do not score bullish merely because a conflict zone is named — read escalation vs diplomacy.
- Doc §21: do not assign a score to an asset unless the headline DIRECTLY affects it.

DEDUPLICATION (doc §3) — report separately. Same underlying event = one driver.
Duplicates = same specific announcement/statement/release restated (including near-paraphrases from one briefing).
NOT duplicates = same region/topic but different facts (e.g. Brent settle vs Iran nuclear demand).
When unsure, do NOT mark duplicate.
- duplicateGroups: [[principal, dup, ...], ...] within this batch (earliest/clearest index first). [] if none.
- existingDuplicates: [{"i": batchIndex, "existingId": "id"}] only for same-event matches to EXISTING topics. [] if none.

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

            if (res.status === 429 && attempt < maxAttempts) {
                const waitMs = 5000 * attempt;
                logger.warn(`[GroqClassifier] Rate-limited (429); retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
                await new Promise((r) => setTimeout(r, waitMs));
                continue;
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

/** High-precision same-event fingerprints for common wire paraphrases (doc §3). */
function eventFingerprint(headline: string): string | null {
    const h = headline.toLowerCase();
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

    // --- Directional generics tied to asset (still better than "Mild bullish driver") ---
    if (neutral) {
        if (category === 'GEOPOLITICAL') return `Geopolitics leave ${asset} direction mixed`;
        return `Headline leaves ${asset} direction unclear`;
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

/**
 * Post-LLM sanitizer so stored rows match doc §1/§21/§22/§34 even when the model drifts.
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

    if (isNonCrudeEnergyHeadline(headline)) {
        return {
            category: 'IRRELEVANT',
            impact: 'Low',
            assets: [],
            summary: 'Non-crude energy product ignored',
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

    assets = assets.map((a) => {
        const aligned = alignScoreToImpact(impact, a.bias, a.score);
        return { asset: a.asset, bias: aligned.bias, score: aligned.score };
    });

    if (category === 'IRRELEVANT' || assets.length === 0) {
        category = 'IRRELEVANT';
        assets = [];
        impact = 'Low';
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

            if (res.status === 429 && attempt < maxAttempts) {
                const waitMs = 5000 * attempt;
                logger.warn(`[GroqClassifier] Rate-limited (429); retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
                await new Promise((r) => setTimeout(r, waitMs));
                continue;
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
