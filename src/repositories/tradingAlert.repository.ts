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
