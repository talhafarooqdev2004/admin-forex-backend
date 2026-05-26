import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';
import { logger } from '../utils/logger.util.js';

const TMV_HISTORY_META_KEY = 'tmv_history';
/** 40 × 15 min = 10 hours (must match dashboard `TMV_HISTORY_BAR_COUNT` in `tmvHistoryConfig.ts`). */
const TMV_HISTORY_MAX_BARS = 40;
const TMV_HISTORY_SLOT_MS = 15 * 60 * 1000;
const TMV_SCORE_MIN = -2.5;
const TMV_SCORE_MAX = 2.5;

const TMV_EXCEL_COLS = {
    trend: 'AH',
    momentum: 'AI',
    volatility: 'AJ',
} as const;

type TmvMetric = keyof typeof TMV_EXCEL_COLS;

type TmvSnapshot = {
    trend: number;
    momentum: number;
    volatility: number;
    capturedAt: string;
    slotStartMs: number;
};

type TmvHistoryMeta = {
    version: 1;
    slotMs: number;
    maxBars: number;
    updatedAt: string;
    slots: TmvSnapshot[];
};

function excelColumnLettersToZeroBasedIndex(letters: string): number {
    let n = 0;
    for (const ch of letters.toUpperCase()) {
        n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1;
}

function parseNumeric(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number.parseFloat(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
}

function clampTmvScore(value: number): number {
    return Math.max(TMV_SCORE_MIN, Math.min(TMV_SCORE_MAX, value));
}

function sortedColumns(table: any): any[] {
    return [...(table?.columns ?? [])].sort((a, b) => Number(a.column_index ?? 0) - Number(b.column_index ?? 0));
}

function sortedRows(table: any): any[] {
    return [...(table?.rows ?? [])].sort((a, b) => Number(a.row_index ?? 0) - Number(b.row_index ?? 0));
}

function getCellValue(row: any, columnId: unknown): unknown {
    const cell = row?.cells?.find((item: any) => String(item.table_column_id) === String(columnId));
    return cell?.value ?? null;
}

function metricValue(table: any, metric: TmvMetric): number | null {
    if (!table?.rows?.length || !table?.columns?.length) return null;

    const colIndex = excelColumnLettersToZeroBasedIndex(TMV_EXCEL_COLS[metric]);
    const col = sortedColumns(table).find((c) => Number(c.column_index) === colIndex);
    if (!col) return null;

    const rows = sortedRows(table);
    const hasZeroBasedRows = rows.some((r) => Number(r.row_index) === 0);
    const start = hasZeroBasedRows ? 0 : 1;
    const end = start + 27;
    const byIndex = rows.filter((r) => Number(r.row_index) >= start && Number(r.row_index) <= end);
    const rowsToUse = byIndex.length === 28 ? [...byIndex].sort((a, b) => Number(a.row_index) - Number(b.row_index)) : rows.slice(0, 28);

    let sum = 0;
    let numericCount = 0;
    for (let i = 0; i < 28; i++) {
        const row = rowsToUse[i];
        if (!row) continue;
        const value = parseNumeric(getCellValue(row, col.id));
        if (value === null || Number.isNaN(value)) continue;
        sum += value;
        numericCount += 1;
    }

    // If formulas have not settled yet, avoid persisting a misleading zero snapshot.
    if (numericCount < 20) return null;
    return clampTmvScore(sum / 28);
}

function buildTmvSnapshot(table: any, now = Date.now()): TmvSnapshot | null {
    const trend = metricValue(table, 'trend');
    const momentum = metricValue(table, 'momentum');
    const volatility = metricValue(table, 'volatility');
    if (trend === null || momentum === null || volatility === null) return null;

    return {
        trend,
        momentum,
        volatility,
        capturedAt: new Date(now).toISOString(),
        slotStartMs: Math.floor(now / TMV_HISTORY_SLOT_MS) * TMV_HISTORY_SLOT_MS,
    };
}

function isTmvSnapshot(value: unknown): value is TmvSnapshot {
    if (!value || typeof value !== 'object') return false;
    const v = value as Partial<TmvSnapshot>;
    return (
        Number.isFinite(v.trend) &&
        Number.isFinite(v.momentum) &&
        Number.isFinite(v.volatility) &&
        Number.isFinite(v.slotStartMs) &&
        typeof v.capturedAt === 'string'
    );
}

function existingSlots(meta: unknown): TmvSnapshot[] {
    if (!meta || typeof meta !== 'object') return [];
    const slots = (meta as { slots?: unknown }).slots;
    return Array.isArray(slots) ? slots.filter(isTmvSnapshot).slice(-TMV_HISTORY_MAX_BARS) : [];
}

/**
 * Append rules (caller must only invoke on a **new** 15m `slotStartMs` vs last bar; see `appendSnapshotFromTechnicalDashboard`):
 * - Same slot as last: replace last (defensive; normally skipped before DB write).
 * - New slot and window full: **reset** — clear all bars and store only this snapshot (cycle restarts at bar 0).
 * - New slot and room left: append.
 */
function nextHistoryMeta(previousMeta: unknown, snapshot: TmvSnapshot): TmvHistoryMeta {
    const slots = existingSlots(previousMeta);
    const last = slots[slots.length - 1];

    let nextSlots: TmvSnapshot[];
    if (last?.slotStartMs === snapshot.slotStartMs) {
        nextSlots = [...slots.slice(0, -1), snapshot];
    } else if (slots.length >= TMV_HISTORY_MAX_BARS) {
        nextSlots = [snapshot];
    } else {
        nextSlots = [...slots, snapshot];
    }

    return {
        version: 1,
        slotMs: TMV_HISTORY_SLOT_MS,
        maxBars: TMV_HISTORY_MAX_BARS,
        updatedAt: snapshot.capturedAt,
        slots: nextSlots,
    };
}

function asTmvHistoryMeta(meta: unknown): TmvHistoryMeta | null {
    if (!meta || typeof meta !== 'object') return null;
    const slots = existingSlots(meta);
    if (slots.length === 0) return null;
    const updatedAt =
        typeof (meta as { updatedAt?: unknown }).updatedAt === 'string'
            ? (meta as { updatedAt: string }).updatedAt
            : slots[slots.length - 1]!.capturedAt;
    return {
        version: 1,
        slotMs: TMV_HISTORY_SLOT_MS,
        maxBars: TMV_HISTORY_MAX_BARS,
        updatedAt,
        slots,
    };
}

export class EdgeToolsTmvHistoryService {
    private tableRepository = new DynamicTableRepository();

    async appendSnapshotFromTechnicalDashboard(table: any): Promise<TmvHistoryMeta | null> {
        const snapshot = buildTmvSnapshot(table);
        if (!snapshot) {
            logger.warn('[EdgeToolsTmvHistory] Skipping TMV history snapshot; TMV columns are incomplete or not numeric yet.');
            return null;
        }

        const tableMetadata = table?.table_metadata && typeof table.table_metadata === 'object' ? table.table_metadata : {};
        const priorMeta = tableMetadata[TMV_HISTORY_META_KEY];
        const priorSlots = existingSlots(priorMeta);
        const lastPersisted = priorSlots[priorSlots.length - 1];

        // Sheet sync runs often (e.g. every minute); history is one bar per 15m wall slot — do not rewrite DB on every sync.
        if (lastPersisted && lastPersisted.slotStartMs === snapshot.slotStartMs) {
            return asTmvHistoryMeta(priorMeta);
        }

        const history = nextHistoryMeta(priorMeta, snapshot);

        await this.tableRepository.update(table.id, {
            table_metadata: {
                ...tableMetadata,
                [TMV_HISTORY_META_KEY]: history,
            },
        });

        logger.info(`[EdgeToolsTmvHistory] Stored TMV history snapshot at ${snapshot.capturedAt}; slots=${history.slots.length}.`);
        return history;
    }
}

export const edgeToolsTmvHistoryService = new EdgeToolsTmvHistoryService();
export { TMV_HISTORY_META_KEY, TMV_HISTORY_MAX_BARS, TMV_HISTORY_SLOT_MS };
