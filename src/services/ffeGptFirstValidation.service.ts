/**
 * GPT-first validation — integrity checks only. Never rewrites semantic scores.
 */

import { TRACKED_ASSETS } from './groqClassifier.service.js';
import type { GptFirstAnalysisOutput, GptFirstSessionInput } from './ffeGptFirstAnalysis.service.js';

export const ALLOWED_SCORES = new Set([-1, -0.5, -0.25, 0, 0.25, 0.5, 1]);
export const ALLOWED_DRIVER_CONTRIBUTION_VALUES = [...ALLOWED_SCORES] as const;
export const CATALYST_ASSETS = [...TRACKED_ASSETS] as const;
export const MACRO_ASSETS = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'] as const;
export const GEO_BANDS = ['LOW', 'WATCH', 'ELEVATED', 'HIGH', 'EXTREME'] as const;
export type GeoBand = (typeof GEO_BANDS)[number];

export const EVIDENCE_DISPOSITIONS = [
    'NEW_EVENT',
    'SAME_EVENT',
    'EVENT_UPDATE',
    'STRENGTHENING',
    'STRENGTHENING_EVIDENCE',
    'WEAKENING',
    'WEAKENING_EVIDENCE',
    'REVERSAL',
    'DE_ESCALATION',
    'CONFIRMATION',
    'PRICE_REACTION',
    'MACRO_RELEASE',
    'FORECAST_UPCOMING',
    'GEOPOLITICAL_EVIDENCE',
    'IRRELEVANT_ZERO',
    'IRRELEVANT',
    'HISTORICAL_COMMENTARY',
] as const;

export function collectCitedGuids(output: GptFirstAnalysisOutput, inputGuids?: ReadonlySet<string>): string[] {
    const guids = new Set<string>();
    const geoEntryOk = (guid: string) => Boolean(guid) && (!inputGuids || inputGuids.has(guid));
    for (const driver of output.drivers ?? []) {
        for (const guid of [...driver.supporting_guids, ...driver.confirmation_guids, ...driver.counter_guids]) {
            if (guid) guids.add(guid);
        }
    }
    for (const row of output.macro ?? []) {
        for (const guid of row.supporting_releases ?? []) {
            if (guid) guids.add(guid);
        }
    }
    for (const guid of output.geo?.escalation_evidence ?? []) {
        if (geoEntryOk(guid)) guids.add(guid);
    }
    for (const guid of output.geo?.de_escalation_evidence ?? []) {
        if (geoEntryOk(guid)) guids.add(guid);
    }
    for (const row of output.zero_scored_items ?? []) {
        if (row.guid) guids.add(row.guid);
    }
    return [...guids];
}

function validateGeoEvidenceGuids(output: GptFirstAnalysisOutput, inputGuids: ReadonlySet<string>, issues: ValidationIssue[]): void {
    for (const [field, values] of [
        ['escalation_evidence', output.geo?.escalation_evidence ?? []],
        ['de_escalation_evidence', output.geo?.de_escalation_evidence ?? []],
    ] as const) {
        for (const entry of values) {
            if (!inputGuids.has(entry)) {
                issues.push({
                    code: 'INVALID_GEO_EVIDENCE_GUID',
                    message: `geo.${field} must contain exact session GUIDs only; invalid entry: ${entry.slice(0, 80)}`,
                });
            }
        }
    }
}

export function expectedGeoBand(score: number): GeoBand | null {
    if (!Number.isFinite(score) || score < 0 || score > 1) return null;
    if (score <= 0.20) return 'LOW';
    if (score <= 0.40) return 'WATCH';
    if (score <= 0.65) return 'ELEVATED';
    if (score <= 0.85) return 'HIGH';
    return 'EXTREME';
}

export type ValidationIssue = { code: string; message: string; detail?: string };
export type ValidationResult = {
    valid: boolean;
    issues: ValidationIssue[];
    arithmeticProof: Array<{ asset: string; terms: number[]; sum: number; displayed: number; exact: boolean }>;
};

export function isAllowedIndividualDriverContribution(score: unknown): boolean {
    const num = Number(score);
    return Number.isFinite(num) && ALLOWED_SCORES.has(num);
}

function isQuarterStep(score: number): boolean {
    return isAllowedIndividualDriverContribution(score);
}

function pushIllegalContribution(
    issues: ValidationIssue[],
    location: string,
    value: unknown,
): void {
    if (value == null) return;
    const num = Number(value);
    if (!Number.isFinite(num)) {
        issues.push({
            code: 'INVALID_DRIVER_CONTRIBUTION',
            message: `${location}: non-numeric contribution ${String(value)}`,
        });
        return;
    }
    if (!isAllowedIndividualDriverContribution(num)) {
        issues.push({
            code: 'ILLEGAL_DRIVER_CONTRIBUTION',
            message: `${location}: contribution ${num} is not one of {-1, -0.5, -0.25, 0, +0.25, +0.5, +1}`,
        });
    }
}

/**
 * Validate individual driver contributions in the raw ChatGPT JSON transport shape.
 * Aggregate board/decomposition/regime totals are intentionally excluded.
 */
export function validateChatGptRawDriverContributions(raw: Record<string, unknown>): Pick<ValidationResult, 'valid' | 'issues'> {
    const issues: ValidationIssue[] = [];

    const catalystBoard = raw.catalyst_board;
    if (catalystBoard && typeof catalystBoard === 'object' && !Array.isArray(catalystBoard)) {
        for (const [asset, row] of Object.entries(catalystBoard as Record<string, unknown>)) {
            if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
            const drivers = (row as Record<string, unknown>).active_independent_drivers;
            if (!Array.isArray(drivers)) continue;
            drivers.forEach((driver, index) => {
                if (!driver || typeof driver !== 'object' || Array.isArray(driver)) return;
                pushIllegalContribution(
                    issues,
                    `catalyst_board.${asset}.active_independent_drivers[${index}].contribution`,
                    (driver as Record<string, unknown>).contribution,
                );
            });
        }
    }

    const ledger = Array.isArray(raw.canonical_driver_ledger) ? raw.canonical_driver_ledger : [];
    for (const [index, entry] of ledger.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const driver = entry as Record<string, unknown>;
        const driverId = String(driver.driver_id ?? driver.theme ?? index);
        const contributions = driver.contribution_per_asset;
        if (!contributions || typeof contributions !== 'object' || Array.isArray(contributions)) continue;
        for (const [asset, value] of Object.entries(contributions as Record<string, unknown>)) {
            pushIllegalContribution(
                issues,
                `canonical_driver_ledger.${driverId}.contribution_per_asset.${asset}`,
                value,
            );
        }
    }

    const goldDecomposition = raw.gold_decomposition;
    if (goldDecomposition && typeof goldDecomposition === 'object' && !Array.isArray(goldDecomposition)) {
        const channels = (goldDecomposition as Record<string, unknown>).channels;
        if (Array.isArray(channels)) {
            channels.forEach((channel, index) => {
                if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return;
                const row = channel as Record<string, unknown>;
                const label = String(row.channel ?? index);
                pushIllegalContribution(
                    issues,
                    `gold_decomposition.channels[${index}](${label}).score`,
                    row.score,
                );
            });
        }
    }

    if (Array.isArray(raw.oil_audit)) {
        raw.oil_audit.forEach((entry, index) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
            const row = entry as Record<string, unknown>;
            pushIllegalContribution(issues, `oil_audit[${index}].magnitude`, row.magnitude);
        });
    }

    const oilAggregate = raw.oil_aggregate_state;
    if (oilAggregate && typeof oilAggregate === 'object' && !Array.isArray(oilAggregate)) {
        const downstream = (oilAggregate as Record<string, unknown>).downstream_transmission;
        if (downstream && typeof downstream === 'object' && !Array.isArray(downstream)) {
            for (const [asset, entry] of Object.entries(downstream as Record<string, unknown>)) {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
                const row = entry as Record<string, unknown>;
                const value = row.magnitude ?? row.contribution;
                if (value != null) {
                    pushIllegalContribution(
                        issues,
                        `oil_aggregate_state.downstream_transmission.${asset}`,
                        value,
                    );
                }
            }
        }
    }

    if (Array.isArray(raw.drivers)) {
        raw.drivers.forEach((driver, driverIndex) => {
            if (!driver || typeof driver !== 'object' || Array.isArray(driver)) return;
            const row = driver as Record<string, unknown>;
            const driverId = String(row.driver_id ?? driverIndex);
            const contributions = row.contributions;
            if (!Array.isArray(contributions)) return;
            contributions.forEach((contrib, contribIndex) => {
                if (!contrib || typeof contrib !== 'object' || Array.isArray(contrib)) return;
                const item = contrib as Record<string, unknown>;
                const asset = String(item.asset ?? '?');
                pushIllegalContribution(
                    issues,
                    `drivers[${driverId}].contributions[${contribIndex}].${asset}`,
                    item.score ?? item.contribution,
                );
            });
        });
    }

    return { valid: issues.length === 0, issues };
}

export function validateGptFirstAnalysis(output: GptFirstAnalysisOutput, input: GptFirstSessionInput): ValidationResult {
    const issues: ValidationIssue[] = [];
    const inputGuids = new Set(input.items.map((row) => row.guid));

    for (const asset of CATALYST_ASSETS) {
        const row = output.final_board.find((entry) => entry.asset === asset);
        if (!row) issues.push({ code: 'MISSING_ASSET', message: `final_board missing ${asset}` });
    }

    const driverIds = new Set<string>();
    for (const driver of output.drivers) {
        if (driverIds.has(driver.driver_id)) {
            issues.push({ code: 'DUPLICATE_DRIVER', message: `duplicate driver_id ${driver.driver_id}` });
        }
        driverIds.add(driver.driver_id);
        for (const guid of [...driver.supporting_guids, ...driver.confirmation_guids, ...driver.counter_guids]) {
            if (!inputGuids.has(guid)) {
                issues.push({ code: 'UNKNOWN_GUID', message: `driver ${driver.driver_id} cites unknown GUID ${guid}` });
            }
        }
        for (const contrib of driver.contributions) {
            if (!CATALYST_ASSETS.includes(contrib.asset as typeof CATALYST_ASSETS[number])) {
                issues.push({ code: 'INVALID_ASSET', message: `driver ${driver.driver_id} invalid asset ${contrib.asset}` });
            }
            if (!isQuarterStep(contrib.score)) {
                issues.push({ code: 'INVALID_SCORE', message: `driver ${driver.driver_id} ${contrib.asset} score ${contrib.score} not a quarter step` });
            }
        }
        if (driver.status === 'ACTIVE') {
            const evaluations = driver.channel_evaluations ?? [];
            if (!evaluations.length) {
                issues.push({
                    code: 'MISSING_CHANNEL_EVALUATION',
                    message: `ACTIVE driver ${driver.driver_id} has no channel_evaluations`,
                });
            }
            const evaluated = new Set(evaluations.map((row) => String(row.channel).toUpperCase()));
            for (const contrib of driver.contributions) {
                if (!contrib.score) continue;
                const covered = evaluations.some((row) =>
                    row.decision === 'APPLIED'
                    && (String(row.asset ?? '').toUpperCase() === contrib.asset || String(row.channel).toUpperCase() === contrib.asset));
                if (!covered) {
                    issues.push({
                        code: 'UNAUDITED_CONTRIBUTION',
                        message: `driver ${driver.driver_id} applied ${contrib.asset} without a matching APPLIED channel evaluation`,
                    });
                }
            }
            const oilActive = driver.contributions.some((row) => row.asset === 'OIL' && row.score);
            if (oilActive) {
                for (const channel of ['OIL', 'CAD', 'JPY', 'EUR']) {
                    if (!evaluated.has(channel)) {
                        issues.push({
                            code: 'MISSING_OIL_CONTRACT_CHANNEL',
                            message: `ACTIVE Oil driver ${driver.driver_id} did not evaluate contract channel ${channel}`,
                        });
                    }
                }
            }
        }
    }

    for (const row of output.final_board) {
        if (!Number.isFinite(row.score)) {
            issues.push({ code: 'INVALID_BOARD_SCORE', message: `${row.asset} final score is not numeric` });
        }
    }

    for (const row of output.zero_scored_items ?? []) {
        if (row.guid && !inputGuids.has(row.guid)) {
            issues.push({ code: 'UNKNOWN_ZERO_GUID', message: `zero_scored_items cites unknown GUID ${row.guid}` });
        }
    }

    const dispositions = output.evidence_dispositions ?? [];
    const dispositionGuids = new Set<string>();
    const zeroLike = new Set(['IRRELEVANT_ZERO', 'IRRELEVANT', 'PRICE_REACTION', 'CONFIRMATION', 'FORECAST_UPCOMING', 'HISTORICAL_COMMENTARY']);
    for (const row of dispositions) {
        if (!row.guid) continue;
        if (!inputGuids.has(row.guid)) {
            issues.push({ code: 'UNKNOWN_DISPOSITION_GUID', message: `evidence_dispositions cites unknown GUID ${row.guid}` });
        }
        if (dispositionGuids.has(row.guid)) {
            issues.push({ code: 'DUPLICATE_EVIDENCE_DISPOSITION', message: `duplicate evidence_dispositions GUID ${row.guid}` });
        }
        dispositionGuids.add(row.guid);
        const label = String(row.disposition ?? '').trim().toUpperCase();
        if (!(EVIDENCE_DISPOSITIONS as readonly string[]).includes(label)) {
            issues.push({ code: 'INVALID_EVIDENCE_DISPOSITION', message: `GUID ${row.guid} has invalid disposition ${row.disposition}` });
        }
        if (row.driver_id && !driverIds.has(row.driver_id)) {
            issues.push({ code: 'UNKNOWN_DISPOSITION_DRIVER', message: `GUID ${row.guid} references unknown driver_id ${row.driver_id}` });
        }
        if (!row.driver_id && zeroLike.has(label) && !String(row.reason ?? '').trim()) {
            issues.push({ code: 'MISSING_DISPOSITION_REASON', message: `GUID ${row.guid} ${label} needs a compact reason` });
        }
    }
    for (const guid of collectCitedGuids(output, inputGuids)) {
        if (!dispositionGuids.has(guid)) {
            issues.push({
                code: 'MISSING_EVIDENCE_DISPOSITION',
                message: `cited GUID ${guid} is absent from evidence_dispositions`,
            });
        }
    }

    validateGeoEvidenceGuids(output, inputGuids, issues);

    const termsByAsset = new Map<string, number[]>();
    for (const driver of output.drivers) {
        if (driver.status !== 'ACTIVE') continue;
        for (const contrib of driver.contributions) {
            if (!contrib.score) continue;
            const terms = termsByAsset.get(contrib.asset) ?? [];
            terms.push(contrib.score);
            termsByAsset.set(contrib.asset, terms);
        }
    }

    const arithmeticProof = CATALYST_ASSETS.map((asset) => {
        const terms = termsByAsset.get(asset) ?? [];
        const sum = terms.reduce((a, b) => a + b, 0);
        const displayed = output.final_board.find((row) => row.asset === asset)?.score ?? 0;
        const exact = sum === displayed;
        if (!exact) {
            issues.push({
                code: 'ARITHMETIC_MISMATCH',
                message: `${asset}: driver sum ${sum} != final_board ${displayed}`,
                detail: terms.join(' + '),
            });
        }
        return { asset, terms, sum, displayed, exact };
    });

    if (output.session.input_count !== input.items.length) {
        issues.push({
            code: 'INPUT_COUNT_MISMATCH',
            message: `session.input_count ${output.session.input_count} != supplied ${input.items.length}`,
        });
    }

    const geoScore = output.geo?.score;
    const geoBand = String(output.geo?.band ?? '').trim().toUpperCase();
    if (!Number.isFinite(geoScore) || geoScore < 0 || geoScore > 1) {
        issues.push({ code: 'INVALID_GEO_SCORE', message: `geo.score ${geoScore} is outside 0..1` });
    } else if (!GEO_BANDS.includes(geoBand as GeoBand)) {
        issues.push({ code: 'INVALID_GEO_BAND', message: `geo.band ${output.geo.band} is not a recognized band` });
    } else {
        const expectedBand = expectedGeoBand(geoScore);
        if (expectedBand && geoBand !== expectedBand) {
            issues.push({
                code: 'GEO_BAND_MISMATCH',
                message: `geo.score ${geoScore} requires band ${expectedBand}, not ${geoBand}`,
            });
        }
    }

    return { valid: issues.length === 0, issues, arithmeticProof };
}
