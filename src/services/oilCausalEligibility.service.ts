/**
 * Deterministic OIL causal-channel eligibility (client contract §14, §16, §18, §22).
 * A row/theme may transmit OIL/CAD/JPY/EUR oil-channel scores only when it establishes or
 * updates a DIRECT crude/oil causal channel — not indirect geopolitical spillover.
 */

import { inferDriverChannel, type CausalChannel } from './ffeSemanticChannel.service.js';

export type OilCausalChannel =
    | 'SUPPLY_DISRUPTION'
    | 'EXPORT_BLOCKADE'
    | 'SHIPPING_ROUTE'
    | 'INVENTORY_DEMAND'
    | 'RESTORATION';

export type OilCausalAssessment = {
    eligible: boolean;
    channel: OilCausalChannel | null;
    /** Route-level Hormuz/Iran-shipping cluster — diplomacy updates the same driver. */
    hormuzCluster: boolean;
    collapseTheme: string | null;
    confirmed: boolean;
    conditional: boolean;
    reason: string;
};

export type OilCausalInput = {
    headline: string;
    themeId?: string | null;
    contractFamily?: string | null;
    geoState?: string | null;
    eventRelation?: string | null;
    status?: string;
    eventType?: string | null;
    category?: string | null;
};

const HORMUZ_THEME = 'GEO_HORMUZ_MIDDLE_EAST_ESCALATION';

const CONDITIONAL_PATTERN = /\b(mulls?|may|might|could|possible|unconfirmed|preparatory|preparation|considering|plans? to|sources?\s+say|reportedly|according to sources|risk\/reinsurance consideration)\b/i;
const CONFIRMED_OPERATIONAL = /\b(confirmed|attacked|attack|hit|struck|damage|damaged|closed|closure|disrupted|disruption|blockade|blockaded|projectile|casualt|explosion|halt(?:ed|ing)?|suspend(?:ed|ing)?|seiz(?:ed|ure)?|sank|sunk|fire|detonated|intercepted)\b/i;
const COMMENTARY_PATTERN = /\b(deutsche bank|goldman|barclays|nomura|commentary|fjelite|research note|analyst report|stalemate pushes)\b/i;
const HORMUZ_TEXT = /\b(strait of hormuz|hormuz)\b/i;
const HORMUZ_THEME_HINT = /HORMUZ|HORMUZ_/i;
const CRUDE_ASSET_CONTEXT = /\b(crude|wti|brent|oil|opec|petroleum|tanker|tankers|refiner(?:y|ies)|pipeline|oilfield|oil field|export terminal|lng|aramco|fuel tanks?)\b/i;
const ROUTE_CONTEXT = /\b(strait of hormuz|hormuz|red sea|shipping route|chokepoint|vessel crossing|transit(?:ing)?|ukmto|maritime blockade|naval blockade)\b/i;
const ROUTE_DISRUPTION = /\b(disrupt|closure|closed|blockade|block(?:ed|ing)?|attack|hit|struck|damage|casualt|halt|suspend|seiz|mine|projectile|explosion|interrupt|slow|incident|strike|struck)\b/i;
const RESTORATION = /\b(reopen|re-open|restor|resum|cleared|removed|lifted|eased|de-?escalat|ceasefire|traffic rises|crossings? (?:rise|increase|recover)|open(?:ed|ing)? (?:again|to traffic|normally)|mines (?:removed|cleared|detonated)|boats? come through|come through.*hormuz|vessels? (?:transit(?:ed|ing)?|cross(?:ed|ing)?).*hormuz)\b/i;
const MARINE_TRAFFIC_THREAT = /\b(targeting marine traffic|marine traffic|shipping route)\b/i;
const SEMANTIC_OIL_CHANNELS = new Set<CausalChannel>([
    'STRATEGIC_ROUTE_RISK',
    'STRATEGIC_ROUTE_RESTORATION',
    'EXPORT_BLOCKADE',
    'COMMODITY_INVENTORY_SHOCK',
]);
const SUPPLY_PRODUCTION = /\b(aramco|refiner(?:y|ies)|fuel tanks?|oilfield|oil field|pipeline|crude production|export terminal|port of odesa|energy facility)\b/i;
const SUPPLY_ATTACK = /\b(hit|struck|attack|attacked|fire|damage|damaged|explosion|strike)\b/i;
const EXPORT_BLOCKADE = /\b(export (?:ban|halt|cut)|naval blockade|blockade remains)\b/i;
const INVENTORY_DEMAND = /\b(inventor(?:y|ies)|stockpile|demand shock|supply shock)\b/i;
const DIPLOMACY_MEDIATION = /\b(mediat(?:e|es|ed|ing|ion|or|ors)?|negotiat(?:e|es|ed|ing|ion|or|ors)?|talks|diplomacy|ceasefire|invitation|pilots issue|open(?:ing)? hormuz|efforts to open)\b/i;

/** Indirect geopolitical headlines that must not mint independent oil drivers. */
const INDIRECT_GEO_ONLY = /\b(missile alert|air defense|ballistic missile|drone attack on moscow|wildberries|kursk|lavrov|erdogan.*trump|trump.*erdogan|syria base|idlib|sana'a|taiz province|jebel ali|dubai residents|uae missile threat)\b/i;

function headlineText(input: OilCausalInput): string {
    return input.headline.trim();
}

function isConditional(text: string, relation?: string | null): boolean {
    if (relation === 'FORECAST_UPCOMING') return true;
    if (/\b(unconfirmed|sources?)\b/i.test(text) && !CONFIRMED_OPERATIONAL.test(text)) return true;
    return CONDITIONAL_PATTERN.test(text) && !CONFIRMED_OPERATIONAL.test(text);
}

function isHormuzCluster(headline: string, themeId?: string | null): boolean {
    return HORMUZ_TEXT.test(headline) || HORMUZ_THEME_HINT.test(themeId ?? '');
}

function isHormuzAdjacentDiplomacy(headline: string): boolean {
    return DIPLOMACY_MEDIATION.test(headline)
        && /\b(iran|hormuz|middle east|us-iran|u\.s\.-iran|ceasefire|strait)\b/i.test(headline);
}

export function assessOilCausalEligibility(input: OilCausalInput): OilCausalAssessment {
    const text = headlineText(input);
    const themeHint = String(input.themeId ?? '');
    const relation = String(input.eventRelation ?? '').toUpperCase();
    const conditional = isConditional(text, relation);
    const commentary = input.eventType === 'COMMENTARY'
        || relation === 'HISTORICAL_COMMENTARY'
        || COMMENTARY_PATTERN.test(text);
    const watchOrInactive = input.status === 'WATCH' || input.geoState === 'WATCH';

    if (commentary) {
        return { eligible: false, channel: null, hormuzCluster: false, collapseTheme: null, confirmed: false, conditional: true, reason: 'commentary — no direct oil channel' };
    }

    const hormuzCluster = isHormuzCluster(text, input.themeId) || isHormuzAdjacentDiplomacy(text);

    if (hormuzCluster) {
        const operational = ROUTE_CONTEXT.test(text) && (ROUTE_DISRUPTION.test(text) || CONFIRMED_OPERATIONAL.test(text));
        const restoration = RESTORATION.test(text);
        const diplomacyUpdate = DIPLOMACY_MEDIATION.test(text);
        const trafficConfirmed = /\b(vessel|traffic|crossing|transit)\b/i.test(text) && /\b\d+\b/.test(text);
        const flowRestoration = RESTORATION.test(text)
            || /\b(boats?|vessels?).*(?:come through|transit(?:ed|ing)?|cross(?:ed|ing)?)\b/i.test(text);
        const blockadeConfirmed = /\b(naval blockade|blockade remains)\b/i.test(text);
        if (conditional && !trafficConfirmed && !flowRestoration && !CONFIRMED_OPERATIONAL.test(text) && !blockadeConfirmed) {
            return { eligible: false, channel: null, hormuzCluster: true, collapseTheme: HORMUZ_THEME, confirmed: false, conditional: true, reason: 'conditional Hormuz evidence — no active oil contribution' };
        }
        if (operational || restoration || flowRestoration || diplomacyUpdate || trafficConfirmed || blockadeConfirmed) {
            const channel: OilCausalChannel = restoration && !operational && !blockadeConfirmed ? 'RESTORATION' : blockadeConfirmed ? 'EXPORT_BLOCKADE' : 'SHIPPING_ROUTE';
            return {
                eligible: true,
                channel,
                hormuzCluster: true,
                collapseTheme: HORMUZ_THEME,
                confirmed: CONFIRMED_OPERATIONAL.test(text) || trafficConfirmed || blockadeConfirmed || relation === 'EVENT_UPDATE' || relation === 'SAME_EVENT',
                conditional: false,
                reason: blockadeConfirmed ? 'confirmed Hormuz-area naval blockade' : operational ? 'confirmed Hormuz route operational evidence' : restoration ? 'Hormuz route restoration/de-escalation update' : 'Hormuz diplomacy updates the same route driver',
            };
        }
    }

    if (/\b(naval blockade|blockade remains)\b/i.test(text) && /BLOCKADE|MARITIME|HORMUZ/i.test(themeHint)) {
        return {
            eligible: true,
            channel: 'EXPORT_BLOCKADE',
            hormuzCluster: /HORMUZ/i.test(themeHint) || HORMUZ_TEXT.test(text),
            collapseTheme: /HORMUZ/i.test(themeHint) ? HORMUZ_THEME : (input.themeId ?? 'EXPORT_BLOCKADE'),
            confirmed: true,
            conditional: false,
            reason: 'confirmed maritime blockade in crude-route context',
        };
    }

    if (conditional || watchOrInactive) {
        return { eligible: false, channel: null, hormuzCluster: false, collapseTheme: null, confirmed: false, conditional: true, reason: 'conditional/watch — no active oil contribution' };
    }

    if (MARINE_TRAFFIC_THREAT.test(text) && /\b(missile|ballistic|targeting|launched|attack|struck|hit)\b/i.test(text)) {
        return {
            eligible: true,
            channel: 'SHIPPING_ROUTE',
            hormuzCluster: isHormuzCluster(text, input.themeId),
            collapseTheme: isHormuzCluster(text, input.themeId) ? HORMUZ_THEME : (input.themeId ?? 'SHIPPING_ROUTE_DISRUPTION'),
            confirmed: CONFIRMED_OPERATIONAL.test(text) || /\btargeting\b/i.test(text),
            conditional: false,
            reason: 'confirmed marine-traffic / shipping-route threat',
        };
    }

    if (INDIRECT_GEO_ONLY.test(text) && !CRUDE_ASSET_CONTEXT.test(text)) {
        return { eligible: false, channel: null, hormuzCluster: false, collapseTheme: null, confirmed: false, conditional: false, reason: 'indirect geopolitical event — no direct crude/route channel' };
    }

    if (CRUDE_ASSET_CONTEXT.test(text) && SUPPLY_PRODUCTION.test(text) && SUPPLY_ATTACK.test(text) && (CONFIRMED_OPERATIONAL.test(text) || /\battacked\b/i.test(text))) {
        const slug = /\b(aramco|refiner)/i.test(text) ? 'MIDDLE_EAST_REFINERY_SUPPLY' : /\b(odesa|ukraine)/i.test(text) ? 'UKRAINE_FUEL_SUPPLY' : 'CRUDE_SUPPLY_DISRUPTION';
        return {
            eligible: true,
            channel: 'SUPPLY_DISRUPTION',
            hormuzCluster: false,
            collapseTheme: slug,
            confirmed: true,
            conditional: false,
            reason: 'confirmed production/refinery/export supply disruption',
        };
    }

    if (EXPORT_BLOCKADE.test(text) && (CRUDE_ASSET_CONTEXT.test(text) || ROUTE_CONTEXT.test(text)) && CONFIRMED_OPERATIONAL.test(text)) {
        return {
            eligible: true,
            channel: 'EXPORT_BLOCKADE',
            hormuzCluster: false,
            collapseTheme: input.themeId ?? 'EXPORT_BLOCKADE',
            confirmed: true,
            conditional: false,
            reason: 'confirmed export/route blockade with crude context',
        };
    }

    if (ROUTE_CONTEXT.test(text) && CRUDE_ASSET_CONTEXT.test(text) && ROUTE_DISRUPTION.test(text) && CONFIRMED_OPERATIONAL.test(text)) {
        return {
            eligible: true,
            channel: 'SHIPPING_ROUTE',
            hormuzCluster: false,
            collapseTheme: input.themeId ?? 'SHIPPING_ROUTE_DISRUPTION',
            confirmed: true,
            conditional: false,
            reason: 'confirmed strategic oil shipping-route disruption',
        };
    }

    if (INVENTORY_DEMAND.test(text) && CONFIRMED_OPERATIONAL.test(text)) {
        return {
            eligible: true,
            channel: 'INVENTORY_DEMAND',
            hormuzCluster: false,
            collapseTheme: input.themeId ?? 'INVENTORY_DEMAND',
            confirmed: true,
            conditional: false,
            reason: 'confirmed inventory/demand shock',
        };
    }

    if (input.contractFamily === 'OIL_SUPPLY_SHOCK' && CRUDE_ASSET_CONTEXT.test(text) && CONFIRMED_OPERATIONAL.test(text) && !INDIRECT_GEO_ONLY.test(text)) {
        return {
            eligible: true,
            channel: 'SHIPPING_ROUTE',
            hormuzCluster: false,
            collapseTheme: input.themeId ?? 'OIL_SUPPLY_SHOCK',
            confirmed: true,
            conditional: false,
            reason: 'confirmed direct crude context with operational shock',
        };
    }

    return { eligible: false, channel: null, hormuzCluster: false, collapseTheme: null, confirmed: false, conditional: conditional || watchOrInactive, reason: 'no direct crude/oil causal channel established' };
}

/** Oil-channel assets transmitted by the OIL_SUPPLY_SHOCK matrix. */
export const OIL_CHANNEL_ASSETS = new Set(['OIL', 'CAD', 'JPY', 'EUR']);

export function stripOilChannelContributions(contributions: Array<{ asset?: string; score?: number; role?: string; bias?: string; reason?: string }>): typeof contributions {
    return contributions.filter((asset) => !OIL_CHANNEL_ASSETS.has(String(asset.asset ?? '')));
}

export function applyOilCausalEligibility<T extends OilCausalInput & { contributions: Array<{ asset?: string; score?: number; role?: string; bias?: string; reason?: string }>; themeId?: string | null; contractFamily?: string | null }>(
    driver: T,
): T & { oilAssessment: OilCausalAssessment; themeId: string | null } {
    const assessment = assessOilCausalEligibility(driver);
    if (driver.contractFamily !== 'OIL_SUPPLY_SHOCK') {
        return { ...driver, oilAssessment: assessment, themeId: driver.themeId ?? null };
    }
    const semanticChannel = inferDriverChannel(driver);
    if (!assessment.eligible
        && semanticChannel
        && SEMANTIC_OIL_CHANNELS.has(semanticChannel)
        && !assessment.conditional
        && !assessment.reason.includes('commentary')) {
        return {
            ...driver,
            themeId: assessment.collapseTheme ?? driver.themeId ?? null,
            contractFamily: 'OIL_SUPPLY_SHOCK',
            oilAssessment: {
                ...assessment,
                eligible: true,
                channel: assessment.channel ?? (semanticChannel === 'STRATEGIC_ROUTE_RESTORATION' ? 'RESTORATION' : 'SHIPPING_ROUTE'),
                reason: `semantic ${semanticChannel} validated — secondary oil regex gate deferred`,
            },
        };
    }
    if (!assessment.eligible) {
        return {
            ...driver,
            themeId: assessment.collapseTheme ?? driver.themeId ?? null,
            contributions: stripOilChannelContributions(driver.contributions),
            oilAssessment: assessment,
        };
    }
    return {
        ...driver,
        themeId: assessment.collapseTheme ?? driver.themeId ?? null,
        contractFamily: 'OIL_SUPPLY_SHOCK',
        oilAssessment: assessment,
    };
}

export { HORMUZ_THEME };
