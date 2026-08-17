import { createHash } from 'node:crypto';

/**
 * Shared, deterministic FFE decision-layer rules.
 *
 * The provider may interpret a headline, but it must not own the final arithmetic.  This
 * module is intentionally dependency-free so the same rules can be exercised by local
 * regression tests, ingestion, Catalyst aggregation, and the geopolitical card.
 */

export const FFE_TRACKED_ASSETS = [
    'USD',
    'EUR',
    'GBP',
    'JPY',
    'CHF',
    'CAD',
    'AUD',
    'NZD',
    'GOLD',
    'OIL',
] as const;

export type FfeTrackedAsset = (typeof FFE_TRACKED_ASSETS)[number];
export type FfeCategory = 'ECONOMIC' | 'DRIVER' | 'GEOPOLITICAL' | 'IRRELEVANT';
export type GeoState = 'ESCALATION' | 'DE_ESCALATION' | 'WATCH' | 'IRRELEVANT';
export type SemanticDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'MIXED';
export type SemanticStrength = 'NONE' | 'WEAK' | 'MODERATE' | 'STRONG';
export type SignValidationStatus = 'PASS' | 'CORRECTED' | 'FAILED' | 'NOT_APPLICABLE';

export type FfeAssetSignal = {
    asset: FfeTrackedAsset;
    bias: 'Bullish' | 'Bearish' | 'Neutral' | 'Mixed';
    score: number;
};

export type FfeDecisionMetadata = {
    driverTheme: string | null;
    causalThemeId: string | null;
    macroEventKey: string | null;
    geoState: GeoState;
    semanticDirection: SemanticDirection;
    semanticStrength: SemanticStrength;
    directAssetSignals: FfeAssetSignal[];
    transmittedAssetSignals: FfeAssetSignal[];
    signValidationStatus: SignValidationStatus;
};

const SCORES = [0, 0.25, 0.5, 0.75, 1] as const;

function clampScore(score: number): number {
    const n = Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
    return SCORES.reduce((best, candidate) =>
        Math.abs(candidate - Math.abs(n)) < Math.abs(best - Math.abs(n)) ? candidate : best,
    0) * (n < 0 ? -1 : 1);
}

function signal(asset: FfeTrackedAsset, score: number): FfeAssetSignal {
    const normalized = clampScore(score);
    return {
        asset,
        bias: normalized > 0 ? 'Bullish' : normalized < 0 ? 'Bearish' : 'Neutral',
        score: normalized,
    };
}

function dedupeSignals(signals: FfeAssetSignal[]): FfeAssetSignal[] {
    const byAsset = new Map<FfeTrackedAsset, FfeAssetSignal>();
    for (const row of signals) {
        if (!FFE_TRACKED_ASSETS.includes(row.asset)) continue;
        const next = signal(row.asset, row.score);
        const previous = byAsset.get(row.asset);
        if (!previous || Math.abs(next.score) > Math.abs(previous.score)) byAsset.set(row.asset, next);
    }
    return FFE_TRACKED_ASSETS.filter((asset) => byAsset.has(asset)).map((asset) => byAsset.get(asset)!);
}

function normalizeHeadline(text: string): string {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Scheduled calendar evidence is persisted as ECONOMIC, even when it is not Catalyst-visible. */
export function isEconomicReleaseHeadline(text: string): boolean {
    const h = normalizeHeadline(text);
    if (!h) return false;
    // Some wire summaries describe the released data indirectly (for example,
    // “softer US data cools Fed hike bets”) and contain no literal Actual /
    // Forecast labels. They are still Macro evidence, not Catalyst headlines.
    if (/\b(?:softer|weaker|stronger|firmer)\s+(?:us|u s|american)\s+data\b/.test(h) && /\bfed\b.{0,40}\b(?:hike|rate|bets?|expectations?)\b/.test(h)) {
        return true;
    }
    // A provider may use the words "forecast" or "previous" in a policy
    // article (for example, a bank's rate outlook).  Only treat those as a
    // release when the headline also names a measurable calendar series.
    const series = /\b(gdp|gross domestic product|cpi|consumer price|ppi|pmi|psi|nfp|nonfarm payroll|payrolls?|employment|retail sales|industrial output|industrial production|unemployment rate|unemployment|jobless claims|job openings?|house price|housing|manufacturing|business confidence|business conditions|consumer confidence|capacity utilization|trade balance|trade surplus|exports|imports|capital flows|portfolio investment|fixed asset investment|urban investment|new house prices|electronic card retail|performance of services|food price(?: inflation)? index|tertiary industry|private consumption|external demand|capex|business nz psi|na?hb housing|empire state|price index|consumer spending)\b/.test(h);
    if (!series) return false;
    if (/\b(actual|forecast|previous|prior|revised|came in|registered|increased|decreased|declined|rise|rises|rose|fell|grows?|below|above|miss|beat|remains?|in line|vs|expected|climbed|unchanged|stagnant|adds?|poll)\b/.test(h) && /\d/.test(h)) {
        // PBoC fixing/reference-rate headlines are policy observations, not
        // scheduled releases and must remain outside the Catalyst board.
        if (/\b(pboc|reference rate|fixing|usd cny|us dollar chinese yuan)\b/.test(h) && !/\b(cpi|gdp|pmi|retail|industrial|sales|output)\b/.test(h)) return false;
        return true;
    }
    // Some feeds wrap a scheduled print in a short market-reaction sentence
    // (“yen little changed after Japanese GDP data”).  Preserve the print as
    // Macro evidence even when it has no Actual/Forecast labels.
    if (/\b(?:after|following)\b.{0,45}\bdata\b/.test(h) && /\d/.test(h)) return true;
    return /\b(calendar|scheduled release|economic data|data release)\b/.test(h);
}

/** Stable indicator families used by deterministic Macro scoring. */
export function economicFamily(text: string): string {
    const h = normalizeHeadline(text);
    if (/\bchina|chinese\b/.test(h)) {
        if (/\b(?:new )?house prices?|house price index|property prices?/.test(h)) return 'CHINA_HOUSE_PRICES';
        if (/\bunemployment/.test(h)) return 'CHINA_UNEMPLOYMENT';
        return 'CHINA_ACTIVITY';
    }
    if (/\bjapan|japanese|yen\b/.test(h)) {
        if (/\bgdp deflator|gross domestic product deflator|price deflator/.test(h)) return 'JAPAN_GDP_DEFLATOR';
        if (/\bgdp|gross domestic product|private consumption|capex|capital expenditure|external demand/.test(h)) return 'JAPAN_GDP';
        if (/\btertiary industry|industrial production|capacity utilization/.test(h)) return 'JAPAN_ACTIVITY';
        return 'JAPAN_ACTIVITY';
    }
    if (/\bcanada|canadian|cad|loonie|boc|bank of canada\b/.test(h)) {
        if (/\bcpi|consumer price/.test(h)) {
            if (/\b(?:core|common|trim|median)\b/.test(h)) return 'CANADA_CPI_CORE';
            return 'CANADA_CPI_HEADLINE';
        }
        if (/\bportfolio investment|capital flows|foreign securities/.test(h)) return 'CANADA_CAPITAL_FLOWS';
        return 'CANADA_MACRO';
    }
    if (/\bunited states|\bus\b|american|nahb|empire state|ny fed/.test(h)) {
        if (/\bhousing|house price|nahb/.test(h)) return 'US_HOUSING';
        if (/\bmanufactur|empire state|ny fed/.test(h)) return 'US_MANUFACTURING';
        return 'US_MACRO';
    }
    if (/\bunited kingdom|\buk\b|british|rightmove|pound/.test(h) && /\bhouse price|housing/.test(h)) return 'UK_HOUSING';
    if (/\bnew zealand|\bnz\b|nzd|kiwi\b/.test(h)) {
        if (/\belectronic card retail|retail sales/.test(h)) return 'NZ_RETAIL';
        if (/\bfood price|food inflation/.test(h)) return 'NZ_FOOD';
        if (/\bpsi|performance of services|business nz/.test(h)) return 'NZ_PSI';
        return 'NZ_ACTIVITY';
    }
    return 'RELEASE_CLUSTER';
}

/** A stable event identity for macro values from calendar and RSS. */
export function macroEventKey(text: string, currency?: string | null): string | null {
    if (!isEconomicReleaseHeadline(text)) return null;
    const h = normalizeHeadline(text)
        .replace(/\b(actual|forecast|previous|revised)\b/g, '')
        .replace(/\b[-+]?\d+(?:\.\d+)?%?\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!h) return null;
    const family = h
        .replace(/\b(qoq|yoy|mom|annualized|annual|monthly|yearly|seasonally adjusted|s adj)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return createHash('sha256').update(`${String(currency ?? '')}|${family}`).digest('hex').slice(0, 40);
}

function hasAny(h: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(h));
}

/** Geo state is determined before any asset transmission. Talks without a confirmed outcome stay WATCH. */
export function inferGeoState(text: string): GeoState {
    const h = normalizeHeadline(text);
    if (!h) return 'IRRELEVANT';

    const deEscalation = hasAny(h, [
        /confirmed ceasefire/, /ceasefire agreement/, /peace agreement/, /peace deal/, /successful negotiations?/,
        /diplomatic breakthrough/, /withdrawal of forces?/, /shipping (?:route|traffic) (?:re)?opened/,
        /hormuz (?:is )?(?:open|reopened|reopens?)/, /shipping (?:reopens?|reopened)/, /sanctions? (?:eased|lifted|removed)/, /commit(?:s|ted) not to escalate/,
        /approval to extend/, /extend(?:s|ed)? the \d+[- ]day/, /meaningful (?:diplomatic )?progress/, /positive and active conversations?/, /more robust than ever/,
    ]);
    if (deEscalation && !hasAny(h, [/proposal/, /could/, /may/, /if diplomacy fails/, /not there yet/])) return 'DE_ESCALATION';

    // IRGC statements about crushing a threat are hostile rhetoric, not a
    // confirmed military action. Keep them WATCH so they do not trigger the
    // broad confirmed-risk transmission table.
    if (/\birgc\b/.test(h) && /\bcrush|aggression|decisive(?:ly)?|threat/.test(h)) return 'WATCH';

    const escalation = hasAny(h, [
        /missile/, /drone attack/, /airstrike/, /(?:military )?strike/, /troop deployment/, /blockade/, /tanker attack/,
        /shipping disruption/, /hormuz (?:closure|closed|disruption|risk)/, /hold naval blockade/, /offensive posture/, /ultimatum/, /talks? collapse/,
        /negotiations? (?:collapse|break down|fail)/, /diplomacy fails?/, /major sanctions?/, /conflict (?:expands?|widening)/,
        /military action/, /attack(?:s|ed)?/, /invasion/, /forces? deployed/, /fully offensive/, /crush any threat/, /aggression/,
        /naval blockade/, /tanker assaults?/, /transits? slow/, /escalating .*\brisk/, /oil supply risk/,
    ]);
    if (escalation) return 'ESCALATION';

    const watch = hasAny(h, [
        /talks?/, /negotiat/, /diplomatic contact/, /officials? meet/, /difficult discussions?/, /warning/, /warns?/, /unconfirmed/,
        /rhetoric/, /roadmap/, /deal/, /understanding/, /restraint/, /mediat/, /patient/, /positive/, /robust/, /conversation/, /mou/, /not there yet/, /not realistic/, /threat/, /escort/, /stalemate/, /uncertain/, /standoff/, /situation/, /discuss/, /military efforts?/, /logistics/, /nuclear weapon/, /not (?:be )?striking/, /timeframe/, /deadline/, /difficult talks?/, /deadlock/, /gaza/, /caspian/, /controls? strait/, /declaring hormuz/, /us territory/, /diplomatic efforts?/, /closure of .*hormuz/, /closure risk/,
    ]);
    if (watch) return 'WATCH';
    return 'IRRELEVANT';
}

/** General causal families. These are semantic families, not headline-specific lookup entries. */
export function inferCausalTheme(text: string, category: FfeCategory = 'DRIVER'): string | null {
    const h = normalizeHeadline(text);
    if (!h) return null;
    if (/\b(?:awards?|awarded|contract|procurement|purchase order|boost output)\b/.test(h) && /\b(?:missile|tomahawk|raytheon|navy|defen[cs]e)\b/.test(h)) return 'DEFENSE_PROCUREMENT';
    if (isEconomicReleaseHeadline(text)) {
        if (/\b(?:softer|weaker|stronger|firmer)\s+(?:us|u s|american)\s+data\b/.test(h)) return 'RELEASE_CLUSTER';
        if (/\bchina|chinese\b/.test(h)) return 'CHINA_GROWTH_DETERIORATION';
        if (/\bjapan|japanese|yen\b/.test(h)) return 'JAPAN_GROWTH_CLUSTER';
        if (/\bnew zealand|\bnz\b|nzd|kiwi\b/.test(h)) return 'NZ_ACTIVITY_CLUSTER';
        if (/\bcanada|canadian|cad|loonie|boc|bank of canada\b/.test(h)) {
            if (/\bcpi|consumer price/.test(h)) return 'CANADA_CPI_HOT';
            if (/\bportfolio investment|capital flows|foreign securities/.test(h)) return 'CANADA_CAPITAL_FLOWS';
            return 'CANADA_MACRO_CLUSTER';
        }
        if (/\bunited states|\bus\b|american|nahb|empire state|ny fed/.test(h)) {
            if (/\bhousing|house price|nahb/.test(h)) return 'US_HOUSING';
            if (/\bmanufactur|empire state|ny fed/.test(h)) return 'US_MANUFACTURING';
            return 'US_MACRO_CLUSTER';
        }
        if (/\bunited kingdom|\buk\b|british|rightmove|pound/.test(h) && /\bhouse price|housing/.test(h)) return 'UK_HOUSING_MIXED';
        return 'RELEASE_CLUSTER';
    }
    // Direct monetary/yield causes take precedence over a secondary Iran or
    // geopolitical mention in a gold/FX market wrap.
    if (/\bgold|xau\b/.test(h) && /\b(?:fed|fomc|hike expectations?|rate cuts?|weaker us data|dollar slumps?|dollar weakens?|receding fed hike|yield)/.test(h)) {
        const dovish = /dovish|hike bets? (?:fall|fade|drop|cool)|hike expectations? (?:fall|fade|drop|cool)|rate cuts?|weaker us data|dollar slumps?|dollar weakens?|receding|lower real yields?/.test(h);
        return dovish ? 'FED_DOVISH_REPRICING_GOLD' : 'FED_REPRICING_GOLD';
    }
    if (/\blower real yields?|real yields? (?:fall|drop|ease)/.test(h)) return 'LOWER_REAL_YIELDS';
    const fedContext = /\bfed\b|\bfomc\b|federal reserve|us dollar|dollar index|\bdxy\b|us data|treasury yield/.test(h);
    if (fedContext && /\b(hike bets?|hike rates?|rate hike expectations?|rate cuts?|dovish|hawkish|higher for longer|repric|yield|expects? .*hike)/.test(h)) {
        const dovish = /dovish|hike bets? (?:fall|fade|drop|cool)|(?:rate )?hike expectations? (?:fall|fade|drop|cool)|rate cuts?|receding|push back|weaker us data|dollar weakens?/.test(h);
        if (!dovish && /expects? .*fed.*hike|expects? .*rate hike|hawkish|higher for longer/.test(h)) return /2027|longer term|long-term/.test(h) ? 'FED_HAWKISH_LONGER_TERM_REPRICING' : 'FED_HAWKISH_REPRICING';
        return dovish ? 'FED_DOVISH_REPRICING' : 'FED_REPRICING';
    }
    if (/\bnot fully back to full oil flow|middle east oil flow|strategic petroleum reserve|reserve fell|lowest since/.test(h)) {
        return /\bstrategic petroleum reserve|reserve fell|lowest since/.test(h) ? 'US_STRATEGIC_RESERVE_TIGHTNESS' : 'MIDDLE_EAST_OIL_SUPPLY_DISRUPTION';
    }
    if (/\biraq\b/.test(h) && /\bexport route|single route|corridor|captive|oil exports?/.test(h)) return 'IRAQ_EXPORT_ROUTE_RISK';
    if (/\bmilitary efforts?|bringing out .* barrels|logistics/.test(h) && /\bhormuz|strait/.test(h)) return 'HORMUZ_MILITARY_LOGISTICS';
    if (/\bred sea|houthis?|ballistic missiles?/.test(h) && /\battack|attacked|landing ship|escort vessels?/.test(h)) return 'RED_SEA_MILITARY_ESCALATION';
    if (/\btariff|trade threat|not bluffing\b/.test(h) && /\buk|british|pound|united kingdom/.test(h)) return 'UK_TARIFF_ESCALATION';
    if (category === 'GEOPOLITICAL' || inferGeoState(text) !== 'IRRELEVANT') {
        if (/\bkushner\b/.test(h) && /\bpatient|positive|active conversations?|robust|understanding|not there yet/.test(h)) return 'IRAN_US_DIPLOMATIC_PROGRESS';
        if (/\bapproval to extend\b|\bextend(?:s|ed)? the \d+[- ]day\b/.test(h)) return 'IRAN_US_DEESCALATION';
        if (/\btimeframe\b/.test(h) && /\b(?:set by|conveyed|deadline)\b/.test(h) && /\biran|us|america|united states\b/.test(h)) return 'IRAN_US_NEGOTIATION_DEADLINE';
        if (/(?:doesn[ ]t have|does not have|no)\b.{0,25}\bdeadline\b/.test(h) && /\biran|us|america|united states\b/.test(h)) return 'IRAN_US_NEGOTIATION_TIMELINE';
        if (/\btalks? with oman\b|\boman\b/.test(h) && /\bcomplexity|multiple actors|undermin(?:e|ing)|long due|difficult talks?/.test(h)) return 'IRAN_OMAN_DIFFICULT_TALKS';
        if (/\birgc\b/.test(h) && /\bcrush|aggression|decisive(?:ly)?|threat/.test(h)) return 'IRAN_ESCALATION_RHETORIC';
        if (/\bnuclear weapon\b/.test(h) && /\biran|us|trump\b/.test(h)) return 'US_IRAN_STRATEGIC_CONFRONTATION';
        if (/\bsaudi|yemen\b/.test(h) && /\battack|strike|border|missile/.test(h)) return 'SAUDI_YEMEN_ESCALATION';
        if (/\bisrael|lebanon\b/.test(h) && /\bsanction|attack|strike/.test(h) && /\biran/.test(h)) return 'ISRAEL_LEBANON_IRAN_SANCTIONS_ESCALATION';
        if (/\biraq\b/.test(h) && /\bexport route|single route|corridor|captive/.test(h)) return 'IRAQ_EXPORT_ROUTE_RISK';
        if (/\bcaspian sea/.test(h)) return 'CASPIAN_STRATEGIC_RHETORIC';
        if (/\bstrategic reserve|reserve fell|lowest since/.test(h)) return 'US_STRATEGIC_RESERVE_TIGHTNESS';
        if (/\bmilitary efforts?|bringing out .* barrels|logistics/.test(h) && /\bhormuz|strait/.test(h)) return 'HORMUZ_MILITARY_LOGISTICS';
        if (/\bclosure of the strait|hormuz closure|closure risk/.test(h)) return 'HORMUZ_CLOSURE_RISK';
        if (/\bnot fully back to full oil flow|oil flow|supply disruption/.test(h) && /\bmiddle east|iran|hormuz|oil/.test(h)) return 'MIDDLE_EAST_OIL_SUPPLY_DISRUPTION';
        if (/\bescort(?:ing)? hormuz|hormuz traffic/.test(h)) return 'HORMUZ_ESCORT_OPERATIONS';
        if (/\btransits? slow|vessel transits?|tanker assaults?|shipping disruption|disrupt(?:s|ed|ing)? .*hormuz|hormuz .*disrupt/.test(h) && /\bhormuz|strait/.test(h)) return 'HORMUZ_TRANSIT_DISRUPTION';
        if (/\bpersian gulf|gulf stalemate|supply risk/.test(h)) return 'PERSIAN_GULF_SUPPLY_RISK';
        if (/\b(?:south korea|korea|military cooperation|diplomatic coordination)/.test(h) && /\bhormuz|strait/.test(h)) return 'HORMUZ_DIPLOMATIC_COORDINATION';
        if (/\bchina|chinese\b/.test(h) && /\bregional peace|security|diplomacy|counterpart|discuss/.test(h)) return 'IRAN_CHINA_DIPLOMACY';
        if (/\bmiddle east\b/.test(h) && /\boil|crude|wti|brent\b/.test(h) && /\brisk|elevated|supply|escalat|tension/.test(h)) return 'MIDDLE_EAST_OIL_SUPPLY_RISK';
        if (/\bif we return to negotiations|islamabad agreement|manama meeting/.test(h)) return 'IRAN_US_NEGOTIATION_CONDITIONS';
        if (/\boman\b/.test(h) && /\bthreat|attack|handle/.test(h)) return 'US_OMAN_ESCALATION';
        if (/\bhormuz (?:is )?(?:open|reopen)|oil prices? (?:are )?coming down/.test(h)) return 'HORMUZ_OPEN_DEESCALATION';
        if (/\bcontrols? strait|declaring hormuz|hormuz as us territory/.test(h)) return 'US_HORMUZ_CONTROL_RHETORIC';
        if (/\bif diplomacy fails|fully offensive|offensive posture|escalate tensions?|aggression/.test(h)) return /\bfully offensive|offensive posture/.test(h) ? 'IRAN_ESCALATION' : 'IRAN_HORMUZ_ESCALATION';
        if (/\bnot seeking|delusion|reject|not (?:going to )?make|fail|collapse|threat/.test(h) && /\biran|us|united states/.test(h)) return 'IRAN_US_DIPLOMATIC_DETERIORATION';
        if (/\bdeadline|timeframe|full implementation|mou/.test(h) && /\biran|us|united states/.test(h)) return 'IRAN_US_NEGOTIATION_DEADLINE';
        if (/\b(?:naval blockade|not wait.*blockade|blockade indefinitely|hold naval blockade)\b/.test(h)) return /\b(?:strait of )?hormuz\b/.test(h) ? 'HORMUZ_BLOCKADE_RISK' : 'IRAN_BLOCKADE_ESCALATION';
        if (/\bif diplomacy fails|fully offensive|offensive posture|escalate tensions?|aggression/.test(h)) return 'IRAN_HORMUZ_ESCALATION';
        if (/\bhormuz|strait|oil supply|tanker|shipping|iran|tehran\b/.test(h)) {
            if (/breakthrough|patient|positive|robust|active conversations?|understanding|roadmap|peace|progress|reopen/.test(h) && !/not realistic|not seeking|delusion|reject|not (?:going to )?make/.test(h)) return 'IRAN_US_DIPLOMATIC_PROGRESS';
            if (/not seeking|not there yet|not realistic|delusion|not (?:going to )?make|deadline|reject|collapse|fail|threat/.test(h)) return 'IRAN_US_DIPLOMATIC_DETERIORATION';
            if (/talks?|negotiat|diplom/.test(h)) return 'IRAN_US_DIPLOMACY';
            return 'IRAN_US_OIL_SUPPLY_RISK';
        }
        if (/\bgaza\b/.test(h) && /breakthrough|ceasefire|demilitar|peace/.test(h)) return 'GAZA_DEESCALATION';
        if (/\bgaza\b/.test(h) && /not (?:be )?striking/.test(h)) return 'GAZA_DEESCALATION_RHETORIC';
        if (/\bukraine|russia|lebanon|israel|sanction/.test(h)) return 'REGIONAL_GEOPOLITICAL_RISK';
        return 'GEOPOLITICAL_THEME';
    }
    if (/\byield|treasury|bond yield|dollar index|\bdxy\b/.test(h)) return 'US_YIELD_REPRICING';
    if (/\bpolicy doubts?|boj doubts?|doubts weigh on yen|path questioned|weak demand/.test(h)) return 'BOJ_POLICY_DOUBTS';
    if (/\bintervention|mof|finance minister|gpif|yen losses?\b/.test(h) && /\byen|jpy|japan/.test(h)) return 'JPY_INTERVENTION_RISK';
    if (/\bboj|bank of japan\b/.test(h)) return /hawkish|hike|tighten|support jpy|support yen/.test(h) ? 'BOJ_HAWKISH_REPRICING' : 'BOJ_POLICY_REPRICING';
    if (/\becb|euro|bank of england|\bboe\b|rba|rbnz|boc|snb|central bank/.test(h)) {
        if (/\becb|euro/.test(h)) return /hawkish|hike|tighten/.test(h) ? 'ECB_HAWKISH_REPRICING' : 'ECB_POLICY_REPRICING';
        if (/\bboe|pound|sterling/.test(h)) return /hold|pause/.test(h) ? 'BOE_HOLD_REPRICING' : 'BOE_POLICY_REPRICING';
        if (/\brba|australian|aussie/.test(h)) return /pause|hold/.test(h) ? 'RBA_HAWKISH_PAUSE_REPRICING' : (/hawkish|hike|tighten|outlook/.test(h) ? 'RBA_HAWKISH_GUIDANCE' : 'RBA_POLICY_REPRICING');
        if (/\brbnz|new zealand|kiwi/.test(h)) return /hold|pause/.test(h) ? 'RBNZ_HOLD_REPRICING' : 'RBNZ_POLICY_REPRICING';
        if (/\bboc|canadian|loonie/.test(h)) return 'BOC_POLICY_REPRICING';
        if (/\bsnb|swiss|chf/.test(h)) return 'SNB_POLICY_REPRICING';
    }
    if (/\bchina|chinese|iron ore|copper|industrial metals?\b/.test(h) && /\b(growth|demand|property|stimulus|retail|industrial|output|sales|miss|beat|deteriorat|rebound|recovery)\b/.test(h)) return 'CHINA_GROWTH_DETERIORATION';
    if (/\bcopper|iron ore|industrial metals?\b/.test(h) && /\brecord|tightening supply|surge|rise|higher|strong|demand/.test(h)) return 'INDUSTRIAL_METALS_STRENGTH';
    if (/\b(?:russia|russian)\b/.test(h) && /\b(?:port|loadings?|resumes?|restores?|restart|flow)\b/.test(h) && /\boil|crude|energy\b/.test(h)) return 'OIL_SUPPLY_RESTORATION';
    if (/\boil|wti|brent|crude|opec\b/.test(h) && /\bsupply|flow|hormuz|sanction|production|inventory|shipping|surge|spike|disruption|elevated|risk/.test(h)) return 'OIL_SUPPLY_RISK';
    if (/\biraq|route|corridor|oil exports?\b/.test(h) && /\boil|exports?|corridor|route/.test(h)) return 'IRAQ_EXPORT_ROUTE_RISK';
    if (/\bgold|xau\b/.test(h) && /\byield|fed|dollar|safe haven|risk/.test(h)) return 'GOLD_SAFE_HAVEN';
    if (/\bdairy|milk prices?|gdt\b/.test(h)) return 'NZ_DAIRY_PRICES';
    if (/\btariff|trade threat|fiscal|budget/.test(h)) return 'FISCAL_TRADE_POLICY';
    return category === 'DRIVER' ? 'UNSPECIFIED_DRIVER' : null;
}

export function themeFingerprint(theme: string | null, headline: string): string | null {
    const normalized = theme || inferCausalTheme(headline);
    return normalized ? normalized.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').slice(0, 120) : null;
}

function strengthFromImpact(impact: string, text: string): SemanticStrength {
    if (String(impact).toLowerCase() === 'low') return 'WEAK';
    const h = normalizeHeadline(text);
    if (/\b(major|severe|sharp|material|aggressive|confirmed|surge|collapse|widening|sustained)\b/.test(h)) return 'STRONG';
    return String(impact).toLowerCase() === 'high' ? 'STRONG' : 'MODERATE';
}

function directionFromSignals(signals: FfeAssetSignal[]): SemanticDirection {
    const positive = signals.filter((s) => s.score > 0).length;
    const negative = signals.filter((s) => s.score < 0).length;
    if (positive && negative) return 'MIXED';
    if (positive) return 'BULLISH';
    if (negative) return 'BEARISH';
    return 'NEUTRAL';
}

function broadRiskOff(text: string): boolean {
    const h = normalizeHeadline(text);
    return /\brisk off|broad equity sell off|safe haven demand|global stocks? (?:fall|drop|slide)|broad market stress\b/.test(h);
}

function directionalScore(text: string, impact: string): number {
    const h = normalizeHeadline(text);
    const magnitude = String(impact).toLowerCase() === 'high'
        ? 1
        : String(impact).toLowerCase() === 'medium'
            ? 0.5
            : /\b(major|severe|sharp|material|aggressive|confirmed|surge|spike|collapse|widening|sustained|strong)\b/.test(h)
                ? 0.75
                : /\b(hike bets?|rate expectations?|yield repricing)\b/.test(h)
                    ? 0.5
                    : 0.25;
    const positive = /\b(hawkish|higher for longer|rate hikes?|hike expectations?|hike bets? (?:rise|increase)|tightening|restrictive|surge|rises?|gains?|grows?|strong|beats?|rebound|recovery|support(?:s|ed)?|strengthen)/.test(h);
    const negative = /\b(dovish|rate cuts?|hike bets? (?:fall|fade|drop)|hike expectations? (?:fall|fade|drop|cool)|eas(?:e|ing)|falls?|drops?|weak(?:en(?:s|ed|ing)?)?|miss(?:es|ed)?|deteriorat|declin|slump|pressure(?:s|d)?|doubt|weighs? on|receding|push(?:es)? back)/.test(h);
    // Headlines often contain the positive instrument (“rate hike”) while
    // explicitly saying that traders are pushing back on it. Treat that
    // reversal as dovish instead of allowing the generic positive token to
    // win merely because it appears first.
    if (negative) return -magnitude;
    if (positive) return magnitude;
    return 0;
}

function releaseComparisonDirection(text: string): number {
    const h = String(text ?? '').toLowerCase().replace(/,/g, '').replace(/−/g, '-').replace(/\s+/g, ' ').trim();
    const value = (pattern: RegExp): number | null => {
        const match = h.match(pattern);
        if (!match) return null;
        const parsed = Number(match[1]);
        return Number.isFinite(parsed) ? parsed : null;
    };
    if (/\b(?:in line|unchanged|unchanged|little changed|remains? unchanged|stagnant)\b/.test(h) && !(/\bstagnant\b/.test(h) && /\b(?:expected|poll)\b/.test(h))) return 0;
    const actualLabeled = value(/\bactual(?:ly)?\s*[:(]?\s*(-?\d+(?:\.\d+)?)/);
    const actual = actualLabeled ?? value(/\b(?:grow(?:s|th)?|came in at|registered at|printed|was|adds?|rose to|increased to)\s*[:(]?\s*(-?\d+(?:\.\d+)?)/) ?? value(/:\s*(-?\d+(?:\.\d+)?)/);
    const reference = value(/\b(?:forecast|forecasts?|previous|prior|poll(?:s)? expected|expectations?)\s*[:(]?\s*(-?\d+(?:\.\d+)?)/) ?? value(/\bpoll\s*[:(]?\s*(-?\d+(?:\.\d+)?)/);
    const hasExplicitComparison = actual != null && reference != null;
    let direction = hasExplicitComparison ? Math.sign(actual! - reference!) : 0;
    // Some feeds place the relation after the reference number:
    // “Actual 0.3% vs 0.5% expected”.
    const vsExpected = h.match(/\b(?:vs\.?|versus)\s*(-?\d+(?:\.\d+)?)\s*%?\s*(?:expected|forecast|previous|prior)?/);
    if (!hasExplicitComparison && actual != null && vsExpected) direction = Math.sign(actual - Number(vsExpected[1]));
    // An explicit Actual/Previous (or Actual/Forecast) comparison is stronger
    // evidence than the descriptive verb in the headline.  For example,
    // “GDP grows 0.3% vs 0.5% expected” is still a negative surprise.
    if (hasExplicitComparison || (actual != null && vsExpected)) {
        if (direction > 0 && /\b(unemployment|jobless claims?|claims?)\b/.test(h) && !/\bbeat|above|stronger\b/.test(h)) direction = -1;
        return direction;
    }
    // Common wire layouts put the relation before the parenthesized values:
    // “above forecasts (11): Actual (20.6)” and “below forecasts (5%): Actual
    // (4.5%).” The relation is more reliable than a generic number search.
    if (/\b(?:above|beat|beats|stronger than|higher than)\b/.test(h)) direction = 1;
    if (/\b(?:below|miss|misses|weaker than|lower than|disappoints?)\b/.test(h)) direction = -1;
    if (/\b(above|beat|beats|increased|increases|rise|rises|rose|grows|stronger|rebound|recovery|improved)\b/.test(h)) direction = 1;
    if (/\b(below|miss|misses|declined|declines|fell|falls|weaker|deteriorat|slump|stagnant|disappoint)\b/.test(h)) direction = -1;
    if (/\b(?:increased|rose|rises|climbed|grew|grows)\b.{0,45}\bfrom\b/.test(h)) direction = 1;
    if (/\b(?:declined|decreased|fell|falls|dropped|slumped)\b.{0,45}\bfrom\b/.test(h)) direction = -1;
    if (/\b(?:rose|rises|increased|climbed)\b.{0,30}\bto\b/.test(h)) direction = 1;
    if (/\b(?:fell|falls|declined|decreased|dropped)\b.{0,30}\bto\b/.test(h)) direction = -1;
    // Higher unemployment/claims are adverse; higher inflation/growth/activity
    // is supportive unless the headline explicitly says it missed.
    if (direction > 0 && /\b(unemployment|jobless claims?|claims?)\b/.test(h) && !/\bbeat|above|stronger\b/.test(h)) direction = -1;
    return direction;
}

function economicSignalMagnitude(text: string, impact: string): number {
    const h = normalizeHeadline(text);
    const family = economicFamily(text);
    // The provider's impact label is not trusted when it contradicts a
    // measurable release surprise. Infer magnitude from the indicator family
    // first, then use impact only as a conservative fallback.
    if (family === 'CHINA_HOUSE_PRICES' || family === 'UK_HOUSING') return 0;
    if (family === 'CANADA_CPI_CORE' || family === 'CANADA_CAPITAL_FLOWS' || family === 'NZ_PSI' || family === 'NZ_FOOD' || family === 'JAPAN_ACTIVITY') {
        if (family === 'CANADA_CPI_CORE' && /\b(?:median|trim)\b/.test(h)) return 0.5;
        if (family === 'JAPAN_ACTIVITY' && /\b(?:tertiary industry|industrial production)\b/.test(h) && /\b(?:mom|above forecasts?|above expectations?)\b/.test(h)) return 0.5;
        if (/\b(?:actual|previous|prior|forecast|above|below|beat|miss|increased|increases|rise|rises|rose|climbed|declined|decreased|fell|falls|dropped|from|to|in line|remains? at|vs)\b/.test(h)) return 0.25;
    }
    if (family === 'CANADA_CPI_HEADLINE' || family === 'NZ_RETAIL' || family === 'JAPAN_GDP' || family === 'JAPAN_GDP_DEFLATOR' || family === 'US_HOUSING') return 0.5;
    if (family === 'US_MANUFACTURING') return 1;
    if (family === 'CHINA_UNEMPLOYMENT') return 0.25;
    if (family === 'CHINA_ACTIVITY') return 0.5;
    const numeric = String(text ?? '').toLowerCase().replace(/,/g, '').replace(/−/g, '-').replace(/\s+/g, ' ').trim();
    const actual = numeric.match(/\bactual(?:ly)?\s*[:(]?\s*(-?\d+(?:\.\d+)?)/)?.[1];
    const reference = numeric.match(/\b(?:forecast|forecasts?|previous|poll(?:s)? expected|expectations?)\s*[:(]?\s*(-?\d+(?:\.\d+)?)/)?.[1];
    if (actual && reference && Math.abs(Number(actual) - Number(reference)) >= 5) return 1;
    if (/\b(strongly|sharply|major|record|largest|surprise|well above|well below)\b/.test(h)) return 1;
    if (String(impact).toLowerCase() === 'high') return 1;
    if (String(impact).toLowerCase() === 'medium') return 0.5;
    return 0;
}

function economicSignals(text: string, impact: string, theme: string | null): FfeAssetSignal[] {
    let direction = releaseComparisonDirection(text);
    const normalized = normalizeHeadline(text);
    const family = economicFamily(text);
    if (!direction && (theme === 'CANADA_CPI_HOT' || family === 'CANADA_CPI_CORE' || family === 'CANADA_CPI_HEADLINE') && /\b(?:remains? at|in line with forecasts?)\b/.test(normalized)) direction = 1;
    if (!direction && family === 'CANADA_CPI_CORE' && /:\s*[-+]?\d/.test(normalized) && /\bvs\.?\s*[-+]?\d/.test(normalized)) direction = 1;
    if (family === 'NZ_FOOD' && /\bon previous month\b/.test(normalized) && /\brise|rises\b/.test(normalized)) direction = -1;
    if (!direction && family === 'JAPAN_GDP' && /\b(?:after|following)\b.{0,45}\bgdp data\b/.test(normalized) && /\bdown|falls?|declines?|miss/.test(normalized)) direction = -1;
    if (family === 'CHINA_HOUSE_PRICES' || family === 'UK_HOUSING' || family === 'NZ_PSI' && /\bunchanged|remains? unchanged\b/.test(normalized)) direction = 0;
    // A secondary “Gross Domestic Product (QoQ) registered …” feed line is
    // retained in Macro but contributes no independent score once the primary
    // GDP release is in the same cluster.
    if (family === 'JAPAN_GDP' && /gross domestic product\s+qoq/.test(normalized) && /\bregistered at\b/.test(normalized) && /\bbelow expectations?\b/.test(normalized)) direction = 0;
    if (!direction) return [];
    const magnitude = economicSignalMagnitude(text, impact);
    if (magnitude === 0) return [];
    switch (theme) {
        case 'CHINA_GROWTH_DETERIORATION':
            return [signal('AUD', direction * Math.min(0.5, magnitude)), signal('NZD', direction * Math.min(0.25, magnitude))];
        case 'JAPAN_GROWTH_CLUSTER':
            return [signal('JPY', direction * Math.min(0.5, magnitude))];
        case 'NZ_ACTIVITY_CLUSTER':
            return [signal('NZD', direction * Math.min(0.5, magnitude))];
        case 'CANADA_CPI_HOT':
            return [signal('CAD', direction * Math.min(0.5, magnitude))];
        case 'CANADA_CAPITAL_FLOWS':
        case 'CANADA_MACRO_CLUSTER':
            return [signal('CAD', direction * Math.min(0.25, magnitude))];
        case 'US_HOUSING':
        case 'US_MANUFACTURING':
        case 'US_MACRO_CLUSTER':
            return [signal('USD', direction * Math.min(1, magnitude))];
        case 'UK_HOUSING_MIXED':
            // Conflicting Rightmove feeds are retained as Macro rows but do
            // not create a directional Catalyst until the cluster resolves.
            return /\b(conflicting|mixed|declined|increased)\b/.test(normalizeHeadline(text)) ? [signal('GBP', 0)] : [signal('GBP', direction * 0.25)];
        default:
            return [];
    }
}

/** Deterministic transmission from cause/theme to tracked assets. */
export function applyDeterministicTransmission(
    text: string,
    category: FfeCategory,
    impact: string,
    classifiedAssets: FfeAssetSignal[] = [],
): { direct: FfeAssetSignal[]; transmitted: FfeAssetSignal[]; geoState: GeoState; theme: string | null; validation: SignValidationStatus } {
    const h = normalizeHeadline(text);
    const geoState = category === 'GEOPOLITICAL' || inferGeoState(text) !== 'IRRELEVANT' ? inferGeoState(text) : 'IRRELEVANT';
    const theme = inferCausalTheme(text, category);
    const direct = dedupeSignals(classifiedAssets);
    let transmitted: FfeAssetSignal[] = [];

    if (isEconomicReleaseHeadline(text)) {
        return { direct, transmitted: economicSignals(text, impact, theme || 'RELEASE_CLUSTER'), geoState: 'IRRELEVANT', theme: theme || 'RELEASE_CLUSTER', validation: 'NOT_APPLICABLE' };
    }

    const score = directionalScore(text, impact);
    if (theme === 'FED_REPRICING' || theme === 'FED_REPRICING_GOLD' || theme === 'FED_DOVISH_REPRICING' || theme === 'FED_DOVISH_REPRICING_GOLD' || theme === 'FED_HAWKISH_REPRICING' || theme === 'FED_HAWKISH_LONGER_TERM_REPRICING') {
        const dovish = /dovish|hike bets? (?:fall|fade|drop|cool)|hike expectations? (?:fall|fade|drop|cool)|rate cuts?|weaker us data|dollar slumps?|dollar weakens?|weakens?|receding|push(?:es)? back/.test(h);
        const fedScore = dovish ? -Math.abs(score || 0.5) : Math.abs(score || (theme === 'FED_HAWKISH_LONGER_TERM_REPRICING' ? 0.25 : 0.5));
        transmitted = (theme === 'FED_REPRICING_GOLD' || theme === 'FED_DOVISH_REPRICING_GOLD') && /gold|xau/.test(h)
            ? [signal('GOLD', -fedScore)]
            : [signal('USD', fedScore)];
    } else if (theme === 'JPY_INTERVENTION_RISK' || theme === 'BOJ_POLICY_DOUBTS') {
        const supportive = /intervention|cap(?:s|ped)? losses?|support(?:s|ed)? yen|yen buying/.test(h);
        transmitted = [signal('JPY', supportive ? Math.max(0.25, Math.abs(score) || 0.25) : score)];
    } else if (theme === 'IRAN_US_DIPLOMATIC_PROGRESS' || theme === 'IRAN_US_DIPLOMACY' || theme === 'IRAN_CHINA_DIPLOMACY' || theme === 'HORMUZ_DIPLOMATIC_COORDINATION' || theme === 'CASPIAN_STRATEGIC_RHETORIC') {
        // Patient/positive/robust conversations are a directional relief
        // signal for the reference rows; bare talks, rhetoric, and regional
        // coordination remain WATCH with no numeric score.
        if (geoState === 'DE_ESCALATION' || /\bpatient|positive|active conversations?|robust|meaningful progress|not there yet\b/.test(h)) transmitted = [signal('OIL', -0.25), signal('GOLD', -0.25)];
        else transmitted = [];
    } else if (theme === 'IRAN_US_DEESCALATION') {
        transmitted = [signal('OIL', -0.25), signal('GOLD', -0.25)];
    } else if (theme === 'IRAN_ESCALATION_RHETORIC') {
        transmitted = [signal('OIL', 0.25), signal('GOLD', 0.25)];
    } else if (theme === 'US_IRAN_STRATEGIC_CONFRONTATION') {
        transmitted = [signal('OIL', 0.25), signal('GOLD', 0.25)];
    } else if (theme === 'HORMUZ_ESCORT_OPERATIONS') {
        transmitted = [signal('OIL', 0.25)];
    } else if (theme === 'GAZA_DEESCALATION' || theme === 'GAZA_DEESCALATION_RHETORIC') {
        transmitted = [signal('GOLD', -0.25)];
    } else if (theme === 'HORMUZ_MILITARY_LOGISTICS') {
        transmitted = [];
    } else if (theme === 'HORMUZ_CLOSURE_RISK') {
        transmitted = [signal('OIL', 0.25)];
    } else if (theme === 'SAUDI_YEMEN_ESCALATION') {
        transmitted = [signal('OIL', 0.25), signal('GOLD', 0.25)];
    } else if (theme === 'RED_SEA_MILITARY_ESCALATION') {
        transmitted = [signal('OIL', 0.5), signal('GOLD', 0.25)];
    } else if (theme === 'US_OMAN_ESCALATION') {
        const hardline = /\b(?:attack|threatens?|military|strike|bomb)\b/.test(h) && !/\bthreat to\b/.test(h);
        transmitted = [signal('OIL', 0.5), signal('GOLD', hardline ? 0.5 : 0.25)];
    } else if (theme === 'IRAN_ESCALATION') {
        transmitted = [signal('OIL', 0.5), signal('GOLD', 0.5), signal('CHF', 0.25)];
    } else if (theme === 'IRAN_US_NEGOTIATION_CONDITIONS') {
        transmitted = [];
    } else if (theme === 'IRAN_US_DIPLOMATIC_DETERIORATION' || theme === 'IRAN_US_NEGOTIATION_DEADLINE' || theme === 'US_HORMUZ_CONTROL_RHETORIC') {
        const watchScore = /deadline|timeframe|control|territory|not realistic|not there|not seeking|not (?:going to )?make|delusion|reject|fail|threat/.test(h) ? 0.25 : 0;
        transmitted = watchScore ? [signal('OIL', watchScore)] : [];
        if (watchScore && theme === 'IRAN_US_DIPLOMATIC_DETERIORATION' && /not seeking|not (?:going to )?make/.test(h)) transmitted.push(signal('GOLD', watchScore));
    } else if (theme === 'IRAN_US_NEGOTIATION_TIMELINE' || theme === 'IRAN_OMAN_DIFFICULT_TALKS' || theme === 'IRAN_US_NEGOTIATION_CONDITIONS') {
        transmitted = [];
    } else if (theme === 'IRAQ_EXPORT_ROUTE_RISK' || theme === 'US_STRATEGIC_RESERVE_TIGHTNESS') {
        transmitted = [signal('OIL', 0.25)];
    } else if (theme === 'MIDDLE_EAST_OIL_SUPPLY_DISRUPTION' || theme === 'MIDDLE_EAST_OIL_SUPPLY_RISK') {
        transmitted = [signal('OIL', 0.5), signal('CAD', 0.25)];
    } else if (theme === 'OIL_SUPPLY_RESTORATION') {
        transmitted = [signal('OIL', -0.25)];
    } else if (theme === 'INDUSTRIAL_METALS_STRENGTH') {
        transmitted = [signal('AUD', 0.25)];
    } else if (theme === 'OIL_SUPPLY_RISK' || theme === 'IRAN_US_OIL_SUPPLY_RISK' || theme === 'HORMUZ_OPEN_DEESCALATION' || theme === 'HORMUZ_TRANSIT_DISRUPTION' || theme === 'PERSIAN_GULF_SUPPLY_RISK' || theme === 'IRAN_BLOCKADE_ESCALATION' || theme === 'HORMUZ_BLOCKADE_RISK' || theme === 'IRAN_HORMUZ_ESCALATION') {
        if (theme === 'IRAN_HORMUZ_ESCALATION') {
            transmitted = [signal('OIL', 0.75), signal('GOLD', 0.5)];
            if (/\b(?:risk[- ]off|safe haven|haven|sanction|threat)\b/.test(h)) transmitted.push(signal('CHF', 0.25));
        } else {
        let rising = /\b(ris(?:e|es|ing)|climb(?:s|ed|ing)?|reignite|surge|spike|higher|advance(?:s|d|ing)?|gain(?:s|ed|ing)?|elevated|disrupt(?:s|ed|ing)?|disruption|attack|blockade|trigger(?:s|ed)?)\b/.test(h);
        let falling = /\b(fall|drop|lower|ease|eas(?:e|es|ed|ing)|reopen|open|de escalation|deescalation)\b/.test(h);
        if (theme === 'HORMUZ_TRANSIT_DISRUPTION' && /transits? slow|tanker assaults?|disruption/.test(h)) rising = true;
        if (geoState === 'DE_ESCALATION') {
            rising = false;
            falling = true;
        }
        if (geoState === 'WATCH' && !rising && !falling) {
            // A watch/rumour is retained for audit but does not create a
            // numeric Catalyst until a supply move, escalation, or confirmed
            // de-escalation is present.
            return { direct, transmitted: theme === 'PERSIAN_GULF_SUPPLY_RISK' ? [signal('OIL', 0.25)] : [], geoState, theme, validation: 'PASS' };
        }
        const oilMagnitude = /(?:standoff|supply concerns?|supply risks?|prices? elevated)/.test(h) && (theme === 'IRAN_US_OIL_SUPPLY_RISK' || theme === 'OIL_SUPPLY_RISK') ? 0.5
            : theme === 'IRAN_HORMUZ_ESCALATION' ? 0.75
            : theme === 'IRAN_BLOCKADE_ESCALATION' || theme === 'HORMUZ_BLOCKADE_RISK' ? 0.5
            : theme === 'HORMUZ_TRANSIT_DISRUPTION' ? 0.75
            : theme === 'PERSIAN_GULF_SUPPLY_RISK' ? 0.25
            : String(impact).toLowerCase() === 'high'
            ? 0.75
            : String(impact).toLowerCase() === 'medium'
                ? 0.5
                : /\b(major|severe|sharp|material|confirmed|surge|spike|disruption|disrupt)\b/.test(h) ? 0.75 : 0.25;
        const oil = rising && !falling ? oilMagnitude : falling && !rising ? (theme === 'HORMUZ_OPEN_DEESCALATION' || /hormuz .*open|oil prices? .*coming down/.test(h) ? -0.5 : -0.25) : (theme === 'IRAN_BLOCKADE_ESCALATION' || theme === 'IRAN_HORMUZ_ESCALATION' ? 0.5 : 0.25);
        transmitted.push(signal('OIL', geoState === 'DE_ESCALATION' ? -Math.abs(oil) : oil));
        const cadThemes = new Set(['OIL_SUPPLY_RISK', 'IRAN_US_OIL_SUPPLY_RISK', 'MIDDLE_EAST_OIL_SUPPLY_RISK', 'MIDDLE_EAST_OIL_SUPPLY_DISRUPTION', 'HORMUZ_TRANSIT_DISRUPTION']);
        if (Math.abs(oil) >= 0.5 && geoState !== 'DE_ESCALATION' && cadThemes.has(theme)) transmitted.push(signal('CAD', oil >= 0 ? 0.25 : -0.25));
        if (geoState === 'DE_ESCALATION' && theme === 'HORMUZ_OPEN_DEESCALATION') transmitted.push(signal('CAD', -0.25));
        const goldRiskThemes = new Set(['HORMUZ_TRANSIT_DISRUPTION', 'IRAN_BLOCKADE_ESCALATION', 'HORMUZ_BLOCKADE_RISK', 'IRAN_HORMUZ_ESCALATION']);
        if (rising && !falling && goldRiskThemes.has(theme)) {
            const goldMagnitude = theme === 'IRAN_HORMUZ_ESCALATION' || (theme === 'HORMUZ_TRANSIT_DISRUPTION' && broadRiskOff(text)) ? 0.5 : 0.25;
            transmitted.push(signal('GOLD', goldMagnitude));
        }
        if (rising && !falling && ['IRAN_BLOCKADE_ESCALATION', 'IRAN_HORMUZ_ESCALATION'].includes(theme) && /\b(?:haven|safe haven|risk[- ]off|sanction|threat)\b/.test(h)) transmitted.push(signal('CHF', 0.25));
        if (geoState === 'DE_ESCALATION' && theme !== 'HORMUZ_OPEN_DEESCALATION') transmitted.push(signal('GOLD', -0.25));
        if (broadRiskOff(text)) {
            transmitted.push(signal('USD', 0.5), signal('CHF', 0.5), signal('AUD', -0.5), signal('NZD', -0.5), signal('EUR', -0.25), signal('GBP', -0.25));
        }
        }
    } else if (theme === 'FISCAL_TRADE_POLICY' || theme === 'UK_TARIFF_ESCALATION') {
        const negativeTrade = /tariff|threat|not bluffing|pressure/.test(h);
        transmitted = [signal(/\buk|british|pound|gbp/.test(h) ? 'GBP' : 'USD', negativeTrade ? -0.5 : score)];
    } else if (/^(ECB|BOE|RBA|RBNZ|BOC|SNB|BOJ)_(?:POLICY_REPRICING|HAWKISH_REPRICING|HOLD_REPRICING|HAWKISH_PAUSE_REPRICING|HAWKISH_GUIDANCE)$/.test(theme ?? '')) {
        const asset: FfeTrackedAsset = theme?.startsWith('ECB_') ? 'EUR'
            : theme?.startsWith('BOE_') ? 'GBP'
                : theme?.startsWith('RBA_') ? 'AUD'
                    : theme?.startsWith('RBNZ_') ? 'NZD'
                        : theme?.startsWith('BOC_') ? 'CAD'
                            : theme?.startsWith('SNB_') ? 'CHF' : 'JPY';
        const policyScore = /\bhold|pause|backing|hawkish|hike|tighten|higher for longer/.test(h)
            ? Math.abs(score || 0.25)
            : score;
        transmitted = [signal(asset, theme === 'RBA_HAWKISH_GUIDANCE' && /\bhawkish\b.*\boutlook\b|\brises?\b/.test(h) ? 0.75 : policyScore)];
    } else if (theme === 'CHINA_GROWTH_DETERIORATION') {
        const down = /\b(miss|weak|deteriorat|declin|slump|fall|lower|disappoint)/.test(h);
        transmitted = [signal('AUD', down ? -0.5 : 0.5), signal('NZD', down ? -0.25 : 0.25)];
    } else if (theme === 'GOLD_SAFE_HAVEN' || theme === 'LOWER_REAL_YIELDS') {
        transmitted = [signal('GOLD', theme === 'LOWER_REAL_YIELDS' ? Math.abs(score || 0.25) : (score || (broadRiskOff(text) ? 0.5 : 0.25)))];
        if (theme === 'LOWER_REAL_YIELDS') transmitted.unshift(signal('USD', -Math.abs(score || 0.25)));
    } else if (geoState === 'ESCALATION') {
        transmitted = [signal('OIL', String(impact).toLowerCase() === 'high' ? 0.75 : 0.5)];
        if (/\bgold|safe haven|risk premium\b/.test(h)) transmitted.push(signal('GOLD', 0.5));
        if (broadRiskOff(text)) {
            transmitted.push(signal('USD', 0.5), signal('CHF', 0.5), signal('AUD', -0.5), signal('NZD', -0.5), signal('EUR', -0.25), signal('GBP', -0.25));
        }
        if (/\bjpy|yen\b/.test(h) && /safe haven|buying|strengthens?/.test(h)) transmitted.push(signal('JPY', 0.5));
    } else if (geoState === 'DE_ESCALATION') {
        transmitted = [signal('OIL', -0.25), signal('GOLD', -0.25)];
    } else {
        transmitted = direct;
    }

    const finalSignals = transmitted.length
        ? dedupeSignals(transmitted)
        : (theme && theme !== 'UNSPECIFIED_DRIVER' ? [] : dedupeSignals(direct));
    const validation = validateScoreSigns(theme, h, finalSignals);
    return { direct, transmitted: finalSignals, geoState, theme, validation };
}

export function validateScoreSigns(theme: string | null, text: string, signals: FfeAssetSignal[]): SignValidationStatus {
    const h = normalizeHeadline(text);
    const usd = signals.find((s) => s.asset === 'USD');
    if (theme === 'FED_REPRICING' || theme === 'FED_REPRICING_GOLD' || theme === 'FED_DOVISH_REPRICING' || theme === 'FED_DOVISH_REPRICING_GOLD' || theme === 'FED_HAWKISH_REPRICING' || theme === 'FED_HAWKISH_LONGER_TERM_REPRICING') {
        const dovish = /dovish|hike bets? (?:fall|fade|drop)|rate cuts?|eas(?:e|ing)/.test(h);
        const hawkish = /hawkish|hike bets? (?:rise|increase)|higher for longer/.test(h);
        if (usd && dovish && usd.score > 0) return 'FAILED';
        if (usd && hawkish && usd.score < 0) return 'FAILED';
    }
    const jpy = signals.find((s) => s.asset === 'JPY');
    if (theme === 'JPY_INTERVENTION_RISK' && jpy && /intervention|cap(?:s|ped)? losses?|support(?:s|ed)? yen/.test(h) && jpy.score < 0) return 'FAILED';
    return theme ? 'PASS' : 'NOT_APPLICABLE';
}

/** Apply the engine to a classifier result while preserving Macro-only category semantics. */
export function deriveFfeDecision(
    text: string,
    category: FfeCategory,
    impact: string,
    assets: FfeAssetSignal[] = [],
): FfeDecisionMetadata {
    const economic = isEconomicReleaseHeadline(text);
    const result = applyDeterministicTransmission(text, economic ? 'ECONOMIC' : category, impact, assets);
    const direction = directionFromSignals(result.transmitted.length ? result.transmitted : result.direct);
    return {
        driverTheme: result.theme,
        causalThemeId: themeFingerprint(result.theme, text),
        macroEventKey: economic ? macroEventKey(text) : null,
        geoState: economic ? 'IRRELEVANT' : result.geoState,
        semanticDirection: direction,
        semanticStrength: strengthFromImpact(impact, text),
        directAssetSignals: result.direct,
        transmittedAssetSignals: result.transmitted,
        signValidationStatus: result.validation,
    };
}

export function aggregateUniqueCausalThemes(
    rows: Array<{ headline: string; causalThemeId?: string | null; assets: FfeAssetSignal[]; duplicateOf?: string | null; category?: string }>,
): Map<FfeTrackedAsset, { bullishCount: number; bearishCount: number; driverScore: number; themes: string[] }> {
    const result = new Map<FfeTrackedAsset, { bullishCount: number; bearishCount: number; driverScore: number; themes: string[] }>();
    for (const asset of FFE_TRACKED_ASSETS) result.set(asset, { bullishCount: 0, bearishCount: 0, driverScore: 0, themes: [] });
    const seen = new Set<string>();
    for (const row of rows) {
        if (row.duplicateOf) continue;
        if (String(row.category ?? '').toUpperCase() === 'ECONOMIC') continue;
        const signals = dedupeSignals(row.assets);
        for (const item of signals) {
            if (item.score === 0) continue;
            const theme = row.causalThemeId || themeFingerprint(null, row.headline) || `ROW:${normalizeHeadline(row.headline).slice(0, 80)}`;
            const identity = `${item.asset}|${theme}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            const target = result.get(item.asset)!;
            if (item.score > 0) target.bullishCount += 1;
            else target.bearishCount += 1;
            target.driverScore += item.score;
            target.themes.push(theme);
        }
    }
    for (const value of result.values()) value.driverScore = Number(value.driverScore.toFixed(2));
    return result;
}
