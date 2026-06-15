import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.util.js';
import { AppConfigRepository } from '../repositories/appConfig.repository.js';
import { getLivePriceMap, pipSize } from '../services/livePrice.service.js';
import { notifyTradeEvent } from '../services/tradeAlertNotification.service.js';

const appConfigRepository = new AppConfigRepository();
const TICK_MS = 5000;
let running = false;

function normalizePair(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
}

function n(v) {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
}

async function readJson(key) {
    try {
        const cfg = (await appConfigRepository.findByKey(key)) as { value?: string | null } | null;
        return cfg?.value ? JSON.parse(cfg.value) : null;
    } catch {
        return null;
    }
}

function levelFromSetting(value) {
    if (value === 'tp3') return 3;
    if (value === 'tp2') return 2;
    if (value === 'tp1' || value === 'manual') return 1;
    return 0;
}

/** Number of TPs the price has reached (direction-aware, ordered tp1<tp2<tp3). */
function reachedLevel(price, isBuy, tp1, tp2, tp3) {
    const hit = (tp) => tp !== null && (isBuy ? price >= tp : price <= tp);
    if (hit(tp3)) return 3;
    if (hit(tp2)) return 2;
    if (hit(tp1)) return 1;
    return 0;
}

/** A pending order activates when the live price reaches the entry from the side recorded at creation. */
function pendingReached(activationSide, entry, price) {
    if (activationSide === 'down') return price <= entry; // entry was below price at creation
    if (activationSide === 'up') return price >= entry;   // entry was above price at creation
    return true; // no recorded side -> treat as reached
}

async function evaluateTrade(trade, prices, tradeSettings, activeSettings) {
    const pair = normalizePair(trade.pair);
    const price = prices[pair];
    if (price === undefined) return;

    const entry = n(trade.entry_level);
    let sl = n(trade.stop_loss);
    const tp1 = n(trade.tp1);
    const tp2 = n(trade.tp2);
    const tp3 = n(trade.tp3);
    if (entry === null || sl === null) return;

    // Pending order: wait until price reaches entry from the creation side, then activate + alert.
    if (!trade.activated) {
        if (!pendingReached(trade.activation_side, entry, price)) return;
        await prisma.tradingAlert.update({ where: { id: trade.id }, data: { activated: true } });
        await notifyTradeEvent({ ...trade, activated: true }, 'opened').catch(() => undefined);
        return; // resume normal evaluation on the next tick
    }

    const isBuy = (trade.direction ?? 'buy') !== 'sell';
    const pip = pipSize(pair);
    const decimals = pip === 0.01 ? 3 : 5;
    const round = (v) => Number(v.toFixed(decimals));

    const level = reachedLevel(price, isBuy, tp1, tp2, tp3);
    const updates: Record<string, unknown> = {};
    const events: { event: string; newSl?: number }[] = [];

    let maxTp = trade.max_tp_hit ?? 0;

    // 1) TP progression alerts for newly-crossed levels 1 and 2 (3 is terminal below).
    for (let l = maxTp + 1; l <= Math.min(level, 2); l++) {
        events.push({ event: `tp${l}` });
        maxTp = l;
        updates.max_tp_hit = l;
    }

    // 2) Breakeven.
    const beLevel = levelFromSetting(activeSettings?.moveSlAfter);
    if (trade.breakeven_enabled && !trade.breakeven_done && beLevel > 0 && maxTp >= beLevel) {
        const manualPips = n(activeSettings?.moveSlManualPips) ?? 0;
        const beSl = activeSettings?.moveSlAfter === 'manual'
            ? entry + (isBuy ? 1 : -1) * manualPips * pip
            : entry;
        sl = round(beSl);
        updates.stop_loss = sl;
        updates.breakeven_done = true;
        events.push({ event: 'be' });
    }

    // 3) Trailing stop.
    const tslLevel = levelFromSetting(tradeSettings?.tslActivateAfter);
    const chasePips = n(tradeSettings?.tslChaseDistance) ?? 0;
    if (trade.tsl_enabled && tslLevel > 0 && maxTp >= tslLevel && chasePips > 0) {
        updates.tsl_active = true;
        const target = round(isBuy ? price - chasePips * pip : price + chasePips * pip);
        const moreFavorable = isBuy ? target > sl : target < sl;
        if (moreFavorable) {
            sl = target;
            updates.stop_loss = target;
            updates.last_tsl_sl = target;
            events.push({ event: 'tsl', newSl: target });
        }
    }

    // 4) Terminal: TP3 reached, or price hit the (possibly moved) SL.
    const hitTp3 = level >= 3;
    const hitSl = isBuy ? price <= sl : price >= sl;
    if (hitTp3 || hitSl) {
        const exit = hitTp3 ? (tp3 as number) : sl;
        const pips = ((exit - entry) / pip) * (isBuy ? 1 : -1);
        const outcome = pips >= 0 ? 'Profit' : 'Loss';
        updates.status = 'completed';
        updates.exit_price = round(exit);
        updates.pips = Number(pips.toFixed(2));
        updates.outcome = outcome;
        updates.close_reason = hitTp3 ? 'TP3 Achieved — Trade Close' : 'SL Hit — Trade Close';
        if (hitTp3) updates.max_tp_hit = 3;
        events.push({ event: hitTp3 ? 'tp3' : 'slHit' });
    }

    if (Object.keys(updates).length === 0) return;

    await prisma.tradingAlert.update({ where: { id: trade.id }, data: updates });

    // Build a merged view for message values (new SL/exit/pips/outcome).
    const merged = { ...trade, ...updates };
    for (const e of events) {
        await notifyTradeEvent(merged, e.event, { newSl: e.newSl }).catch(() => undefined);
    }
}

async function tick() {
    if (running) return;
    running = true;
    try {
        const open = await prisma.tradingAlert.findMany({ where: { status: 'open' } });
        if (open.length === 0) return;
        const [prices, tradeSettings, activeSettings] = await Promise.all([
            getLivePriceMap(),
            readJson('trade_alert_settings'),
            readJson('active_trades_settings'),
        ]);
        for (const trade of open) {
            try {
                await evaluateTrade(trade, prices, tradeSettings, activeSettings);
            } catch (err) {
                logger.error(`[TradeAlertEvaluator] trade ${trade.id} failed: ${err}`);
            }
        }
    } catch (err) {
        logger.error(`[TradeAlertEvaluator] tick failed: ${err}`);
    } finally {
        running = false;
    }
}

export function startTradeAlertEvaluator(): void {
    logger.info(`[TradeAlertEvaluator] started (every ${TICK_MS / 1000}s)`);
    setInterval(() => void tick(), TICK_MS);
}
