import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';

export type SerializedAppConfig = {
    id: number | string;
    key: string;
    value: string | null;
    description: string | null;
    created_at: Date;
    updated_at: Date;
};

export class AppConfigRepository {
    async findByKey(key: string): Promise<SerializedAppConfig | null> {
        const config = await prisma.appConfig.findUnique({
            where: { key },
        });
        return serializePrisma(config) as SerializedAppConfig | null;
    }
    async updateOrCreate(
        key: string,
        value: string | null = null,
        description: string | null = null,
    ): Promise<SerializedAppConfig> {
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
        return serializePrisma(config) as SerializedAppConfig;
    }
    async findAll(): Promise<SerializedAppConfig[]> {
        const configs = await prisma.appConfig.findMany({
            orderBy: {
                key: 'asc',
            },
        });
        return serializePrisma(configs) as SerializedAppConfig[];
    }
    async findByKeyPrefix(prefix: string): Promise<SerializedAppConfig[]> {
        const configs = await prisma.appConfig.findMany({
            where: { key: { startsWith: prefix } },
            orderBy: { key: 'asc' },
        });
        return serializePrisma(configs) as SerializedAppConfig[];
    }
}
