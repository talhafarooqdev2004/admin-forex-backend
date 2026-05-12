import redis from '../config/redisClient.js';
import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';
import { VISITOR_GEO_QUEUE_KEY, resolveVisitorGeoForIp } from '../services/visitorGeo.service.js';

const BETWEEN_JOBS_MS = 220;

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export function startVisitorGeoWorker(): void {
    if (!ENV.REDIS_ENABLED) {
        logger.info('[VisitorGeo] Worker not started (REDIS_ENABLED=false)');
        return;
    }

    void (async () => {
        logger.info('[VisitorGeo] Worker started');
        for (;;) {
            try {
                const out = await redis.brpop(VISITOR_GEO_QUEUE_KEY, 12);
                if (!out) continue;
                const ip = out[1];
                if (!ip) continue;
                await resolveVisitorGeoForIp(ip);
                await sleep(BETWEEN_JOBS_MS);
            } catch (err) {
                logger.error('[VisitorGeo] Worker loop error', err);
                await sleep(5000);
            }
        }
    })();
}
