import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
export class CurrencyPairRepository {
    async findAll() {
        const pairs = await prisma.currencyPair.findMany({
            orderBy: [
                { display_order: 'asc' },
                { code: 'asc' },
            ],
        });
        return serializePrisma(pairs);
    }
    async findById(id) {
        const pair = await prisma.currencyPair.findUnique({
            where: {
                id: BigInt(id),
            },
        });
        return serializePrisma(pair);
    }
    async findByCode(code) {
        const pair = await prisma.currencyPair.findUnique({
            where: { code },
        });
        return serializePrisma(pair);
    }
}
