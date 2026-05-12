import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
export class AppConfigRepository {
    async findByKey(key) {
        const config = await prisma.appConfig.findUnique({
            where: { key },
        });
        return serializePrisma(config);
    }
    async updateOrCreate(key, value = null, description = null) {
        const config = await prisma.appConfig.upsert({
            where: { key },
            update: {
                value,
                description,
            },
            create: {
                key,
                value,
                description,
            },
        });
        return serializePrisma(config);
    }
    async findAll() {
        const configs = await prisma.appConfig.findMany({
            orderBy: {
                key: 'asc',
            },
        });
        return serializePrisma(configs);
    }
}
