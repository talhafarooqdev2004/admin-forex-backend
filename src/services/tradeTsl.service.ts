import { prisma } from '../lib/prisma.js';
import { getCurrentPrice, pipSize } from './livePrice.service.js';
import { notifyTradeEvent } from './tradeAlertNotification.service.js';

function n(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
}

/** TP level required before global auto-TSL starts (0 = inactive / off). */
export function tslTriggerLevel(tslActivateAfter: unknown): number {
    const value = String(tslActivateAfter ?? '');
    if (value === 'inactive') return 0;
    if (value === 'tp3') return 3;
    if (value === 'tp2') return 2;
    if (value === 'tp1') return 1;
    return 0;
}

function roundPrice(value: number, pair: string): number {
    const pip = pipSize(pair);
    const decimals = pip === 0.01 ? 3 : 5;
    return Number(value.toFixed(decimals));
}

/** SL one chase-distance behind (buy) or ahead (sell) of the current price. */
export function computeTslTarget(
    price: number,
    pair: string,
    isBuy: boolean,
    chasePips: number,
): number {
    const pip = pipSize(pair);
    const offset = chasePips * pip;
    return roundPrice(isBuy ? price - offset : price + offset, pair);
}

export type TslTickResult = {
    /** Mark TSL as active on the trade. */
    activate: boolean;
    /** New SL when a full chase interval has been reached (initial placement or step). */
    newSl?: number;
};

/**
 * Interval-based TSL: SL and alerts only move when price has advanced a full chase distance
 * beyond the current SL (e.g. chase 5 pips → SL steps 95→100 only when price hits 105).
 */
export function evaluateTslTick(
    price: number,
    currentSl: number,
    pair: string,
    isBuy: boolean,
    chasePips: number,
    tslActive: boolean,
): TslTickResult | null {
    if (chasePips <= 0) return null;

    const pip = pipSize(pair);
    const interval = chasePips * pip;
    const idealSl = computeTslTarget(price, pair, isBuy, chasePips);

    if (!tslActive) {
        const favorable = isBuy ? idealSl > currentSl : idealSl < currentSl;
        if (favorable && idealSl !== currentSl) {
            return { activate: true, newSl: idealSl };
        }
        return { activate: true };
    }

    const slImprovement = isBuy ? idealSl - currentSl : currentSl - idealSl;
    // Require a full chase interval before moving SL again (not every 1-pip tick).
    if (slImprovement + pip / 1000 < interval) return null;

    return { activate: true, newSl: idealSl };
}

/**
 * Global auto-TSL (admin tslActivateAfter) or per-trade manual toggle (tsl_enabled).
 * Manual per-trade toggle applies immediately; global rule waits until the configured TP level.
 */
export function shouldRunTsl(
    trade: Record<string, unknown>,
    tradeSettings: Record<string, unknown> | null,
    maxTpHit: number,
): boolean {
    if (trade.status !== 'open') return false;
    if (trade.tsl_enabled) return true;
    if (trade.manual_partial_closed) return false;
    const triggerLevel = tslTriggerLevel(tradeSettings?.tslActivateAfter);
    return triggerLevel > 0 && maxTpHit >= triggerLevel;
}

/** Activates TSL on a trade immediately (manual toggle). Uses the same interval rules for the initial SL. */
export async function applyTsl(
    trade: Record<string, unknown>,
    tradeSettings: Record<string, unknown> | null,
    livePrice?: number | null,
): Promise<boolean> {
    if (trade.status !== 'open') return false;

    const pair = String(trade.pair ?? '');
    const chasePips = n(tradeSettings?.tslChaseDistance) ?? 0;
    if (!pair || chasePips <= 0) return false;

    const sl = n(trade.stop_loss);
    if (sl === null) return false;

    const price = livePrice ?? (await getCurrentPrice(pair).catch(() => null));
    if (price === null) return false;

    const isBuy = (trade.direction ?? 'buy') !== 'sell';
    const tick = evaluateTslTick(price, sl, pair, isBuy, chasePips, Boolean(trade.tsl_active));
    if (!tick) return false;

    const data: Record<string, unknown> = { tsl_active: true };
    if (tick.newSl !== undefined) {
        data.stop_loss = tick.newSl;
        data.last_tsl_sl = tick.newSl;
    }

    await prisma.tradingAlert.update({
        where: { id: trade.id as number },
        data,
    });

    if (tick.newSl !== undefined) {
        const merged = { ...trade, ...data };
        await notifyTradeEvent(merged, 'tsl', { newSl: tick.newSl }).catch(() => undefined);
    }

    return true;
}
