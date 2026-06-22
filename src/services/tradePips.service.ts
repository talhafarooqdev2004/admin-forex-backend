import { pipSize } from './livePrice.service.js';

function n(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
}

/** Signed pips from entry to a price level. */
export function pipsFromPrices(
    entry: number,
    price: number,
    pair: string,
    isBuy: boolean,
): number {
    const pip = pipSize(pair);
    return Number((((price - entry) / pip) * (isBuy ? 1 : -1)).toFixed(2));
}

export function tpPriceForLevel(
    maxTpHit: number,
    tp1: number | null,
    tp2: number | null,
    tp3: number | null,
): number | null {
    if (maxTpHit >= 3) return tp3;
    if (maxTpHit === 2) return tp2;
    if (maxTpHit === 1) return tp1;
    return null;
}

/**
 * Final pips for a closed trade. When any TP was reached before exit, credit pips at the
 * highest achieved TP — not the breakeven / trailing exit — so partial progress is preserved.
 */
export function computeTradeClosePips(params: {
    entry: number | null;
    exitPrice: number | null;
    pair: string;
    isBuy: boolean;
    maxTpHit: number;
    tp1: number | null;
    tp2: number | null;
    tp3: number | null;
    closedAtTp3?: boolean;
}): number | null {
    const { entry, exitPrice, pair, isBuy, maxTpHit, tp1, tp2, tp3, closedAtTp3 } = params;
    if (entry === null || exitPrice === null) return null;

    const achieved = closedAtTp3 ? 3 : Math.max(0, maxTpHit);
    if (achieved > 0) {
        const tpPrice = tpPriceForLevel(achieved, tp1, tp2, tp3);
        if (tpPrice !== null) {
            return pipsFromPrices(entry, tpPrice, pair, isBuy);
        }
    }

    return pipsFromPrices(entry, exitPrice, pair, isBuy);
}

/** Pips shown on follow-up alerts for an SL close (uses stored trade pips when present). */
export function slHitDisplayPips(trade: Record<string, unknown>): number | null {
    const stored = n(trade.pips);
    if (stored !== null) return stored;

    const entry = n(trade.entry_level);
    const pair = String(trade.pair ?? '');
    const isBuy = (trade.direction ?? 'buy') !== 'sell';
    const maxTp = Number(trade.max_tp_hit ?? 0);
    const tp1 = n(trade.tp1);
    const tp2 = n(trade.tp2);
    const tp3 = n(trade.tp3);
    const sl = n(trade.stop_loss);

    if (entry === null || !pair) return null;

    return computeTradeClosePips({
        entry,
        exitPrice: sl,
        pair,
        isBuy,
        maxTpHit: maxTp,
        tp1,
        tp2,
        tp3,
        closedAtTp3: false,
    });
}
