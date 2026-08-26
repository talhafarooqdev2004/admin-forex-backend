import {
    collapseCanonicalDrivers,
    reconstructCanonicalCatalyst,
    type CanonicalDriverAuditRow,
} from './canonicalThemeRegistry.service.js';
import {
    acceptDriverContributions,
    inferDriverChannel,
    type SemanticDriverInput,
} from './ffeSemanticChannel.service.js';
import {
    applyOilCausalEligibility,
} from './oilCausalEligibility.service.js';
import {
    deriveGeoRiskPremium,
    deriveYieldRepricingDriver,
    TRACKED_ASSETS,
    type ClassifiedAsset,
    type TrackedAsset,
    type YieldRepricingEvidence,
} from './groqClassifier.service.js';

export type CatalystDriverInput = Pick<
    CanonicalDriverAuditRow,
    'eventId' | 'themeId' | 'contractFamily' | 'status' | 'valid' | 'independent' | 'catalystEligible' | 'contributions' | 'supportingGuids'
> & {
    headline?: string | null;
    eventType?: string | null;
    geoState?: string | null;
    eventRelation?: string | null;
    category?: string | null;
    actual?: string | null;
    previous?: string | null;
    transmissionReason?: string | null;
};

export type GeoRegimeSnapshot = {
    dominantTheme: string | null;
    score: number;
    band: string;
    eventCount: number;
    escalationThemes: string[];
    deEscalationThemes: string[];
};

export type CollapsedCatalystDriver = ReturnType<typeof collapseCanonicalDrivers>[number] & {
    supportingGuids?: string[];
    provenanceReason?: string | null;
    oilChannel?: string | null;
};

const REGIME_COVERED_ASSETS = new Set<TrackedAsset>(['USD', 'CHF', 'EUR', 'GBP', 'AUD', 'NZD']);
const REGIME_EXEMPT_FAMILIES = new Set(['OIL_SUPPLY_SHOCK', 'COMMODITY_INVENTORY_SHOCK', 'RATE_YIELD_REPRICING', 'GEO_RISK_PREMIUM']);

function stripRegimeDuplicateContributions(
    contributions: ClassifiedAsset[],
    contractFamily: string | null | undefined,
    geoPremiumActive: boolean,
    driver?: SemanticDriverInput,
): ClassifiedAsset[] {
    if (!geoPremiumActive) return contributions;
    if (contractFamily && REGIME_EXEMPT_FAMILIES.has(contractFamily)) return contributions;
    const channel = driver ? inferDriverChannel(driver) : null;
    if (channel === 'TRADE_POLICY' || channel === 'RATE_YIELD_REPRICING' || channel === 'CENTRAL_BANK_GUIDANCE') return contributions;
    return contributions.filter((asset) => !REGIME_COVERED_ASSETS.has(asset.asset as TrackedAsset));
}

function geoProvenanceFromDrivers(drivers: CatalystDriverInput[], geo: GeoRegimeSnapshot) {
    const escalationThemes = new Set(geo.escalationThemes);
    const supporting = drivers.filter((driver) =>
        driver.eventType === 'GEOPOLITICAL'
        && driver.themeId
        && escalationThemes.has(driver.themeId)
        && driver.geoState === 'ESCALATION'
        && driver.status === 'ACTIVE');
    return {
        supportingThemes: [...new Set(supporting.map((driver) => driver.themeId!).filter(Boolean))],
        supportingEventIds: [...new Set(supporting.map((driver) => driver.eventId))],
        supportingGuids: [...new Set(supporting.flatMap((driver) => driver.supportingGuids ?? []))],
    };
}

function yieldEvidenceFromDrivers(drivers: CatalystDriverInput[]): YieldRepricingEvidence[] {
    return drivers
        .filter((driver) => driver.status === 'ACTIVE' && driver.valid && driver.independent && driver.catalystEligible)
        .map((driver) => ({
            headline: driver.headline ?? driver.themeId ?? driver.eventId,
            actual: driver.actual ?? null,
            previous: driver.previous ?? null,
            eventType: driver.eventType ?? null,
            category: driver.category ?? null,
            contractFamily: driver.contractFamily ?? null,
            eventRelation: driver.eventRelation ?? null,
            valid: driver.valid,
            catalystEligible: driver.catalystEligible,
            status: driver.status,
            eventId: driver.eventId,
            supportingGuids: driver.supportingGuids ?? [],
        }));
}

export function buildCollapsibleCatalystRows(
    drivers: CatalystDriverInput[],
    geo: GeoRegimeSnapshot,
): Array<Pick<CanonicalDriverAuditRow, 'eventId' | 'themeId' | 'contractFamily' | 'status' | 'valid' | 'independent' | 'catalystEligible' | 'contributions'>> {
    const provenance = geoProvenanceFromDrivers(drivers, geo);
    const premium = deriveGeoRiskPremium({
        score: geo.score,
        escalationCount: geo.escalationThemes.length,
        deEscalationCount: geo.deEscalationThemes.length,
        confirmed: geo.score >= 0.41,
        supportingThemes: provenance.supportingThemes,
        supportingEventIds: provenance.supportingEventIds,
        supportingGuids: provenance.supportingGuids,
    });
    const geoPremiumActive = Boolean(premium);
    const rows = drivers
        .filter((driver) => driver.status === 'ACTIVE' && driver.valid && driver.independent && driver.catalystEligible)
        .map((driver) => ({
            eventId: driver.eventId,
            themeId: driver.themeId ?? null,
            contractFamily: driver.contractFamily ?? null,
            status: driver.status,
            valid: driver.valid,
            independent: driver.independent,
            catalystEligible: driver.catalystEligible,
            headline: driver.headline ?? null,
            eventType: driver.eventType ?? null,
            eventRelation: driver.eventRelation ?? null,
            category: driver.category ?? null,
            actual: driver.actual ?? null,
            previous: driver.previous ?? null,
            transmissionReason: driver.transmissionReason ?? null,
            supportingGuids: driver.supportingGuids,
            contributions: (() => {
                const base = acceptDriverContributions({
                    ...driver,
                    eventRelation: driver.eventRelation ?? null,
                });
                if (driver.contractFamily !== 'OIL_SUPPLY_SHOCK') return base;
                return applyOilCausalEligibility({ ...driver, contributions: base, eventRelation: driver.eventRelation ?? undefined }).contributions;
            })(),
        }))
        .map((driver) => ({
            ...driver,
            contributions: stripRegimeDuplicateContributions(driver.contributions, driver.contractFamily, geoPremiumActive, driver),
        }))
        .filter((driver) => driver.contributions.some((asset) => asset.role !== 'CONFIRMATION' && asset.score !== 0));
    if (premium) {
        rows.push({
            eventId: 'geo_risk_premium',
            themeId: premium.family,
            contractFamily: premium.family,
            status: 'ACTIVE',
            valid: true,
            independent: true,
            catalystEligible: true,
            contributions: premium.contributions,
        });
    }
    const yld = deriveYieldRepricingDriver(yieldEvidenceFromDrivers(drivers));
    if (yld) {
        rows.push({
            eventId: 'us_yield_repricing',
            themeId: yld.family,
            contractFamily: yld.family,
            status: 'ACTIVE',
            valid: true,
            independent: true,
            catalystEligible: true,
            contributions: yld.contributions,
        });
    }
    return rows;
}

export function reconstructFfeCatalystBoard(
    drivers: CatalystDriverInput[],
    geo: GeoRegimeSnapshot,
): {
    board: Array<{ asset: TrackedAsset; bullishCount: number; bearishCount: number; driverScore: number; driverIds: string[] }>;
    collapsed: CollapsedCatalystDriver[];
    yieldDriver: ReturnType<typeof deriveYieldRepricingDriver>;
    geoPremium: ReturnType<typeof deriveGeoRiskPremium>;
} {
    const provenance = geoProvenanceFromDrivers(drivers, geo);
    const premium = deriveGeoRiskPremium({
        score: geo.score,
        escalationCount: geo.escalationThemes.length,
        deEscalationCount: geo.deEscalationThemes.length,
        confirmed: geo.score >= 0.41,
        supportingThemes: provenance.supportingThemes,
        supportingEventIds: provenance.supportingEventIds,
        supportingGuids: provenance.supportingGuids,
    });
    const yld = deriveYieldRepricingDriver(yieldEvidenceFromDrivers(drivers));
    const collapsible = buildCollapsibleCatalystRows(drivers, geo);
    const collapsedRaw = collapseCanonicalDrivers(collapsible);
    const driverById = new Map(drivers.map((driver) => [driver.eventId, driver]));
    const collapsed: CollapsedCatalystDriver[] = collapsedRaw.map((driver) => {
        if (driver.key === 'GEO_RISK_PREMIUM') {
            return {
                ...driver,
                supportingGuids: premium?.provenance.supportingGuids ?? [],
                provenanceReason: `regime score ${geo.score} (${geo.band}); escalation themes: ${geo.escalationThemes.join(', ')}`,
            };
        }
        if (driver.key === 'RATE_YIELD_REPRICING') {
            return {
                ...driver,
                supportingGuids: yld?.supportingGuids ?? [],
                provenanceReason: yld?.reason ?? null,
            };
        }
        const members = driver.memberEventIds.flatMap((eventId) => driverById.get(eventId)?.supportingGuids ?? []);
        const oilReason = driver.key.startsWith('OIL_SUPPLY_SHOCK')
            ? driverById.get(driver.representativeEventId)?.headline ?? driver.themeId
            : null;
        return { ...driver, supportingGuids: [...new Set(members)], oilChannel: oilReason ?? null };
    });
    const boardMap = reconstructCanonicalCatalyst(collapsible);
    const board = [...TRACKED_ASSETS].map((asset) => {
        const row = boardMap.get(asset) ?? { bullishCount: 0, bearishCount: 0, driverScore: 0, themes: [] };
        return { asset, bullishCount: row.bullishCount, bearishCount: row.bearishCount, driverScore: row.driverScore, driverIds: row.themes };
    });
    return { board, collapsed, yieldDriver: yld, geoPremium: premium };
}
