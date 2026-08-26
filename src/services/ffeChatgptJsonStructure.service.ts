/**
 * Structural validation for ChatGPT Project JSON responses.
 * Does NOT validate scores, methodology, arithmetic, or semantic content.
 */

export type ChatGptStructureIssue = { code: string; message: string };

export type ChatGptStructureValidationResult = {
    valid: boolean;
    issues: ChatGptStructureIssue[];
};

function hasNonEmptyBoard(board: unknown): boolean {
    if (Array.isArray(board)) return board.length > 0;
    if (board && typeof board === 'object' && !Array.isArray(board)) {
        return Object.keys(board).length > 0;
    }
    return false;
}

export function bridgeChatGptFieldNames(raw: Record<string, unknown>): Record<string, unknown> {
    const board = raw.final_board ?? raw.catalyst_board;
    const macro = raw.macro ?? raw.macro_board;
    const geo = raw.geo ?? raw.geopolitical_risk ?? raw.geo_regime;
    const oilAudit = raw.oil_audit ?? raw.oil;
    return {
        ...raw,
        ...(board != null ? { final_board: board } : {}),
        ...(macro != null ? { macro } : {}),
        ...(geo != null ? { geo } : {}),
        ...(oilAudit != null ? { oil_audit: oilAudit } : {}),
    };
}

export function validateChatGptJsonStructure(raw: Record<string, unknown>): ChatGptStructureValidationResult {
    const issues: ChatGptStructureIssue[] = [];
    const board = raw.final_board ?? raw.catalyst_board;
    if (!hasNonEmptyBoard(board)) {
        issues.push({
            code: 'MISSING_CATALYST_BOARD',
            message: 'final_board or catalyst_board must be a non-empty array or object',
        });
    }
    const geo = raw.geo ?? raw.geopolitical_risk ?? raw.geo_regime;
    if (!geo || typeof geo !== 'object' || Array.isArray(geo)) {
        issues.push({
            code: 'MISSING_GEO',
            message: 'geo (or geopolitical_risk) must be an object',
        });
    }
    const macro = raw.macro ?? raw.macro_board;
    if (macro != null && typeof macro !== 'object') {
        issues.push({
            code: 'INVALID_MACRO_BOARD',
            message: 'macro or macro_board must be an array or object when present',
        });
    }
    return { valid: issues.length === 0, issues };
}
