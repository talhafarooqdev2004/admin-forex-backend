import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
export class RiskModeScoreRepository {
    async getCurrent() {
        const score = await prisma.riskModeScore.findFirst({
            orderBy: {
                id: 'asc',
            },
        });
        return serializePrisma(score);
    }
    async updateOrCreate(score) {
        const riskScore = await prisma.riskModeScore.upsert({
            where: {
                id: BigInt(1),
            },
            update: {
                score,
            },
            create: {
                id: BigInt(1),
                score,
            },
        });
        return serializePrisma(riskScore);
    }
}
