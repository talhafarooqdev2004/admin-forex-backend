import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';
const globalForPrisma = globalThis as typeof globalThis & {
    __forexAdminPrisma?: PrismaClient;
};
const adapter = new PrismaPg({
    connectionString: ENV.DATABASE_URL,
});
export const prisma = globalForPrisma.__forexAdminPrisma ?? new PrismaClient({
    adapter,
    log: ENV.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
});
if (ENV.NODE_ENV !== 'production') {
    globalForPrisma.__forexAdminPrisma = prisma;
}
export const connectDB = async () => {
    try {
        await prisma.$connect();
        logger.info('PostgreSQL connected successfully via Prisma');
    }
    catch (error) {
        logger.error('Database connection failed:', error);
        process.exit(1);
    }
};
export const disconnectDB = async () => {
    await prisma.$disconnect();
};
