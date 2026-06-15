import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
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
        const alert = await prisma.tradingAlert.findUnique({
            where: {
                id: BigInt(id),
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
        const existingAlert = await prisma.tradingAlert.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingAlert)
            return null;
        const alert = await prisma.tradingAlert.update({
            where: {
                id: BigInt(id),
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
        const result = await prisma.tradingAlert.updateMany({
            where: {
                id: BigInt(id),
                // Match rows whose last event differs OR is still null (SQL: NOT(x=y) excludes NULLs).
                OR: [{ last_alert_event: { not: event } }, { last_alert_event: null }],
            },
            data: { last_alert_event: event },
        });
        return result.count > 0;
    }
    async delete(id) {
        const existingAlert = await prisma.tradingAlert.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingAlert)
            return false;
        await prisma.tradingAlert.delete({
            where: {
                id: BigInt(id),
            },
        });
        return true;
    }
}
