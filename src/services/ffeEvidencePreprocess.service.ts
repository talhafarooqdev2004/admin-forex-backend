/**
 * Deterministic FinancialJuice evidence preprocessing.
 * Structural only: never scores markets and never drops news because a headline
 * begins with a country, nationality, or similar prefix.
 *
 * GPT-first consumes the complete native causal unit (title + adjacent explanatory
 * lines). Headline-only compression is forbidden when body/continuation text exists.
 */

import { createHash } from 'node:crypto';

export const FFE_PROMO_HEADLINES = new Set([
    'Go Real-time!',
    "Don't like Ads? GO PRO",
]);

const MACRO_FIELDS = /\bActual\s+(.+?)\s*\(\s*Forecast\s+([^,)]*),\s*Previous\s+([^)]*)\)\s*$/i;

export type ExtractedMacroFields = {
    actual?: string;
    forecast?: string;
    previous?: string;
};

export type EvidenceLineClass = 'empty' | 'promo' | 'fx_pair' | 'chrome' | 'news';

export type AssembledFinancialJuiceUnit = {
    headline: string;
    supporting_lines: string[];
    body: string;
    actual?: string;
    forecast?: string;
    previous?: string;
};

export type FinancialJuiceSourceUnitFingerprintInput = {
    guid: string;
    time: string;
    headline: string;
    body?: string | null;
    actual?: string | null;
    forecast?: string | null;
    previous?: string | null;
    source_label?: string | null;
};

/** One timestamp-delimited block from a FinancialJuice snapshot paste. */
export type ParsedSnapshotSourceBlock = {
    time: string;
    source: 'FinancialJuice' | 'FXStreet';
    lines: string[];
};

export type RetainedSnapshotUnit = {
    time: string;
    source: 'FinancialJuice';
    headline: string;
    body: string;
    supporting_lines: string[];
    actual?: string;
    forecast?: string;
    previous?: string;
};

const SNAPSHOT_TIMESTAMP_LINE_RE = /^(\d{2}):(\d{2})\s+Aug\s+(\d{2})(FXStreet)?(.*)$/i;

type SnapshotTimestampMatch = {
    hour: string;
    minute: string;
    day: string;
    isFxStreet: boolean;
    index: number;
    length: number;
};

function normalizeSnapshotTime(hour: string, minute: string, day: string): string {
    return `${day.padStart(2, '0')}/08/2026, ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

function linesBetween(text: string, start: number, end: number): string[] {
    return text.slice(start, end).split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function parseSnapshotTimestampMatches(text: string): SnapshotTimestampMatch[] {
    return [...text.matchAll(new RegExp(SNAPSHOT_TIMESTAMP_LINE_RE.source, 'gim'))].map((match) => ({
        hour: match[1]!,
        minute: match[2]!,
        day: match[3]!,
        isFxStreet: Boolean(match[4]),
        index: match.index ?? 0,
        length: match[0].length,
    }));
}

/**
 * Detect whether a timestamp block uses headline-before-timestamp layout (Aug19-style)
 * or headline-after-timestamp layout (reverse-chron Aug20/21-style).
 * Never infer source identity from adjacent blocks.
 */
export function isHeadlineBeforeTimestampLayout(beforeLines: string[], afterLines: string[]): boolean {
    const beforeHasNews = beforeLines.some((line) => classifyEvidenceLine(line) === 'news');
    if (!beforeHasNews) return false;

    const firstAfterNewsIdx = afterLines.findIndex((line) => classifyEvidenceLine(line) === 'news');
    if (firstAfterNewsIdx < 0) return true;

    const prefix = afterLines.slice(0, firstAfterNewsIdx);
    if (prefix.length > 0 && prefix.every((line) => isFinancialJuiceChromeLine(line))) {
        return true;
    }

    if (firstAfterNewsIdx === 0) return false;
    if (firstAfterNewsIdx <= 2 && prefix.every((line) => !line || isFinancialJuiceChromeLine(line))) {
        return false;
    }

    return true;
}

/** Select lines that belong to the SAME timestamp block — not a neighboring block. */
export function selectSnapshotBlockLines(beforeLines: string[], afterLines: string[]): string[] {
    return isHeadlineBeforeTimestampLayout(beforeLines, afterLines) ? beforeLines : afterLines;
}

/**
 * Parse a raw FinancialJuice snapshot into atomic timestamp blocks with explicit source identity.
 * Each block owns exactly one timestamp line and the headline/body lines bound to that timestamp.
 */
export function parseFinancialJuiceSnapshotBlocks(raw: string): ParsedSnapshotSourceBlock[] {
    const text = raw.replace(/\r\n/g, '\n').replace(/\t/g, '');
    const matches = parseSnapshotTimestampMatches(text);
    const blocks: ParsedSnapshotSourceBlock[] = [];

    for (let i = 0; i < matches.length; i += 1) {
        const match = matches[i]!;
        const prevEnd = i === 0 ? 0 : matches[i - 1]!.index + matches[i - 1]!.length;
        const nextStart = i + 1 < matches.length ? matches[i + 1]!.index : text.length;
        const tsStart = match.index;
        const tsEnd = tsStart + match.length;
        const beforeLines = linesBetween(text, prevEnd, tsStart);
        const afterLines = linesBetween(text, tsEnd, nextStart);
        const lines = selectSnapshotBlockLines(beforeLines, afterLines);

        blocks.push({
            time: normalizeSnapshotTime(match.hour, match.minute, match.day),
            source: match.isFxStreet ? 'FXStreet' : 'FinancialJuice',
            lines,
        });
    }

    return blocks;
}

/** Retain native FinancialJuice units from a raw snapshot; exclude FXStreet and promo/chrome. */
export function retainFinancialJuiceSnapshotUnits(raw: string): {
    totalParsed: number;
    fxstreetExcluded: number;
    junkExcluded: number;
    retained: RetainedSnapshotUnit[];
} {
    const blocks = parseFinancialJuiceSnapshotBlocks(raw);
    let fxstreetExcluded = 0;
    let junkExcluded = 0;
    const retained: RetainedSnapshotUnit[] = [];

    for (const block of blocks) {
        if (block.source === 'FXStreet') {
            fxstreetExcluded += 1;
            continue;
        }
        const unit = assembleFinancialJuiceEvidenceUnit(block.lines);
        if (!unit || FFE_PROMO_HEADLINES.has(unit.headline)) {
            if (unit && FFE_PROMO_HEADLINES.has(unit.headline)) junkExcluded += 1;
            continue;
        }
        retained.push({
            time: block.time,
            source: 'FinancialJuice',
            headline: unit.headline,
            body: unit.body,
            supporting_lines: unit.supporting_lines,
            actual: unit.actual,
            forecast: unit.forecast,
            previous: unit.previous,
        });
    }

    return {
        totalParsed: blocks.length,
        fxstreetExcluded,
        junkExcluded,
        retained,
    };
}

export function extractMacroFields(headline: string): ExtractedMacroFields {
    const match = MACRO_FIELDS.exec(headline.trim());
    if (!match) return {};
    return {
        actual: match[1]!.trim(),
        forecast: match[2]!.trim(),
        previous: match[3]!.trim(),
    };
}

/** Timestamp capture group is FXStreet when the time line itself is labelled FXStreet. */
export function isFxStreetTimestamp(timeLineRemainder: string | undefined | null): boolean {
    return Boolean(timeLineRemainder && /^FXStreet\b/i.test(String(timeLineRemainder).trim()));
}

export function classifyEvidenceLine(raw: string): EvidenceLineClass {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) return 'empty';
    if (FFE_PROMO_HEADLINES.has(line)) return 'promo';
    if (/^[A-Z]{3}\/[A-Z]{3}:/.test(line)) return 'fx_pair';
    if (/^\*\*[A-Z]{3}\/[A-Z]{3}/.test(line)) return 'fx_pair';
    if (looksLikeNewsHeadline(line)) return 'news';
    if (looksLikeUiChrome(line)) return 'chrome';
    return 'news';
}

/**
 * Keep a candidate headline unless it is deterministically unusable UI/promo/pair chrome.
 * Country/nationality prefixes are not a reason to drop.
 */
export function isRetainableFinancialJuiceHeadline(line: string): boolean {
    const kind = classifyEvidenceLine(line);
    return kind === 'news';
}

export function isFinancialJuiceChromeLine(line: string): boolean {
    const kind = classifyEvidenceLine(line);
    return kind === 'empty' || kind === 'promo' || kind === 'fx_pair' || kind === 'chrome';
}

/**
 * Title-only helper. Do not use this as the GPT-first evidence representation.
 * Multi-line native blocks must go through assembleFinancialJuiceEvidenceUnit().
 */
export function pickFinancialJuiceHeadline(lines: string[]): string {
    return assembleFinancialJuiceEvidenceUnit(lines)?.headline ?? '';
}

/**
 * Preserve the complete native FinancialJuice causal unit from a timestamp block:
 * first retainable news line as title, remaining native news lines as supporting body.
 * Promo, FX pair wraps, navigation, and chrome are dropped. Source wording/order is kept.
 * Does not add outside information or synthesize facts.
 */
export function assembleFinancialJuiceEvidenceUnit(lines: string[]): AssembledFinancialJuiceUnit | null {
    const newsLines: string[] = [];
    for (const raw of lines) {
        const line = raw.replace(/\s+/g, ' ').trim();
        if (!line) continue;
        if (classifyEvidenceLine(line) !== 'news') continue;
        newsLines.push(line);
    }
    if (!newsLines.length) return null;

    const headline = newsLines[0]!;
    const supporting_lines = newsLines.slice(1);
    const body = supporting_lines.join('\n');
    const macro = firstDefinedMacro(
        extractMacroFields(headline),
        ...supporting_lines.map(extractMacroFields),
        extractMacroFields([headline, body].filter(Boolean).join(' ')),
    );

    return {
        headline,
        supporting_lines,
        body,
        ...macro,
    };
}

function firstDefinedMacro(...candidates: ExtractedMacroFields[]): ExtractedMacroFields {
    return candidates.find((row) => row.actual !== undefined || row.forecast !== undefined || row.previous !== undefined) ?? {};
}

export function fingerprintFinancialJuiceSourceUnit(input: FinancialJuiceSourceUnitFingerprintInput): string {
    return createHash('sha256').update(JSON.stringify({
        guid: input.guid,
        time: input.time,
        headline: input.headline,
        body: input.body ?? '',
        actual: input.actual ?? null,
        forecast: input.forecast ?? null,
        previous: input.previous ?? null,
        source_label: input.source_label ?? 'FinancialJuice',
    })).digest('hex');
}

export function snapshotTimeToEpoch(value: string | null | undefined): number {
    return Date.parse(String(value).replace(
        /^(\d{2})\/(\d{2})\/(\d{4}),\s+(\d{2}):(\d{2})$/,
        '$3-$2-$1T$4:$5:00+04:00',
    ));
}

export type ChronologicalSourceUnitInput = {
    guid?: string;
    time?: string | null;
    source?: string;
    source_label?: string;
    headline?: string;
    body?: string;
    supporting_lines?: string[];
    actual?: string | null;
    forecast?: string | null;
    previous?: string | null;
};

export type ChronologicalSourceUnit = ChronologicalSourceUnitInput & {
    guid: string;
    source: string;
    source_label: string;
    headline: string;
    body: string;
    supporting_lines: string[];
    actual: string | null;
    forecast: string | null;
    previous: string | null;
    original_order: number;
    source_unit_hash: string;
};

export function chronologicalSourceUnits(
    units: ChronologicalSourceUnitInput[],
    { guidPrefix = 'unit' }: { guidPrefix?: string } = {},
): ChronologicalSourceUnit[] {
    return [...units]
        .sort((a, b) => snapshotTimeToEpoch(a.time) - snapshotTimeToEpoch(b.time))
        .map((unit, index) => {
            const guid = unit.guid || `${guidPrefix}${String(index + 1).padStart(5, '0')}`;
            const source_label = unit.source || unit.source_label || 'FinancialJuice';
            const row: ChronologicalSourceUnit = {
                time: unit.time,
                source: source_label,
                source_label,
                guid,
                headline: String(unit.headline || ''),
                body: unit.body || '',
                supporting_lines: unit.supporting_lines || [],
                actual: unit.actual ?? null,
                forecast: unit.forecast ?? null,
                previous: unit.previous ?? null,
                original_order: index + 1,
                source_unit_hash: '',
            };
            row.source_unit_hash = fingerprintFinancialJuiceSourceUnit({
                guid: row.guid,
                time: String(row.time || ''),
                headline: row.headline,
                body: row.body,
                actual: row.actual,
                forecast: row.forecast,
                previous: row.previous,
                source_label: row.source_label,
            });
            return row;
        });
}

function looksLikeNewsHeadline(line: string): boolean {
    if (/\bActual\b/i.test(line) && /\b(Forecast|Previous)\b/i.test(line)) return true;
    const words = line.split(/\s+/).filter(Boolean);
    if (/\d/.test(line) && words.length >= 3) return true;
    if (/[.!?:]/.test(line) && words.length >= 3) return true;
    if (words.length >= 5) return true;
    return false;
}

function looksLikeUiChrome(line: string): boolean {
    const words = line.split(/\s+/).filter(Boolean);
    if (/^(Forex|Energy|Agriculture|Metal|Market Moving)$/i.test(line)) return true;
    if (line.length >= 80) return false;
    if (/\d/.test(line)) return false;
    if (/[.!?]/.test(line)) return false;
    if (words.length === 1) return true;
    if (/[a-z][A-Z]/.test(line)) return true;
    if (words.length <= 3 && line.length < 40) return true;
    return false;
}
