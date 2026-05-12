import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
const dashboardInclude = {
    currencyPair: true,
};
const mapScoreDashboard = (score) => serializePrisma(score);
export class ScoreDashboardRepository {
    async findAll() {
        const scores = await prisma.scoreDashboard.findMany({
            include: dashboardInclude,
            orderBy: {
                currency_pair_id: 'asc',
            },
        });
        return scores.map(mapScoreDashboard);
    }
    async findByCurrencyPairId(currencyPairId) {
        const score = await prisma.scoreDashboard.findUnique({
            where: {
                currency_pair_id: BigInt(currencyPairId),
            },
            include: dashboardInclude,
        });
        return mapScoreDashboard(score);
    }
    async updateOrCreate(currencyPairId, scoreData) {
        const score = await prisma.scoreDashboard.upsert({
            where: {
                currency_pair_id: BigInt(currencyPairId),
            },
            update: {
                ...scoreData,
                calculated_at: new Date(),
            },
            create: {
                currency_pair_id: BigInt(currencyPairId),
                ...scoreData,
                calculated_at: new Date(),
            },
            include: dashboardInclude,
        });
        return mapScoreDashboard(score);
    }
    async deleteByCurrencyPairId(currencyPairId) {
        await prisma.scoreDashboard.deleteMany({
            where: {
                currency_pair_id: BigInt(currencyPairId),
            },
        });
    }
}
