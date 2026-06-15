import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';

const TECHNICAL_LEVELS_TABLE_ID = 'fx_technical_levels';
const CURRENT_PRICE_COLUMN_INDEX = 1;

const dynamicTableRepository = new DynamicTableRepository();

function normalizePair(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
}

function parseNumeric(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number.parseFloat(String(value).replace(/[,%]/g, '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
}

/** Quote currency = chars 3..6 of a normalized pair (EURUSD -> USD). */
export function pipSize(pair) {
    const normalized = normalizePair(pair);
    const quote = normalized.length >= 6 ? normalized.slice(3, 6) : '';
    return quote === 'JPY' ? 0.01 : 0.0001;
}

/** Reads the fx_technical_levels dynamic table into a normalized pair -> current price map. */
export async function getLivePriceMap(): Promise<Record<string, number>> {
    const table = await dynamicTableRepository.findByIdentifier(TECHNICAL_LEVELS_TABLE_ID);
    const map: Record<string, number> = {};
    if (!table) return map;

    const columns = [...(table.columns ?? [])].sort((a, b) => a.column_index - b.column_index);
    const firstColumn = columns[0];
    const priceColumn = columns[CURRENT_PRICE_COLUMN_INDEX];
    if (!firstColumn || !priceColumn) return map;

    const rows = [...(table.rows ?? [])].sort((a, b) => a.row_index - b.row_index);
    for (const row of rows) {
        const cells = row.cells ?? [];
        const pairCell = cells.find((c) => c.table_column_id === firstColumn.id);
        const priceCell = cells.find((c) => c.table_column_id === priceColumn.id);
        const pair = normalizePair(pairCell?.value);
        if (pair.length < 6) continue;
        const price = parseNumeric(priceCell?.value);
        if (price !== null) map[pair] = price;
    }
    return map;
}

/**
 * Common single-pair current-price accessor (backend). Reads from the same `fx_technical_levels`
 * source kept fresh by the scraper's 5m signal. Mirrors the frontend's `useLivePrices().getPrice(pair)`.
 */
export async function getCurrentPrice(pair: string): Promise<number | null> {
    const map = await getLivePriceMap();
    return map[normalizePair(pair)] ?? null;
}
