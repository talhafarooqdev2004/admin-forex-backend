/**
 * Extract JSON from ChatGPT Project raw responses.
 * JSON only — no prose parsing or semantic inference.
 */
import { logger } from '../utils/logger.util.js';
import { bridgeChatGptFieldNames } from './ffeChatgptJsonStructure.service.js';

function isControlCharacterInStringError(error: unknown): boolean {
    if (!(error instanceof SyntaxError)) return false;
    return /Bad control character in string literal/i.test(error.message)
        || /control character/i.test(error.message);
}

/**
 * Escape literal CR/LF/TAB (and other U+0000–U+001F) inside JSON string literals only.
 * Whitespace outside quoted strings is left unchanged.
 */
export function sanitizeJsonStringControlCharacters(raw: string): string {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if (inString) {
            if (escaped) {
                result += ch;
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                result += ch;
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
                result += ch;
                continue;
            }
            if (ch === '\n') {
                result += '\\n';
                continue;
            }
            if (ch === '\r') {
                result += '\\r';
                continue;
            }
            if (ch === '\t') {
                result += '\\t';
                continue;
            }
            const code = ch.charCodeAt(0);
            if (code < 0x20) {
                result += `\\u${code.toString(16).padStart(4, '0')}`;
                continue;
            }
            result += ch;
            continue;
        }
        if (ch === '"') {
            inString = true;
            result += ch;
            continue;
        }
        result += ch;
    }
    return result;
}

type JsonParseAttempt = {
    parsed: Record<string, unknown> | null;
    sanitized: boolean;
};

function coerceParsedObject(parsed: unknown): Record<string, unknown> | null {
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
}

function tryParseJson(text: string): JsonParseAttempt {
    try {
        return { parsed: coerceParsedObject(JSON.parse(text)), sanitized: false };
    } catch (firstError) {
        if (!isControlCharacterInStringError(firstError)) {
            return { parsed: null, sanitized: false };
        }
        try {
            const sanitizedText = sanitizeJsonStringControlCharacters(text);
            return {
                parsed: coerceParsedObject(JSON.parse(sanitizedText)),
                sanitized: true,
            };
        } catch {
            return { parsed: null, sanitized: true };
        }
    }
}

function extractFencedJsonBlocks(raw: string): string[] {
    const blocks: string[] = [];
    const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = fenceRe.exec(raw)) !== null) {
        const body = String(match[1] || '').trim();
        if (body) blocks.push(body);
    }
    return blocks;
}

function extractBalancedObject(raw: string): string | null {
    const start = raw.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i];
        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') depth += 1;
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) return raw.slice(start, i + 1);
        }
    }
    return null;
}

function hasNonEmptyBoard(board: unknown): boolean {
    if (Array.isArray(board)) return board.length > 0;
    if (board && typeof board === 'object' && !Array.isArray(board)) {
        return Object.keys(board).length > 0;
    }
    return false;
}

function looksLikeFfeJson(value: Record<string, unknown>): boolean {
    const bridged = bridgeChatGptFieldNames(value);
    const hasBoard = hasNonEmptyBoard(bridged.final_board);
    const hasGeo = Boolean(bridged.geo) && typeof bridged.geo === 'object' && !Array.isArray(bridged.geo);
    return hasBoard && hasGeo;
}

export type ChatGptResponseParseResult = {
    ok: boolean;
    parsed: Record<string, unknown> | null;
    strategy: string | null;
    status?: 'JSON_PARSED' | 'PARSE_FAILED';
    failed_field?: string;
    error?: string;
};

export function parseChatGptRawResponse(raw: string): ChatGptResponseParseResult {
    const text = String(raw || '').trim();
    if (!text) {
        return { ok: false, parsed: null, strategy: null, status: 'PARSE_FAILED', error: 'Empty ChatGPT response' };
    }

    const candidates: Array<{ parsed: Record<string, unknown>; strategy: string }> = [];
    const direct = tryParseJson(text);
    if (direct.parsed) {
        candidates.push({
            parsed: direct.parsed,
            strategy: direct.sanitized ? 'direct_json_sanitized' : 'direct_json',
        });
    }
    for (const block of extractFencedJsonBlocks(text)) {
        const parsed = tryParseJson(block);
        if (parsed.parsed) {
            candidates.push({
                parsed: parsed.parsed,
                strategy: parsed.sanitized ? 'fenced_json_sanitized' : 'fenced_json',
            });
        }
    }
    const balanced = extractBalancedObject(text);
    if (balanced) {
        const parsed = tryParseJson(balanced);
        if (parsed.parsed) {
            candidates.push({
                parsed: parsed.parsed,
                strategy: parsed.sanitized ? 'balanced_object_sanitized' : 'balanced_object',
            });
        }
    }

    for (const candidate of candidates) {
        if (!looksLikeFfeJson(candidate.parsed)) continue;
        return {
            ok: true,
            parsed: bridgeChatGptFieldNames(candidate.parsed),
            strategy: candidate.strategy,
            status: 'JSON_PARSED',
        };
    }

    if (candidates.length > 0) {
        return {
            ok: false,
            parsed: null,
            strategy: candidates[0].strategy,
            status: 'PARSE_FAILED',
            failed_field: 'structure',
            error: 'CHATGPT_RESPONSE_INVALID: JSON parsed but missing required FFE fields (catalyst board + geo)',
        };
    }

    logger.warn('[FfeChatgptParser] No valid JSON object found in ChatGPT response');
    return {
        ok: false,
        parsed: null,
        strategy: null,
        status: 'PARSE_FAILED',
        failed_field: 'format',
        error: 'CHATGPT_RESPONSE_INVALID: response does not contain parseable JSON',
    };
}
