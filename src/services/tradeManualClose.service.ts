import { prisma } from '../lib/prisma.js';
import { getCurrentPrice } from './livePrice.service.js';
import { pipsFromPrices, computeTradeClosePips } from './tradePips.service.js';
import { notifyManualFullClose, notifyManualPartialClose } from './tradeAlertNotification.service.js';

function n(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
}

function roundPrice(value: number, pair: string): number {
    const pip = pair.includes('JPY') ? 0.01 : 0.0001;
    const decimals = pip === 0.01 ? 3 : 5;
    return Number(value.toFixed(decimals));
}

function floatingPips(trade: Record<string, unknown>, price: number): number {
    const entry = n(trade.entry_level);
    const pair = String(trade.pair ?? '');
    if (entry === null || !pair) return 0;
    const isBuy = (trade.direction ?? 'buy') !== 'sell';
    return pipsFromPrices(entry, price, pair, isBuy);
}

export async function executeManualPartialClose(tradeId: string | number, level: 1 | 2 | 3) {
    const trade = await prisma.tradingAlert.findUnique({ where: { id: BigInt(tradeId) } });
    if (!trade) throw new Error('TRADE_NOT_FOUND');
    if (trade.status !== 'open') throw new Error('TRADE_NOT_OPEN');

    const existingAtLevel = await prisma.tradePartialClose.findFirst({
        where: { trading_alert_id: trade.id, tp_level: level },
    });
    if (existingAtLevel) throw new Error('PARTIAL_ALREADY_DONE');

    const price = await getCurrentPrice(trade.pair ?? '');
    if (price === null) throw new Error('PRICE_UNAVAILABLE');

    const pips = floatingPips(trade, price);
    const outcome = pips >= 0 ? 'Profit' : 'Loss';
    const exit = roundPrice(price, trade.pair ?? '');
    const accumulated = Number(n(trade.accumulated_pips) ?? 0) + pips;

    const partial = await prisma.tradePartialClose.create({
        data: {
            trading_alert_id: trade.id,
            tp_level: level,
            pips,
            exit_price: exit,
            outcome,
            close_reason: `Partial Close TP${level}`,
        },
    });

    const updated = await prisma.tradingAlert.update({
        where: { id: trade.id },
        data: {
            accumulated_pips: accumulated,
            manual_partial_closed: true,
        },
    });

    const merged = { ...trade, ...updated, partial_pips: pips, partial_level: level };
    await notifyManualPartialClose(merged, level, pips).catch(() => undefined);

    return { trade: updated, partial };
}

export async function executeManualFullClose(tradeId: string | number) {
    const trade = await prisma.tradingAlert.findUnique({ where: { id: BigInt(tradeId) } });
    if (!trade) throw new Error('TRADE_NOT_FOUND');
    if (trade.status !== 'open') throw new Error('TRADE_NOT_OPEN');

    const price = await getCurrentPrice(trade.pair ?? '');
    if (price === null) throw new Error('PRICE_UNAVAILABLE');

    const exit = roundPrice(price, trade.pair ?? '');
    const accumulated = Number(n(trade.accumulated_pips) ?? 0);
    const entry = n(trade.entry_level);
    const pair = String(trade.pair ?? '');
    const isBuy = (trade.direction ?? 'buy') !== 'sell';
    const tp1 = n(trade.tp1);
    const tp2 = n(trade.tp2);
    const tp3 = n(trade.tp3);

    let remaining: number;
    if (accumulated > 0) {
        remaining = floatingPips(trade, exit);
    } else {
        remaining =
            entry !== null
                ? (computeTradeClosePips({
                      entry,
                      exitPrice: exit,
                      pair,
                      isBuy,
                      maxTpHit: trade.max_tp_hit ?? 0,
                      tp1,
                      tp2,
                      tp3,
                      closedAtTp3: false,
                  }) ?? floatingPips(trade, exit))
                : floatingPips(trade, exit);
    }

    const totalPips = Number((accumulated + remaining).toFixed(2));
    const outcome = totalPips >= 0 ? 'Profit' : 'Loss';

    const updated = await prisma.tradingAlert.update({
        where: { id: trade.id },
        data: {
            status: 'completed',
            exit_price: exit,
            pips: totalPips,
            outcome,
            close_reason: accumulated > 0 ? 'Full Close (incl. partial)' : 'Manually Closed',
        },
    });

    const merged = {
        ...trade,
        ...updated,
        partial_accumulated: accumulated,
        remaining_pips: remaining,
    };
    await notifyManualFullClose(merged, accumulated, remaining, totalPips).catch(() => undefined);

    return updated;
}

export async function listTradePartialCloses() {
    return prisma.tradePartialClose.findMany({
        include: { trading_alert: true },
        orderBy: { created_at: 'desc' },
    });
}
