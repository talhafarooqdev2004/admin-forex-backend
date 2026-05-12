import Redis from "ioredis";
import { ENV } from "./env.js";
import { logger } from "../utils/logger.util.js";

/** Minimal stand-in when `REDIS_ENABLED=false` (local dev without Redis). */
function createDisabledRedisStub(): Redis {
    const stub = {
        get: async () => null,
        setex: async () => "OK" as const,
        del: async (..._keys: string[]) => 0,
        keys: async () => [] as string[],
        rpush: async () => 0,
        brpop: async () => null,
        on: () => stub,
        off: () => stub,
        quit: async () => "OK",
        disconnect: () => undefined,
    };
    return stub as unknown as Redis;
}

const redis: Redis = ENV.REDIS_ENABLED
    ? new Redis({
          host: ENV.REDIS_HOST,
          port: ENV.REDIS_PORT,
          password: ENV.REDIS_PASSWORD || null,
          /** Required for blocking commands (`brpop`); otherwise ioredis throws after retry budget. */
          maxRetriesPerRequest: null,
          retryStrategy: (times) => {
              const delay = Math.min(times * 50, 2000);
              return delay;
          },
      })
    : createDisabledRedisStub();

if (ENV.REDIS_ENABLED) {
    let lastRedisErrorLogMs = 0;
    const REDIS_ERROR_LOG_INTERVAL_MS = 15_000;

    redis.on("connect", () => {
        logger.info("✅ Redis connected successfully");
    });
    redis.on("error", (error) => {
        const now = Date.now();
        if (now - lastRedisErrorLogMs >= REDIS_ERROR_LOG_INTERVAL_MS) {
            lastRedisErrorLogMs = now;
            logger.error(
                "❌ Redis connection error (suppressing repeats for 15s). Start Redis or set REDIS_ENABLED=false in .env:",
                error,
            );
        }
    });
} else {
    logger.info("Redis disabled (REDIS_ENABLED=false): visitor geo runs inline; API cache is bypassed.");
}

export default redis;
