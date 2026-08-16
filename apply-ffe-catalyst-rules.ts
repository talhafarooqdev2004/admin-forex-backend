/**
 * Explicit, no-AI rulebook migration for today's stored Catalyst rows.
 * Run only when an operator intentionally wants existing headlines reprocessed:
 *   npm run apply-ffe-catalyst-rules
 */
import { connectDB, prisma } from './src/lib/prisma.js';
import { logger } from './src/utils/logger.util.js';
import { applyFfeCatalystRulesToCurrentDay, marketDayKey } from './src/services/marketDriverBoard.service.js';

await connectDB();
const dayKey = marketDayKey();
const result = await applyFfeCatalystRulesToCurrentDay();
logger.info(`[FFE Catalyst] Applied current rulebook to ${dayKey}: ${result.updated} rows, ${result.visible} visible`);
await prisma.$disconnect();
