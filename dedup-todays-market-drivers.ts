import { connectDB, prisma } from './src/lib/prisma.js';
import { logger } from './src/utils/logger.util.js';
import {
    markTodaysSemanticDuplicates,
    realignTodaysMarketDriverScores,
    uaeDayKey,
} from './src/services/marketDriverBoard.service.js';

await connectDB();
const dayKey = uaeDayKey();
logger.info(`[Dedup] Starting for UAE day ${dayKey}`);

const sanitized = await realignTodaysMarketDriverScores();
logger.info(`[Dedup] Sanitize updated ${sanitized}`);

const marked = await markTodaysSemanticDuplicates();
logger.info(`[Dedup] Marked ${marked} duplicates`);

const principals = await prisma.marketDriverNews.count({
    where: { day_key: dayKey, duplicate_of: null, category: { in: ['DRIVER', 'GEOPOLITICAL'] } },
});
logger.info(`[Dedup] Principals remaining: ${principals}`);

await prisma.$disconnect();
process.exit(0);
