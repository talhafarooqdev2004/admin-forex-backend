/**
 * One-off: reclassify today's market_driver_news with the current Groq prompt + sanitizers,
 * then mark semantic duplicates. Usage:
 *   npx tsx reclassify-todays-market-drivers.ts
 */
import { connectDB, prisma } from './src/lib/prisma.js';
import { logger } from './src/utils/logger.util.js';
import {
    realignTodaysMarketDriverScores,
    reclassifyTodaysMarketDriverNews,
    uaeDayKey,
} from './src/services/marketDriverBoard.service.js';

await connectDB();

const dayKey = uaeDayKey();
logger.info(`[Reclassify] Starting for UAE day ${dayKey}`);

const sanitized = await realignTodaysMarketDriverScores();
logger.info(`[Reclassify] Deterministic sanitize updated ${sanitized} row(s)`);

// Brief pause so we don't immediately hit Groq TPM after other traffic.
await new Promise((r) => setTimeout(r, 10000));

const { updated, duplicates } = await reclassifyTodaysMarketDriverNews();
logger.info(`[Reclassify] Groq reclassify updated ${updated}; duplicates marked ${duplicates}`);

const sanitizedAfter = await realignTodaysMarketDriverScores();
logger.info(`[Reclassify] Post-Groq sanitize updated ${sanitizedAfter} row(s)`);

const remaining = await prisma.marketDriverNews.count({
    where: { day_key: dayKey, duplicate_of: null, category: { in: ['DRIVER', 'GEOPOLITICAL'] } },
});
logger.info(`[Reclassify] Principals left on board today: ${remaining}`);

await prisma.$disconnect();
process.exit(0);
