/**
 * Deterministic parser for FFE prose session briefs returned by ChatGPT Project automation.
 * Extracts only explicitly present fields — no semantic inference or score fabrication.
 */
import { TRACKED_ASSETS } from './groqClassifier.service.js';
import { ALLOWED_SCORES, EVIDENCE_DISPOSITIONS } from './ffeGptFirstValidation.service.js';

const CURRENCY_ASSETS = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'] as const;
const ALL_BOARD_ASSETS = [...TRACKED_ASSETS] as const;

export type FfeProseParseContext = {
    sessionItems?: Array<{ guid: string; original_order?: number }>;
    businessDay?: string;
    cutoff?: string;
    inputCount?: number;
};

export type FfeProseParseOutcome = {
    detected: boolean;
    parsed: Record<string, unknown> | null;
    failed_field?: string;
    error?: string;
    warnings: string[];
};

const UNICODE_MINUS = /[−–—]/g;
const CONTRIBUTION_LINE_RE = /^(USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|GOLD|OIL)\s*([+\-−–—]?)\s*(\d+(?:\.\d+)?)/i;
const DRIVER_ID_RE = /^[A-Z][A-Z0-9_]{3,}$/;
const DISPOSITION_SET = new Set<string>(EVIDENCE_DISPOSITIONS);
const SKIP_CONTRIBUTION_LINE_RE = /not separately added|macro separately|potential, but not|not separately double-counted|not separately counted/i;

function normalizeWhitespace(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

function parseScore(value: string): number {
    const cleaned = String(value ?? '').replace(UNICODE_MINUS, '-').trim();
    const match = cleaned.match(/([+\-]?)\s*(\d+(?:\.\d+)?)/);
    if (!match) return Number.NaN;
    const sign = match[1] === '-' ? -1 : 1;
    return sign * Number.parseFloat(match[2]);
}

function biasFromScore(score: number, label = ''): 'Bullish' | 'Bearish' | 'Neutral' {
    const lower = label.toLowerCase();
    if (lower.includes('bullish')) return 'Bullish';
    if (lower.includes('bearish')) return 'Bearish';
    if (score > 0) return 'Bullish';
    if (score < 0) return 'Bearish';
    return 'Neutral';
}

function slugId(prefix: string, label: string): string {
    const slug = label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
    return `${prefix}_${slug || 'UNNAMED'}`;
}

function splitNumberedSections(text: string): Map<string, string> {
    const sections = new Map<string, string>();
    const re = /^(\d+)\.\s+(.+)$/gm;
    const matches = [...text.matchAll(re)];
    for (let i = 0; i < matches.length; i += 1) {
        const title = matches[i][2].trim().toLowerCase();
        const start = (matches[i].index ?? 0) + matches[i][0].length;
        const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
        sections.set(title, text.slice(start, end).trim());
    }
    return sections;
}

function findSection(sections: Map<string, string>, ...needles: string[]): string {
    for (const [title, body] of sections) {
        if (needles.some((needle) => title.includes(needle))) return body;
    }
    return '';
}

function parseSessionHeader(text: string, context?: FfeProseParseContext): Record<string, unknown> {
    const businessDayMatch = text.match(/\b([A-Za-z]+ \d{1,2}, \d{4})\b/);
    const cutoffMatch = text.match(/cutoff\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+\d{2}:\d{2})/i)
        || text.match(/Frozen cutoff:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4},?\s+\d{2}:\d{2})/i)
        || text.match(/Frozen(?: causal analysis)? at\s+(\d{2}:\d{2})/i);
    const countMatch = text.match(/(\d+)\s+(?:retained units|native units)/i);
    const parsedDay = businessDayMatch
        ? new Date(businessDayMatch[1]).toISOString().slice(0, 10)
        : '';
    const businessDay = context?.businessDay || parsedDay;
    const cutoff = context?.cutoff || cutoffMatch?.[1] || businessDay;
    const inputCount = context?.inputCount
        ?? (countMatch ? Number.parseInt(countMatch[1], 10) : context?.sessionItems?.length ?? 0);
    return {
        source: 'FinancialJuice RSS feed',
        business_day: businessDay,
        cutoff,
        input_count: inputCount,
        input_hash: '',
    };
}

function parseAssetScoreLines(block: string): Map<string, { score: number; bias: string; explanation: string }> {
    const rows = new Map<string, { score: number; bias: string; explanation: string }>();
    for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const tabParts = trimmed.split('\t').map((part) => part.trim());
        if (tabParts.length >= 2 && ALL_BOARD_ASSETS.includes(tabParts[0].toUpperCase() as typeof ALL_BOARD_ASSETS[number])) {
            const asset = tabParts[0].toUpperCase();
            const score = parseScore(tabParts[1]);
            if (!Number.isFinite(score)) continue;
            const biasLabel = tabParts[2] || '';
            rows.set(asset, {
                score,
                bias: biasFromScore(score, biasLabel),
                explanation: tabParts[3] || tabParts.slice(2).join('; ') || '',
            });
            continue;
        }
        const inline = trimmed.match(/^(USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|GOLD|OIL)\s+([+\-−–—]?\s*\d+(?:\.\d+)?)/i);
        if (inline) {
            const asset = inline[1].toUpperCase();
            const score = parseScore(inline[2]);
            if (!Number.isFinite(score)) continue;
            rows.set(asset, {
                score,
                bias: biasFromScore(score),
                explanation: trimmed.slice(inline[0].length).trim(),
            });
        }
    }
    return rows;
}

function closingBoardSection(sections: Map<string, string>): string {
    return findSection(sections, 'final session state', 'final frozen board', 'frozen board');
}

function parseFinalBoard(sections: Map<string, string>): Array<Record<string, unknown>> {
    const sessionState = closingBoardSection(sections);
    let rows = new Map<string, { score: number; bias: string; explanation: string }>();
    if (sessionState) {
        const catalystBlock = sessionState.split(/\nMacro\b/i)[0] || sessionState;
        const catalystOnly = catalystBlock.replace(/^Catalyst\s*/i, '').trim();
        rows = parseAssetScoreLines(catalystOnly);
    }
    if (!rows.size) {
        const finalBoard = findSection(sections, 'final board');
        rows = parseAssetScoreLines(finalBoard);
    }
    return ALL_BOARD_ASSETS.map((asset) => {
        const row = rows.get(asset);
        const score = row?.score ?? 0;
        return {
            asset,
            score,
            bias: row?.bias ?? biasFromScore(score),
            driver_refs: [],
            explanation: row?.explanation || (score ? 'Parsed from prose session brief' : 'No active driver'),
        };
    });
}

function parseMacroBoard(sections: Map<string, string>): Array<Record<string, unknown>> {
    const sessionState = closingBoardSection(sections);
    let rows = new Map<string, { score: number; bias: string; explanation: string }>();
    if (sessionState) {
        const macroMatch = sessionState.match(/\nMacro\s*([\s\S]*?)(?:\nGeopolitical regime|\nSession state|\nFundamental session read|$)/i);
        if (macroMatch) rows = parseAssetScoreLines(macroMatch[1]);
    }
    if (!rows.size) {
        const macroBoard = findSection(sections, 'macro board');
        rows = parseAssetScoreLines(macroBoard);
        for (const line of macroBoard.split('\n')) {
            const parts = line.split('\t').map((part) => part.trim());
            if (parts.length < 2) continue;
            const asset = parts[0].toUpperCase();
            if (!CURRENCY_ASSETS.includes(asset as typeof CURRENCY_ASSETS[number])) continue;
            const score = parseScore(parts[1]);
            if (!Number.isFinite(score)) continue;
            rows.set(asset, {
                score,
                bias: biasFromScore(score),
                explanation: parts.slice(4).join(' ') || parts[2] || '',
            });
        }
    }
    return CURRENCY_ASSETS.map((asset) => {
        const row = rows.get(asset);
        const score = row?.score ?? 0;
        return {
            asset,
            score,
            health: score ? 'material' : 'none',
            reasoning: row?.explanation || (score ? 'Parsed from prose macro board' : 'No qualifying macro release'),
            supporting_releases: [],
        };
    });
}

function isEmbeddedContribution(statusLine: string, block: string): boolean {
    const combined = `${statusLine}\n${block}`.toLowerCase();
    return combined.includes('embedded in')
        || combined.includes('not separately double-counted')
        || combined.includes('not separately counted');
}

function isDriverActive(statusLine: string, hasContribution: boolean, embedded: boolean): boolean {
    if (embedded) return false;
    const status = statusLine.toUpperCase();
    if (/\bACTIVE\b/.test(status)) return true;
    if (!hasContribution) return false;
    if (/\bNEW_EVENT\b/.test(status) && !/\bACTIVE\b/.test(status)) return false;
    if (/\bSTRENGTHENING\b/.test(status) && !/\bWEAKENING\b/.test(status)) return true;
    if (/\bBEARISH\b/.test(status)) return true;
    if (/\bWEAKENING\b/.test(status)) {
        return /\bOIL\b/.test(status) || /\bBULL\b/.test(status);
    }
    return false;
}

function makeDriver(partial: {
    driver_id: string;
    canonical_label: string;
    fundamental_cause: string;
    category: string;
    status: string;
    state_change: string;
    contributions: Array<Record<string, unknown>>;
    why_active?: string;
    why_independent?: string;
}): Record<string, unknown> {
    const status = (['ACTIVE', 'WATCH', 'RESOLVED', 'REVERSED'].includes(partial.status)
        ? partial.status
        : 'WATCH') as string;
    return {
        driver_id: partial.driver_id,
        canonical_label: partial.canonical_label,
        fundamental_cause: partial.fundamental_cause,
        category: partial.category,
        status,
        state_change: partial.state_change,
        first_seen: '',
        last_updated: '',
        strength: partial.state_change,
        directness: 'direct',
        event_relation: partial.state_change.split('/')[0]?.trim() || partial.state_change,
        magnitude_reason: '',
        applicable_transmission_channels: partial.contributions.map((row) => String(row.asset)),
        channel_evaluations: [],
        applied_channels: [],
        rejected_channels: [],
        contributions: partial.contributions,
        supporting_guids: [],
        confirmation_guids: [],
        counter_guids: [],
        observed_reaction: null,
        why_active: partial.why_active || partial.state_change,
        why_independent: partial.why_independent || '',
        confidence: status === 'ACTIVE' ? 0.7 : 0.5,
    };
}

function parseContributions(block: string): Array<Record<string, unknown>> {
    const contributions: Array<Record<string, unknown>> = [];
    const contribSection = block.match(
        /(?:^|\n)Contributions?\s*\n([\s\S]*?)(?:\n(?:Supporting evidence|Evidence|Counter-evidence|Channels rejected|Channels\b|Why it remains|Why independent|Why only|Mechanism|Classification|Opposing driver|Rejected:|Gold\b|$))/i,
    );
    const lines = contribSection ? contribSection[1].split('\n') : block.split('\n');
    const seen = new Set<string>();
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || /^Contributions?$/i.test(trimmed)) continue;
        if (SKIP_CONTRIBUTION_LINE_RE.test(trimmed)) continue;
        const match = trimmed.match(CONTRIBUTION_LINE_RE);
        if (!match) continue;
        const asset = match[1].toUpperCase();
        const score = parseScore(`${match[2] || ''}${match[3]}`);
        if (!Number.isFinite(score) || seen.has(asset)) continue;
        seen.add(asset);
        contributions.push({
            asset,
            score,
            bias: biasFromScore(score),
            reason: trimmed,
        });
    }
    const goldMatch = block.match(/Geo contribution:\s*([+\-−–—]?\s*\d+(?:\.\d+)?)/i);
    if (goldMatch && !seen.has('GOLD')) {
        const score = parseScore(goldMatch[1]);
        if (Number.isFinite(score)) {
            contributions.push({
                asset: 'GOLD',
                score,
                bias: biasFromScore(score),
                reason: `Geo contribution: ${goldMatch[1].trim()}`,
            });
        }
    }
    return contributions;
}

function parseDriverBlocks(causalLedger: string): Array<Record<string, unknown>> {
    const lines = causalLedger.split('\n');
    const blocks: Array<{ id: string; body: string }> = [];
    let current: { id: string; body: string } | null = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (DRIVER_ID_RE.test(trimmed)) {
            if (current) blocks.push(current);
            current = { id: trimmed, body: '' };
            continue;
        }
        if (current) current.body += `${line}\n`;
    }
    if (current) blocks.push(current);

    return blocks.map(({ id, body }) => {
        const statusMatch = body.match(/(?:^|\n)Status:\s*(.+)/i);
        const statusLine = statusMatch?.[1]?.trim() || '';
        const causeMatch = body.match(/(?:^|\n)(?:Fundamental cause|Cause):\s*(.+)/i);
        const independentMatch = body.match(/(?:^|\n)(?:Independent because|Why independent):\s*(.+)/i);
        const whyActiveMatch = body.match(/(?:^|\n)Why it remains active:\s*([\s\S]*?)(?:\n[A-Z][a-z]+:|$)/i);
        const embedded = isEmbeddedContribution(statusLine, body);
        const contributions = embedded ? [] : parseContributions(body);
        const status = isDriverActive(statusLine, contributions.length > 0, embedded) ? 'ACTIVE' : 'WATCH';
        const category = id.startsWith('GEO_') || id.startsWith('OIL_AUDIT_') ? (id.startsWith('GEO_') ? 'geopolitical' : 'oil')
            : id.startsWith('OIL_') ? 'oil'
            : id.includes('ECB') || id.includes('BOJ') || id.includes('RBA') || id.includes('FED') ? 'policy'
            : 'macro';
        return makeDriver({
            driver_id: id,
            canonical_label: id.replace(/_/g, ' '),
            fundamental_cause: causeMatch?.[1]?.trim() || '',
            category,
            status,
            state_change: statusLine,
            contributions,
            why_active: whyActiveMatch?.[1]?.trim() || statusLine,
            why_independent: independentMatch?.[1]?.trim() || '',
        });
    });
}

function mapDispositionLabel(raw: string): string {
    const upper = raw.toUpperCase();
    for (const label of EVIDENCE_DISPOSITIONS) {
        if (upper.includes(label)) return label;
    }
    if (upper.includes('DE-ESCALATION') || upper.includes('DE_ESCALATION')) return 'DE_ESCALATION';
    if (upper.includes('IRRELEVANT')) return 'IRRELEVANT_ZERO';
    if (upper.includes('PRICE')) return 'PRICE_REACTION';
    if (upper.includes('FORECAST')) return 'FORECAST_UPCOMING';
    if (upper.includes('CONFIRMATION')) return 'CONFIRMATION';
    if (upper.includes('MACRO')) return 'MACRO_RELEASE';
    if (upper.includes('GEOPOLITICAL')) return 'GEOPOLITICAL_EVIDENCE';
    if (upper.includes('COUNTER')) return 'WEAKENING';
    if (upper.includes('CONTEXT')) return 'IRRELEVANT_ZERO';
    return 'NEW_EVENT';
}

function expandUnitRange(range: string): number[] {
    const normalized = range.replace(/[–—]/g, '-').trim();
    if (!normalized) return [];
    if (normalized.includes('-')) {
        const [startRaw, endRaw] = normalized.split('-');
        const start = Number.parseInt(startRaw.trim(), 10);
        const end = Number.parseInt(endRaw.trim(), 10);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
        const orders: number[] = [];
        for (let i = Math.min(start, end); i <= Math.max(start, end); i += 1) orders.push(i);
        return orders;
    }
    const single = Number.parseInt(normalized, 10);
    return Number.isFinite(single) ? [single] : [];
}

function parseEvidenceDispositions(
    section: string,
    context?: FfeProseParseContext,
): Array<Record<string, unknown>> {
    const items = context?.sessionItems ?? [];
    const orderToGuid = new Map<number, string>();
    for (const item of items) {
        if (item.original_order != null) orderToGuid.set(item.original_order, item.guid);
    }
    const dispositions: Array<Record<string, unknown>> = [];
    for (const line of section.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || /^Units\b/i.test(trimmed) || /^All \d+ native units/i.test(trimmed) || /^#\s/i.test(trimmed) || trimmed === '#') continue;
        if (/^#\t/i.test(trimmed) || /^#\s+Evidence/i.test(trimmed)) continue;
        const tabParts = trimmed.split('\t').map((part) => part.trim());
        let unitRange = '';
        let dispositionRaw = '';
        if (tabParts.length >= 3 && /^\d/.test(tabParts[0])) {
            unitRange = tabParts[0];
            dispositionRaw = tabParts[tabParts.length - 1];
        } else if (tabParts.length >= 2 && /^\d/.test(tabParts[0])) {
            unitRange = tabParts[0];
            dispositionRaw = tabParts.slice(1).join(' / ');
        } else {
            const inline = trimmed.match(/^(\d+(?:[–—-]\d+)?)\s+(.+)$/);
            if (!inline) continue;
            unitRange = inline[1];
            dispositionRaw = inline[2];
        }
        const disposition = mapDispositionLabel(dispositionRaw);
        if (!DISPOSITION_SET.has(disposition)) continue;
        const orders = expandUnitRange(unitRange);
        for (const order of orders) {
            const guid = orderToGuid.get(order);
            if (!guid) continue;
            dispositions.push({
                guid,
                disposition,
                driver_id: null,
                reason: dispositionRaw.slice(0, 400),
            });
        }
    }
    return dispositions;
}

function parseGeo(section: string): Record<string, unknown> {
    const scoreMatch = section.match(/(\d+(?:\.\d+)?)\s*\/\s*1\.00/i);
    const bandMatch = section.match(/—\s*([A-Z][A-Z,\s]*)/);
    const stateMatch = section.match(/Current state\s*\n+([\s\S]*?)(?:\nEscalation evidence|\nDe-escalation evidence|$)/i);
    const escalationBlock = section.match(/Escalation evidence\s*\n([\s\S]*?)(?:\nDe-escalation evidence|\nCurrent-state (?:rationale|judgment)|$)/i)?.[1] || '';
    const deEscalationBlock = section.match(/De-escalation evidence\s*\n([\s\S]*?)(?:\nCurrent-state (?:rationale|judgment)|$)/i)?.[1] || '';
    const bullets = (block: string) => block.split('\n')
        .map((line) => line.replace(/^[-•]\s*/, '').trim())
        .filter((line) => line.length > 10);
    const score = scoreMatch ? Number.parseFloat(scoreMatch[1]) : 0;
    const bandRaw = bandMatch?.[1]?.split(',')[0]?.trim().toUpperCase() || 'ELEVATED';
    return {
        dominant_theme: 'Iran/Hormuz geopolitical regime',
        score,
        band: bandRaw,
        state: stateMatch?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 120) || bandRaw,
        escalation_evidence: [],
        de_escalation_evidence: [],
        escalation_evidence_notes: bullets(escalationBlock),
        de_escalation_evidence_notes: bullets(deEscalationBlock),
        transmission_reason: section.match(/Current-state (?:rationale|judgment)\s*\n([\s\S]*?)(?:\n\d+\.|$)/i)?.[1]?.trim() || '',
    };
}

function parseOilAuditLetterDrivers(section: string): Array<Record<string, unknown>> {
    const drivers: Array<Record<string, unknown>> = [];
    const re = /^Driver\s+([A-Z])\s+[—–-]\s+(.+)$/gim;
    const matches = [...section.matchAll(re)];
    for (let i = 0; i < matches.length; i += 1) {
        const letter = matches[i][1];
        const label = matches[i][2].trim();
        const start = (matches[i].index ?? 0) + matches[i][0].length;
        const nextDriver = i + 1 < matches.length ? (matches[i + 1].index ?? section.length) : section.length;
        const aggregateAt = section.slice(start, nextDriver).search(/^Aggregate Oil state/im);
        const end = aggregateAt >= 0 ? start + aggregateAt : nextDriver;
        const body = section.slice(start, end);
        const stateLine = body.match(/State:\s*(.+)/i)?.[1]?.trim();
        const magnitudeLine = body.match(/Magnitude:\s*(.+)/i)?.[1]?.trim();
        if (!label || !stateLine || !magnitudeLine) continue;
        if (/embedded/i.test(magnitudeLine)) continue;
        const magnitude = parseScore(magnitudeLine);
        if (!Number.isFinite(magnitude)) continue;
        const mechanism = body.match(/Mechanism\s*\n([\s\S]*?)(?:\nEvidence|\nWeakening|\nCounterevidence|\nConclusion|$)/i)?.[1]?.trim()
            || '';
        drivers.push(makeDriver({
            driver_id: slugId(`OIL_AUDIT_${letter}`, label),
            canonical_label: label,
            fundamental_cause: mechanism || label,
            category: 'oil',
            status: /\bACTIVE\b/i.test(stateLine) ? 'ACTIVE' : 'WATCH',
            state_change: stateLine,
            contributions: [{
                asset: 'OIL',
                score: magnitude,
                bias: biasFromScore(magnitude),
                reason: `Oil Audit Driver ${letter} magnitude ${magnitudeLine}`,
            }],
            why_active: stateLine,
            why_independent: `Explicit Oil Audit Driver ${letter}: ${label}`,
        }));
    }
    return drivers;
}

function parseOilDownstreamApplied(section: string): Array<{ asset: string; score: number; reason: string }> {
    const block = section.match(/Downstream transmission\s*\n([\s\S]*?)(?:\n\d+\.|$)/i)?.[1] || '';
    const applied: Array<{ asset: string; score: number; reason: string }> = [];
    for (const line of block.split('\n')) {
        const trimmed = line.trim();
        const match = trimmed.match(/^(USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|GOLD|OIL):\s*([+\-−–—]?\s*\d+(?:\.\d+)?)\s+[—–-]\s*(.+)$/i);
        if (!match) continue;
        if (!/\bapplied\b/i.test(match[3]) || /\bnot applied\b/i.test(match[3])) continue;
        const score = parseScore(match[2]);
        if (!Number.isFinite(score) || score === 0) continue;
        applied.push({
            asset: match[1].toUpperCase(),
            score,
            reason: trimmed,
        });
    }
    return applied;
}

function parseOilAudit(section: string, drivers: Array<Record<string, unknown>>): Record<string, unknown> {
    const independentDrivers: Array<Record<string, unknown>> = [];
    for (const line of section.split('\n')) {
        const parts = line.split('\t').map((part) => part.trim());
        if (parts.length < 4) continue;
        if (!/hormuz|inventory|gulf|global|supply|buffer/i.test(parts[0])) continue;
        const magnitudeRaw = parts[2];
        const embedded = /embedded/i.test(magnitudeRaw);
        independentDrivers.push({
            driver_id: parts[0].toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40),
            channel: 'OIL',
            polarity: parts[1],
            magnitude: embedded ? 0 : parseScore(magnitudeRaw),
            reason: parts[3] || parts[0],
        });
    }
    const letterDrivers = drivers.filter((row) => String(row.driver_id || '').startsWith('OIL_AUDIT_'));
    if (!independentDrivers.length && letterDrivers.length) {
        for (const row of letterDrivers) {
            const contrib = (Array.isArray(row.contributions) ? row.contributions : [])
                .find((item) => String((item as Record<string, unknown>).asset) === 'OIL') as Record<string, unknown> | undefined;
            independentDrivers.push({
                driver_id: String(row.driver_id),
                channel: 'OIL',
                polarity: String(row.state_change || ''),
                magnitude: Number(contrib?.score ?? 0),
                reason: String(row.canonical_label || row.driver_id),
            });
        }
    }
    const oilDriverIds = drivers
        .filter((row) => String(row.driver_id || '').startsWith('OIL_'))
        .map((row) => String(row.driver_id));
    const aggregate = section.match(/Current aggregate Oil state:\s*(.+)/i)?.[1]?.trim()
        || section.match(/Aggregate Oil state\s*\n([^\n]+)/i)?.[1]?.trim()
        || '';
    return {
        independent_drivers: independentDrivers.length ? independentDrivers : oilDriverIds.map((driverId) => ({
            driver_id: driverId,
            channel: 'OIL',
            polarity: 'parsed',
            magnitude: 0,
            reason: 'Referenced in causal ledger',
        })),
        counter_evidence: [],
        net_assessment: aggregate,
        aggregate_current_state: aggregate,
        downstream_transmission_basis: section.match(/Downstream transmission\s*\n([\s\S]*?)(?:\n\d+\.|$)/i)?.[1]?.trim() || '',
    };
}

function collectOutOfContractScoreWarnings(drivers: Array<Record<string, unknown>>): string[] {
    const warnings: string[] = [];
    for (const driver of drivers) {
        const contributions = Array.isArray(driver.contributions) ? driver.contributions : [];
        for (const row of contributions) {
            const item = row as Record<string, unknown>;
            const score = Number(item.score);
            if (!Number.isFinite(score) || ALLOWED_SCORES.has(score)) continue;
            warnings.push(
                `driver ${String(driver.driver_id)} ${String(item.asset)} score ${score} is outside production contract [-1,-0.5,-0.25,0,0.25,0.5,1]`,
            );
        }
    }
    return warnings;
}

function mergeOilAuditDrivers(
    ledgerDrivers: Array<Record<string, unknown>>,
    oilSection: string,
    warnings: string[],
): Array<Record<string, unknown>> {
    const extra = parseOilAuditLetterDrivers(oilSection);
    const existingIds = new Set(ledgerDrivers.map((row) => String(row.driver_id)));
    const merged = [...ledgerDrivers];
    for (const driver of extra) {
        if (existingIds.has(String(driver.driver_id))) continue;
        merged.push(driver);
        existingIds.add(String(driver.driver_id));
    }

    const contributedAssets = new Set<string>();
    for (const driver of merged) {
        for (const row of Array.isArray(driver.contributions) ? driver.contributions : []) {
            contributedAssets.add(String((row as Record<string, unknown>).asset));
        }
    }
    const downstream = parseOilDownstreamApplied(oilSection)
        .filter((row) => row.asset !== 'OIL');
    const novel = downstream.filter((row) => {
        if (!contributedAssets.has(row.asset)) return true;
        warnings.push(`OIL audit downstream ${row.asset} ${row.score} skipped; ${row.asset} already contributed in the causal ledger`);
        return false;
    });
    if (novel.length) {
        merged.push(makeDriver({
            driver_id: 'OIL_AUDIT_DOWNSTREAM',
            canonical_label: 'Oil audit downstream transmission',
            fundamental_cause: 'Explicit Oil Audit downstream transmission of the aggregate Oil state',
            category: 'oil',
            status: 'ACTIVE',
            state_change: 'ACTIVE',
            contributions: novel.map((row) => ({
                asset: row.asset,
                score: row.score,
                bias: biasFromScore(row.score),
                reason: row.reason,
            })),
            why_active: 'Oil Audit listed these channels as applied',
            why_independent: 'Deterministic adapter from explicit Oil Audit downstream transmission',
        }));
    }
    return merged;
}

export function looksLikeFfeProseSessionBrief(text: string): boolean {
    const normalized = normalizeWhitespace(text);
    const hasBoard = /final\s+(?:frozen\s+)?board/i.test(normalized)
        || /catalyst\s+board/i.test(normalized);
    const hasLedger = /causal\s+ledger/i.test(normalized);
    const extraCount = [
        /macro\s+board/i.test(normalized),
        /evidence\s+dispositions/i.test(normalized),
        /geopolitical\s+regime/i.test(normalized),
        /oil\s+audit/i.test(normalized),
        /gold\s+decomposition/i.test(normalized),
        /final\s+session\s+state/i.test(normalized),
        /frozen\s+causal\s+analysis/i.test(normalized),
        /FFE\s+Causal\s+Session/i.test(normalized),
        /^FFE\b/m.test(normalized),
    ].filter(Boolean).length;
    return hasBoard && hasLedger && extraCount >= 2;
}

export function parseFfeProseSessionBriefDetailed(
    raw: string,
    context?: FfeProseParseContext,
): FfeProseParseOutcome {
    const text = normalizeWhitespace(String(raw || '').trim());
    if (!looksLikeFfeProseSessionBrief(text)) {
        return { detected: false, parsed: null, warnings: [] };
    }

    const sections = splitNumberedSections(text);
    const causalLedger = findSection(sections, 'causal ledger');
    if (!causalLedger) {
        return {
            detected: true,
            parsed: null,
            failed_field: 'drivers',
            error: 'PROSE_DETECTED: missing Causal Ledger section',
            warnings: [],
        };
    }

    const warnings: string[] = ['Parsed from ChatGPT prose session brief'];
    let drivers = parseDriverBlocks(causalLedger);
    const oilSection = findSection(sections, 'oil audit');
    if (oilSection) {
        drivers = mergeOilAuditDrivers(drivers, oilSection, warnings);
    }
    if (!drivers.length) {
        return {
            detected: true,
            parsed: null,
            failed_field: 'drivers',
            error: 'PROSE_DETECTED: Causal Ledger contained no driver blocks',
            warnings,
        };
    }

    const contractWarnings = collectOutOfContractScoreWarnings(drivers);
    warnings.push(...contractWarnings);

    const parsed = {
        session: parseSessionHeader(text, context),
        final_board: parseFinalBoard(sections),
        macro: parseMacroBoard(sections),
        drivers,
        geo: parseGeo(findSection(sections, 'geopolitical regime')),
        oil_audit: parseOilAudit(oilSection, drivers),
        zero_scored_items: [],
        evidence_dispositions: parseEvidenceDispositions(
            findSection(sections, 'evidence dispositions'),
            context,
        ),
        quality: {
            model_confidence: 0.8,
            unresolved_ambiguities: contractWarnings,
            warnings,
        },
    };

    return { detected: true, parsed, warnings };
}

export function parseFfeProseSessionBrief(
    raw: string,
    context?: FfeProseParseContext,
): Record<string, unknown> | null {
    return parseFfeProseSessionBriefDetailed(raw, context).parsed;
}
