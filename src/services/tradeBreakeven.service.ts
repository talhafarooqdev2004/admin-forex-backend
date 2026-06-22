import { prisma } from '../lib/prisma.js';
import { pipSize } from './livePrice.service.js';
import { notifyTradeEvent } from './tradeAlertNotification.service.js';

function n(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
}

/** TP level required before global auto-breakeven fires (0 = inactive / off). */
export function breakevenTriggerLevel(moveSlAfter: unknown): number {
    const value = String(moveSlAfter ?? '');
    if (value === 'inactive') return 0;
    if (value === 'tp3') return 3;
    if (value === 'tp2') return 2;
    if (value === 'tp1' || value === 'manual') return 1;
    return 0;
}

function roundPrice(value: number, pair: string): number {
    const pip = pipSize(pair);
    const decimals = pip === 0.01 ? 3 : 5;
    return Number(value.toFixed(decimals));
}

export function computeBreakevenSl(
    entry: number,
    pair: string,
    isBuy: boolean,
    activeSettings: Record<string, unknown> | null,
): number {
    const pip = pipSize(pair);
    const manualPips = n(activeSettings?.moveSlManualPips) ?? 0;
    if (activeSettings?.moveSlAfter === 'manual') {
        return roundPrice(entry + (isBuy ? 1 : -1) * manualPips * pip, pair);
    }
    return roundPrice(entry, pair);
}

/**
 * Global auto-BE (admin moveSlAfter tp1/tp2/tp3/manual) or per-trade manual toggle (breakeven_enabled).
 * Manual per-trade toggle applies immediately; global rule waits until the configured TP level.
 */
export function shouldApplyBreakeven(
    trade: Record<string, unknown>,
    activeSettings: Record<string, unknown> | null,
    maxTpHit: number,
): boolean {
    if (trade.breakeven_done || trade.status !== 'open') return false;
    if (trade.breakeven_enabled) return true;
    if (trade.manual_partial_closed) return false;
    const triggerLevel = breakevenTriggerLevel(activeSettings?.moveSlAfter);
    return triggerLevel > 0 && maxTpHit >= triggerLevel;
}

/** Moves SL to breakeven, marks done, and sends the BE alert. Returns true when applied. */
export async function applyBreakeven(
    trade: Record<string, unknown>,
    activeSettings: Record<string, unknown> | null,
): Promise<boolean> {
    if (trade.breakeven_done || trade.status !== 'open') return false;

    const entry = n(trade.entry_level);
    const pair = String(trade.pair ?? '');
    if (entry === null || !pair) return false;

    const isBuy = (trade.direction ?? 'buy') !== 'sell';
    const beSl = computeBreakevenSl(entry, pair, isBuy, activeSettings);

    const updated = await prisma.tradingAlert.update({
        where: { id: trade.id as number },
        data: { stop_loss: beSl, breakeven_done: true },
    });

    const merged = { ...trade, stop_loss: beSl, breakeven_done: true };
    await notifyTradeEvent(merged, 'be', { newSl: beSl }).catch(() => undefined);

    return Boolean(updated);
}
