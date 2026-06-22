import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';

export class UserPreferenceRepository {
    async findByUserAndKey(userId: bigint | number | string, key: string) {
        const pref = await prisma.userPreference.findUnique({
            where: {
                user_id_key: {
                    user_id: BigInt(userId),
                    key,
                },
            },
        });
        return serializePrisma(pref);
    }

    async upsert(userId: bigint | number | string, key: string, value: string | null) {
        const pref = await prisma.userPreference.upsert({
            where: {
                user_id_key: {
                    user_id: BigInt(userId),
                    key,
                },
            },
            update: { value },
            create: {
                user_id: BigInt(userId),
                key,
                value,
            },
        });
        return serializePrisma(pref);
    }
}
