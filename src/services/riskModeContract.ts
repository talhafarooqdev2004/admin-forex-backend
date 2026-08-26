/**
 * Canonical Risk Mode contract shared by the read-only Daily Market snapshot.
 * Risk Mode is independent from geopolitical risk and Catalyst scoring.
 */
export const RISK_MODE_STATES = ['RISK_OFF', 'NEUTRAL', 'RISK_ON'] as const;
export type RiskModeState = (typeof RISK_MODE_STATES)[number];

export type ParsedRiskModeValue = {
    mode: RiskModeState;
    score: number | null;
    sourceKind: 'numeric' | 'label';
};

export type RiskModeContract = {
    mode: RiskModeState;
    score: number | null;
    updatedAt: string | null;
    asOf: string | null;
    source: string;
};

const MIN_SCORE = -100;
const MAX_SCORE = 100;
const RISK_OFF_MAX = -35;
const RISK_ON_MIN = 65;

export function clampRiskModeScore(score: number): number {
    return Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));
}

export function riskModeStateFromScore(score: number): RiskModeState {
    if (score < RISK_OFF_MAX) return 'RISK_OFF';
    if (score >= RISK_ON_MIN) return 'RISK_ON';
    return 'NEUTRAL';
}

function parseExplicitMode(value: string): RiskModeState | null {
    const text = value.trim().toUpperCase().replace(/[–—−]/g, '-');
    // Require a leading/standalone label. This intentionally does not classify a
    // sheet name such as "RISK ON/OFF 12" as a data value.
    if (/^RISK[\s_-]*ON\s*\/\s*OFF\b/i.test(text)) return null;
    if (/^RISK[\s_-]*OFF\s*\/\s*ON\b/i.test(text)) return null;
    if (/^(?:RISK[\s_-]*OFF|OFF|BEARISH)(?:\b|\s|[-:(])/i.test(text)) return 'RISK_OFF';
    if (/^(?:RISK[\s_-]*ON|ON|BULLISH)(?:\b|\s|[-:(])/i.test(text)) return 'RISK_ON';
    if (/^NEUTRAL(?:\b|\s|[-:(])/i.test(text)) return 'NEUTRAL';
    return null;
}

function parseNumeric(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? clampRiskModeScore(value) : null;
    if (typeof value !== 'string') return null;
    const text = value.trim().replace(/[–—−]/g, '-');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? clampRiskModeScore(parsed) : null;
}

/**
 * Parse the legacy score/label cell exactly once at the source boundary.
 * Empty, malformed, or unrelated text returns null instead of becoming zero.
 */
export function parseRiskModeSourceValue(value: unknown): ParsedRiskModeValue | null {
    const numeric = parseNumeric(value);
    if (numeric !== null) {
        return { mode: riskModeStateFromScore(numeric), score: numeric, sourceKind: 'numeric' };
    }

    if (typeof value !== 'string' || !value.trim()) return null;
    const mode = parseExplicitMode(value);
    if (!mode) return null;

    const numericMatch = value.replace(/[–—−]/g, '-').match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/);
    const labelledScore = numericMatch ? parseNumeric(numericMatch[0]) : null;
    return { mode, score: labelledScore, sourceKind: 'label' };
}

function riskModeUpdatedAt(riskModeRow: unknown): string | null {
    const updatedAt = (riskModeRow as Record<string, unknown> | null)?.updated_at;
    if (!updatedAt) return null;
    const date = new Date(String(updatedAt));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function resolveRiskModeContract(sheetValue: unknown, riskModeRow: unknown): RiskModeContract {
    const parsedSheetValue = parseRiskModeSourceValue(sheetValue);
    const asOf = riskModeUpdatedAt(riskModeRow);
    if (parsedSheetValue) {
        return {
            mode: parsedSheetValue.mode,
            score: parsedSheetValue.score,
            updatedAt: asOf,
            asOf,
            source: 'google_sheets:RISK ON/OFF 12!B13',
        };
    }

    const record = (riskModeRow ?? {}) as Record<string, unknown>;
    const parsedDatabaseValue = parseRiskModeSourceValue(record.score);
    if (parsedDatabaseValue) {
        return {
            mode: parsedDatabaseValue.mode,
            score: parsedDatabaseValue.score,
            updatedAt: asOf,
            asOf,
            source: 'database:risk_mode_scores',
        };
    }
    return unavailableRiskModeContract();
}

export function unavailableRiskModeContract(): RiskModeContract {
    // Existing Daily Market behavior is a neutral visual fallback. It is explicit
    // in the source field so an unavailable source is never mistaken for a real 0.
    return {
        mode: 'NEUTRAL',
        score: null,
        updatedAt: null,
        asOf: null,
        source: 'fallback:unavailable',
    };
}
