import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';

export class TradeAlertPairRepository {
    async findAll() {
        const pairs = await prisma.tradeAlertPair.findMany({
            orderBy: [
                { display_order: 'asc' },
                { name: 'asc' },
            ],
        });
        return serializePrisma(pairs);
    }

    async findById(id) {
        const pair = await prisma.tradeAlertPair.findUnique({
            where: { id: BigInt(id) },
        });
        return serializePrisma(pair);
    }

    async create(data) {
        const pair = await prisma.tradeAlertPair.create({
            data: {
                name: data.name,
                scalping_sl: data.scalping_sl ?? null,
                swing_sl: data.swing_sl ?? null,
                display_order: data.display_order ?? 0,
            },
        });
        return serializePrisma(pair);
    }

    async update(id, data) {
        const existing = await prisma.tradeAlertPair.findUnique({
            where: { id: BigInt(id) },
            select: { id: true },
        });
        if (!existing) return null;

        const pair = await prisma.tradeAlertPair.update({
            where: { id: BigInt(id) },
            data,
        });
        return serializePrisma(pair);
    }

    async upsertByName(name, scalping_sl, swing_sl) {
        const pair = await prisma.tradeAlertPair.upsert({
            where: { name },
            update: { scalping_sl, swing_sl },
            create: { name, scalping_sl, swing_sl },
        });
        return serializePrisma(pair);
    }

    async delete(id) {
        const existing = await prisma.tradeAlertPair.findUnique({
            where: { id: BigInt(id) },
            select: { id: true },
        });
        if (!existing) return false;

        await prisma.tradeAlertPair.delete({
            where: { id: BigInt(id) },
        });
        return true;
    }
}
