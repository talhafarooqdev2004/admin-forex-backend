import axios from 'axios';
import { Prisma } from '@prisma/client';
import redis from '../config/redisClient.js';
import { ENV } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.util.js';
import { extractClientIp, isNonPublicIp } from '../utils/clientIp.util.js';
import type { Request } from 'express';

export const VISITOR_GEO_QUEUE_KEY = 'queues:visitor_geo';

type IpApiResponse = {
    ip?: string;
    country_code?: string | null;
    country_name?: string | null;
    region?: string | null;
    error?: boolean;
    reason?: string;
};

export async function enqueueVisitorGeoJob(ip: string): Promise<void> {
    if (!ENV.REDIS_ENABLED) return;
    try {
        await redis.rpush(VISITOR_GEO_QUEUE_KEY, ip);
    } catch (err) {
        logger.warn(`[VisitorGeo] Redis rpush failed for ${ip}; job not queued`, err);
        throw err;
    }
}

export async function requeuePendingVisitorGeoJobs(): Promise<void> {
    if (!ENV.REDIS_ENABLED) return;

    let pending: { ip_address: string }[] = [];
    try {
        pending = await prisma.visitorGeo.findMany({
            where: { status: 'pending' },
            select: { ip_address: true },
        });
    } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021') {
            logger.warn(
                '[VisitorGeo] Table `visitor_geo` is missing. Apply migrations: `cd forex-admin-backend && npx prisma migrate deploy`',
            );
            return;
        }
        throw e;
    }

    for (const row of pending) {
        try {
            await redis.rpush(VISITOR_GEO_QUEUE_KEY, row.ip_address);
        } catch (err) {
            logger.warn('[VisitorGeo] Redis unavailable; could not re-queue pending IP lookups', err);
            return;
        }
    }
    if (pending.length) {
        logger.info(`[VisitorGeo] Re-queued ${pending.length} pending IP lookups`);
    }
}

export async function recordVisitorPing(req: Request): Promise<{
    recorded: boolean;
    queued: boolean;
    reason?: string;
}> {
    const ip = extractClientIp(req);
    if (!ip) {
        return { recorded: false, queued: false, reason: 'no_ip' };
    }
    if (isNonPublicIp(ip)) {
        if (!ENV.VISITOR_GEO_RECORD_NON_PUBLIC) {
            return { recorded: false, queued: false, reason: 'non_public_ip' };
        }
        try {
            await prisma.visitorGeo.create({
                data: {
                    ip_address: ip,
                    status: 'resolved',
                    country_code: null,
                    country_name: 'Local or private network',
                    region_name: null,
                    last_error: null,
                },
            });
            return { recorded: true, queued: false, reason: 'non_public_synthetic_geo' };
        } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
                return { recorded: false, queued: false, reason: 'ip_already_tracked' };
            }
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021') {
                logger.warn('[VisitorGeo] visitor_geo table missing; skipping ping record');
                return { recorded: false, queued: false, reason: 'visitor_geo_table_missing' };
            }
            throw e;
        }
    }

    try {
        await prisma.visitorGeo.create({
            data: { ip_address: ip, status: 'pending' },
        });
    } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            return { recorded: false, queued: false, reason: 'ip_already_tracked' };
        }
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021') {
            logger.warn('[VisitorGeo] visitor_geo table missing; skipping ping record');
            return { recorded: false, queued: false, reason: 'visitor_geo_table_missing' };
        }
        throw e;
    }

    if (!ENV.REDIS_ENABLED) {
        setImmediate(() => {
            void resolveVisitorGeoForIp(ip);
        });
        return { recorded: true, queued: true };
    }

    try {
        await enqueueVisitorGeoJob(ip);
    } catch (err) {
        logger.error('[VisitorGeo] Redis enqueue failed; resolving in-process as fallback', err);
        setImmediate(() => {
            void resolveVisitorGeoForIp(ip);
        });
    }

    return { recorded: true, queued: true };
}

export async function resolveVisitorGeoForIp(ip: string): Promise<void> {
    let row: { status: string } | null = null;
    try {
        row = await prisma.visitorGeo.findUnique({ where: { ip_address: ip } });
    } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021') {
            return;
        }
        throw e;
    }
    if (!row || row.status !== 'pending') return;

    try {
        const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
        const { data } = await axios.get<IpApiResponse>(url, { timeout: 8000, validateStatus: () => true });
        if (!data || data.error) {
            const msg = (data?.reason || 'lookup_failed').slice(0, 480);
            await prisma.visitorGeo.update({
                where: { ip_address: ip },
                data: { status: 'failed', last_error: msg },
            });
            return;
        }
        await prisma.visitorGeo.update({
            where: { ip_address: ip },
            data: {
                status: 'resolved',
                country_code: data.country_code ?? null,
                country_name: data.country_name ?? null,
                region_name: data.region ?? null,
                last_error: null,
            },
        });
    } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 480);
        logger.warn(`[VisitorGeo] Failed for ${ip}: ${msg}`);
        await prisma.visitorGeo.update({
            where: { ip_address: ip },
            data: { status: 'failed', last_error: msg },
        }).catch(() => undefined);
    }
}

export async function getVisitorGeoAdminStats() {
    try {
        const [totals, byCountry, byRegion] = await Promise.all([
            prisma.visitorGeo.groupBy({
                by: ['status'],
                _count: { _all: true },
            }),
            prisma.visitorGeo.groupBy({
                by: ['country_code', 'country_name'],
                where: { status: 'resolved', country_name: { not: null } },
                _count: { _all: true },
            }),
            prisma.visitorGeo.groupBy({
                by: ['country_code', 'country_name', 'region_name'],
                where: { status: 'resolved', country_name: { not: null } },
                _count: { _all: true },
            }),
        ]);

        const statusCounts = Object.fromEntries(totals.map((t) => [t.status, t._count._all])) as Record<string, number>;
        const totalDistinctIps =
            (statusCounts.pending ?? 0) + (statusCounts.resolved ?? 0) + (statusCounts.failed ?? 0);

        const resolvedVisitors = byCountry.reduce((s, r) => s + r._count._all, 0);

        const byCountrySorted = [...byCountry].sort((a, b) => b._count._all - a._count._all);
        const byCountryWithShare = byCountrySorted.map((r) => ({
            countryCode: r.country_code,
            countryName: r.country_name,
            visitorCount: r._count._all,
            percentOfResolved: resolvedVisitors > 0 ? (100 * r._count._all) / resolvedVisitors : 0,
        }));

        const byRegionSorted = [...byRegion].sort((a, b) => b._count._all - a._count._all);
        const byRegionWithShare = byRegionSorted.map((r) => ({
            countryCode: r.country_code,
            countryName: r.country_name,
            regionName: r.region_name,
            visitorCount: r._count._all,
            percentOfResolved: resolvedVisitors > 0 ? (100 * r._count._all) / resolvedVisitors : 0,
        }));

        return {
            totalDistinctIps,
            resolvedVisitors,
            pendingCount: statusCounts.pending ?? 0,
            failedCount: statusCounts.failed ?? 0,
            byCountry: byCountryWithShare,
            byRegion: byRegionWithShare,
        };
    } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021') {
            logger.warn('[VisitorGeo] visitor_geo table missing; returning empty admin stats');
            return {
                totalDistinctIps: 0,
                resolvedVisitors: 0,
                pendingCount: 0,
                failedCount: 0,
                byCountry: [],
                byRegion: [],
            };
        }
        throw e;
    }
}
