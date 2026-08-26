/**
 * Channel-based transmission acceptance (semantic brain remediation).
 * Validators act on CAUSAL CHANNEL + driver semantics — never on asset names alone.
 */

import type { ClassifiedAsset } from './groqClassifier.service.js';

export type CausalChannel =
    | 'GEO_REGIME'
    | 'TRADE_POLICY'
    | 'CENTRAL_BANK_GUIDANCE'
    | 'RATE_YIELD_REPRICING'
    | 'COMMODITY_INVENTORY_SHOCK'
    | 'COMMODITY_SUPPLY_DISRUPTION'
    | 'EXPORT_BLOCKADE'
    | 'STRATEGIC_ROUTE_RISK'
    | 'STRATEGIC_ROUTE_RESTORATION'
    | 'INTERVENTION'
    | 'SANCTIONS'
    | 'FISCAL_OR_SOVEREIGN_LIQUIDITY_POLICY'
    | 'OTHER_FUNDAMENTAL';

export type ContributionIntent = {
    driverId: string;
    asset: string;
    channel: CausalChannel;
    proposedMagnitude: -1 | -0.5 | -0.25 | 0.25 | 0.5 | 1;
    polarity: 'Bullish' | 'Bearish';
    rationale: string;
    supportingGuids: string[];
    confidence?: number;
};

export type SemanticDriverInput = {
    eventId: string;
    themeId?: string | null;
    contractFamily?: string | null;
    status?: string;
    valid?: boolean;
    independent?: boolean;
    catalystEligible?: boolean;
    contributions: ClassifiedAsset[];
    supportingGuids?: string[];
    headline?: string | null;
    eventType?: string | null;
    eventRelation?: string | null;
    category?: string | null;
    actual?: string | null;
    forecast?: string | null;
    previous?: string | null;
    transmissionReason?: string | null;
};

const ALLOWED_MAGNITUDES = new Set([-1, -0.5, -0.25, 0, 0.25, 0.5, 1]);
const REACTION_RELATIONS = new Set(['CONFIRMATION', 'PRICE_REACTION', 'HISTORICAL_COMMENTARY']);
const COMMODITY_FAMILIES = new Set(['OIL_SUPPLY_SHOCK', 'COMMODITY_INVENTORY_SHOCK']);

const GENERIC_THEME_KEYS = new Set(['NONE', 'IRRELEVANT', '.', 'UNCLASSIFIED', '']);

function textOf(driver: SemanticDriverInput): string {
    return `${driver.headline ?? ''} ${driver.themeId ?? ''} ${driver.transmissionReason ?? ''}`.toLowerCase();
}

/** Infer the primary causal channel from model/classifier metadata — not headline regex gates. */
export function inferDriverChannel(driver: SemanticDriverInput): CausalChannel | null {
    const family = String(driver.contractFamily ?? '').toUpperCase();
    if (family === 'GEO_RISK_PREMIUM') return 'GEO_REGIME';
    if (family === 'RATE_YIELD_REPRICING') return 'RATE_YIELD_REPRICING';
    if (family === 'OIL_SUPPLY_SHOCK') {
        const text = textOf(driver);
        if (/\b(inventor(?:y|ies)|stockpile|stock change|stock change actual)\b/i.test(text) || (driver.actual && driver.forecast)) {
            return 'COMMODITY_INVENTORY_SHOCK';
        }
        if (/\b(reopen|restor|resum|traffic|crossing|transit|boats? come through|vessels? (?:transit|cross))\b/i.test(text)) {
            return 'STRATEGIC_ROUTE_RESTORATION';
        }
        if (/\b(blockade|export ban|export halt)\b/i.test(text)) return 'EXPORT_BLOCKADE';
        if (/\b(route|strait|shipping|transit|chokepoint|marine traffic|tanker)\b/i.test(text)) return 'STRATEGIC_ROUTE_RISK';
        return 'COMMODITY_SUPPLY_DISRUPTION';
    }
    if (family === 'COMMODITY_INVENTORY_SHOCK') return 'COMMODITY_INVENTORY_SHOCK';

    const text = textOf(driver);
    if (/\b(tariffs?|trade deal|trade agreement|usmca|customs duty|trade friction|supply management)\b/i.test(text)) {
        return 'TRADE_POLICY';
    }
    if (driver.eventType === 'CENTRAL_BANK' || /\b(central bank|rate hike|rate cut|policy rate|monetary policy)\b/i.test(text)) {
        return 'CENTRAL_BANK_GUIDANCE';
    }
    if (driver.category === 'GEOPOLITICAL' && driver.eventType === 'GEOPOLITICAL') return 'GEO_REGIME';
    return driver.contractFamily ? 'OTHER_FUNDAMENTAL' : null;
}

function isBoardEligibleDriver(driver: SemanticDriverInput): boolean {
    if (driver.status !== 'ACTIVE') return false;
    if (!driver.valid || !driver.independent || !driver.catalystEligible) return false;
    const relation = String(driver.eventRelation ?? '').toUpperCase();
    if (REACTION_RELATIONS.has(relation)) return false;
    if (['RESOLVED', 'REVERSED', 'INACTIVE'].includes(String(driver.status ?? '').toUpperCase())) return false;
    return true;
}

function normalizeContribution(asset: ClassifiedAsset): ClassifiedAsset | null {
    const score = Number(asset.score ?? 0);
    if (!score || asset.role === 'CONFIRMATION') return null;
    if (!ALLOWED_MAGNITUDES.has(score)) return null;
    return asset;
}

/**
 * Accept bounded contributions for board reconstruction.
 * Channel validators only filter contributions belonging to their channel —
 * TRADE_POLICY CAD is never stripped by commodity logic.
 */
export function acceptDriverContributions(driver: SemanticDriverInput): ClassifiedAsset[] {
    if (!isBoardEligibleDriver(driver)) return [];

    const channel = inferDriverChannel(driver);
    const accepted = driver.contributions
        .map(normalizeContribution)
        .filter((asset): asset is ClassifiedAsset => Boolean(asset));

    if (!channel) return accepted;

    // Commodity channels: accept when the model/contract family already validated the driver.
    // Do NOT re-run regex oil gates or strip unrelated assets (e.g. CAD on TRADE_POLICY).
    if (channel === 'TRADE_POLICY') {
        return accepted;
    }
    if (channel === 'GEO_REGIME' || channel === 'RATE_YIELD_REPRICING' || channel === 'CENTRAL_BANK_GUIDANCE') {
        return accepted;
    }
    if (channel === 'COMMODITY_INVENTORY_SHOCK' || channel === 'COMMODITY_SUPPLY_DISRUPTION'
        || channel === 'EXPORT_BLOCKADE' || channel === 'STRATEGIC_ROUTE_RISK' || channel === 'STRATEGIC_ROUTE_RESTORATION') {
        if (COMMODITY_FAMILIES.has(String(driver.contractFamily ?? '')) || driver.actual) {
            return accepted;
        }
        return [];
    }

    return accepted;
}

/** Whether a generic/placeholder theme should collapse by event id instead of theme label. */
export function isGenericThemeKey(themeId: string | null | undefined): boolean {
    const key = String(themeId ?? '').trim().toUpperCase();
    return GENERIC_THEME_KEYS.has(key) || key.length <= 1;
}

export function toContributionIntents(driver: SemanticDriverInput): ContributionIntent[] {
    const channel = inferDriverChannel(driver);
    if (!channel) return [];
    return acceptDriverContributions(driver).map((asset) => ({
        driverId: driver.eventId,
        asset: String(asset.asset),
        channel,
        proposedMagnitude: Math.abs(Number(asset.score)) as ContributionIntent['proposedMagnitude'],
        polarity: Number(asset.score) > 0 ? 'Bullish' : 'Bearish',
        rationale: String(asset.reason ?? driver.transmissionReason ?? driver.headline ?? ''),
        supportingGuids: driver.supportingGuids ?? [],
    }));
}
