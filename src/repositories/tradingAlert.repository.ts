import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';

/** Only numeric ids are valid trading alert primary keys (avoids BigInt errors on static paths). */
function toTradeAlertId(id: unknown): bigint | null {
    const raw = String(id ?? '').trim();
    if (!/^\d+$/.test(raw)) return null;
    return BigInt(raw);
}

export class TradingAlertRepository {
    async findAll() {
        const alerts = await prisma.tradingAlert.findMany({
            orderBy: {
                date: 'desc',
            },
        });
        return serializePrisma(alerts);
    }
    async findById(id) {
        const tradeId = toTradeAlertId(id);
        if (tradeId === null) return null;
        const alert = await prisma.tradingAlert.findUnique({
            where: {
                id: tradeId,
            },
        });
        return serializePrisma(alert);
    }
    async create(alertData) {
        const alert = await prisma.tradingAlert.create({
            data: alertData,
        });
        return serializePrisma(alert);
    }
    async update(id, alertData) {
        const tradeId = toTradeAlertId(id);
        if (tradeId === null) return null;
        const existingAlert = await prisma.tradingAlert.findUnique({
            where: {
                id: tradeId,
            },
            select: {
                id: true,
            },
        });
        if (!existingAlert)
            return null;
        const alert = await prisma.tradingAlert.update({
            where: {
                id: tradeId,
            },
            data: alertData,
        });
        return serializePrisma(alert);
    }
    /**
     * Atomically claims a status event for a trade so the alert is sent only once even if
     * multiple clients report the same transition. Returns true if this caller claimed it.
     */
    async claimAlertEvent(id, event) {
        const tradeId = toTradeAlertId(id);
        if (tradeId === null) return false;
        const result = await prisma.tradingAlert.updateMany({
            where: {
                id: tradeId,
                // Match rows whose last event differs OR is still null (SQL: NOT(x=y) excludes NULLs).
                OR: [{ last_alert_event: { not: event } }, { last_alert_event: null }],
            },
            data: { last_alert_event: event },
        });
        return result.count > 0;
    }
    async delete(id) {
        const tradeId = toTradeAlertId(id);
        if (tradeId === null) return false;
        const existingAlert = await prisma.tradingAlert.findUnique({
            where: {
                id: tradeId,
            },
            select: {
                id: true,
            },
        });
        if (!existingAlert)
            return false;
        await prisma.tradingAlert.delete({
            where: {
                id: tradeId,
            },
        });
        return true;
    }
}
