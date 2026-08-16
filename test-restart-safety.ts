/**
 * Repeatable restart/idempotency validation. Run after the restart-identity migration with:
 *
 *   node --import tsx/esm test-restart-safety.ts
 *
 * The script uses a namespaced sample source and a test provider override; it never calls an
 * external AI provider. The real ingest path records one synthetic classification and one
 * semantic-dedup usage row, then the exact RSS batch is replayed to prove that neither repeats.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from './src/lib/prisma.js';
import {
    claimAiClassificationJob,
    completeAiClassificationJob,
    ensureAiClassificationJob,
    recoverStaleAiClassificationJobs,
} from './src/services/aiClassificationQueue.service.js';
import { ingestMarketDriverRssItems } from './src/services/marketDriverBoard.service.js';
import { setAiProviderRequestOverrideForTests } from './src/services/groqClassifier.service.js';

const namespace = `restart-test:${randomUUID()}`;
const fixtureMarker = namespace.replace(/[^a-z0-9]+/gi, '-');
const sourceId = `${namespace}:feed`;
const now = new Date();
const pubDate = now.toISOString();
const guid = `${namespace}:guid`;
const title = `Fed Chair says rates will stay higher for longer ${fixtureMarker}`;
const source = 'RestartTest';
const normalized = title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
const sourceKey = createHash('sha256').update(`${sourceId}\n${guid}`).digest('hex');
const contentHash = createHash('sha256')
    .update(`${sourceId}\n${guid}\n${source}\n${pubDate}\n${normalized}`)
    .digest('hex');
const item = { guid, sourceId, sourceKey, contentHash, title, source, pubDate };
const item2Guid = `${namespace}:guid-2`;
const item2Title = `ECB President says a rate cut is appropriate ${fixtureMarker}`;
const item2SourceKey = createHash('sha256').update(`${sourceId}\n${item2Guid}`).digest('hex');
const item2ContentHash = createHash('sha256')
    .update(`${sourceId}\n${item2Guid}\n${source}\n${pubDate}\n${item2Title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`)
    .digest('hex');
const item2 = { guid: item2Guid, sourceId, sourceKey: item2SourceKey, contentHash: item2ContentHash, title: item2Title, source, pubDate };

async function countNamespaceJobs() {
    return prisma.aiClassificationJob.count({ where: { ingest_id: namespace } });
}

async function main() {
    try {
        await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
        console.error(`BLOCKED: PostgreSQL is unavailable or migrations are not deployed: ${error instanceof Error ? error.message : String(error)}`);
        await prisma.$disconnect();
        process.exitCode = 2;
        return;
    }
    const cleanupJobIds: string[] = [];
    try {
        setAiProviderRequestOverrideForTests((_system, user, options) => {
            if (options.schemaName === 'market_driver_dedup') return { duplicateGroups: [] };
            const indices = [...user.matchAll(/(?:^|\n)(\d+)\.\s/g)].map((match) => Number(match[1]));
            return {
                results: [...new Set(indices)].map((i) => ({
                    i,
                    category: 'DRIVER',
                    impact: 'High',
                    assets: [{ asset: 'USD', bias: 'Bullish', score: 1 }],
                    summary: 'Synthetic restart test',
                })),
                duplicateGroups: [],
                existingDuplicates: [],
            };
        });

        const first = await ingestMarketDriverRssItems([item, item2], { ingestId: namespace });
        assert.equal(first.fresh, 2, 'sample RSS batch was not ingested as fresh');
        assert.equal(first.stored, 2, 'sample RSS batch was not classified/stored once');
        const firstJob = await prisma.aiClassificationJob.findFirst({ where: { ingest_id: namespace }, orderBy: { created_at: 'asc' } });
        assert(firstJob, 'first classification job was not persisted');
        cleanupJobIds.push(firstJob.id);

        const baselineRows = await prisma.marketDriverNews.count({ where: { source_id: sourceId } });
        const baselineJobs = await countNamespaceJobs();
        const baselineUsage = await prisma.aiUsageRecord.count({ where: { ingest_id: namespace } });
        const baselineUsageByOperation = await prisma.aiUsageRecord.groupBy({
            by: ['operation_type'],
            where: { ingest_id: namespace },
            _count: { _all: true },
        });
        assert.equal(baselineUsageByOperation.find((row) => row.operation_type === 'classification')?._count._all, 1, 'sample was not classified exactly once');
        assert.equal(baselineUsageByOperation.find((row) => row.operation_type === 'semantic_dedup')?._count._all, 1, 'sample semantic pass did not run once');

        // Simulate a scraper restart: exact RSS payload again. It must be filtered by the
        // persistent source key before classification/job creation.
        const replay = await ingestMarketDriverRssItems([item, item2], { ingestId: `${namespace}:replay` });
        assert.equal(replay.fresh, 0, 'replayed RSS item was treated as fresh');
        assert.equal(await prisma.marketDriverNews.count({ where: { source_id: sourceId } }), baselineRows, 'duplicate headline row inserted');
        assert.equal(await countNamespaceJobs(), baselineJobs, 'completed classification job recreated');
        assert.equal(await prisma.aiUsageRecord.count({ where: { ingest_id: namespace } }), baselineUsage, 'replay made another AI usage record');
        assert.deepEqual(
            await prisma.aiUsageRecord.groupBy({ by: ['operation_type'], where: { ingest_id: namespace }, _count: { _all: true } }),
            baselineUsageByOperation,
            'replay made an additional classification or semantic-dedup call',
        );

        // A scraper restart can race a still-pending durable job before any headline row exists.
        // The queued source/content version is persistent state and must suppress a second job.
        const queuedReplayGuid = `${namespace}:queued-replay`;
        const queuedReplayItem = {
            ...item,
            guid: queuedReplayGuid,
            sourceKey: createHash('sha256').update(`${sourceId}\n${queuedReplayGuid}`).digest('hex'),
            contentHash: createHash('sha256')
                .update(`${sourceId}\n${queuedReplayGuid}\n${source}\n${pubDate}\n${normalized}`)
                .digest('hex'),
        };
        const queuedReplayJob = await ensureAiClassificationJob([queuedReplayItem], {
            source: 'restart-test',
            operationType: 'classification',
            ingestId: namespace,
        });
        assert(queuedReplayJob);
        cleanupJobIds.push(queuedReplayJob.id);
        const jobsBeforeQueuedReplay = await countNamespaceJobs();
        const usageBeforeQueuedReplay = await prisma.aiUsageRecord.count({ where: { ingest_id: namespace } });
        const queuedReplay = await ingestMarketDriverRssItems([queuedReplayItem], { ingestId: `${namespace}:queued-replay-webhook` });
        assert.equal(queuedReplay.fresh, 0, 'pending source/content version was reclassified after scraper restart');
        assert.equal(await countNamespaceJobs(), jobsBeforeQueuedReplay, 'scraper restart created an overlapping pending job');
        assert.equal(await prisma.aiUsageRecord.count({ where: { ingest_id: namespace } }), usageBeforeQueuedReplay, 'pending replay made an AI call');
        await completeAiClassificationJob(queuedReplayJob.id);

        // Simulate a backend restart while a pending job exists: stale processing becomes pending,
        // then exactly one replacement worker owns and completes it.
        const pendingItem = { ...item, guid: `${namespace}:pending`, sourceKey: createHash('sha256').update(`${sourceId}\npending`).digest('hex') };
        const pendingJob = await ensureAiClassificationJob([pendingItem], { source: 'restart-test', operationType: 'classification', ingestId: namespace });
        assert(pendingJob);
        cleanupJobIds.push(pendingJob.id);
        const pendingClaim = await claimAiClassificationJob(pendingJob.id, { workerId: `${namespace}:worker-a` });
        assert.equal(pendingClaim.owned, true);
        await prisma.aiClassificationJob.update({
            where: { id: pendingJob.id },
            data: { locked_at: new Date(Date.now() - 10 * 60_000) },
        });
        assert.ok((await recoverStaleAiClassificationJobs(new Date())) >= 1, 'stale processing job was not recovered');
        const resumed = await claimAiClassificationJob(pendingJob.id, { workerId: `${namespace}:worker-b` });
        assert.equal(resumed.owned, true, 'recovered job was not claimable by replacement worker');
        await completeAiClassificationJob(pendingJob.id);
        const completed = await prisma.aiClassificationJob.findUnique({ where: { id: pendingJob.id }, select: { status: true } });
        assert.equal(completed?.status, 'completed');

        // Two workers race on one pending idempotency key. The conditional DB update must yield
        // one owner, never two concurrent classifier calls.
        const raceItem = { ...item, guid: `${namespace}:race`, sourceKey: createHash('sha256').update(`${sourceId}\nrace`).digest('hex') };
        const raceJob = await ensureAiClassificationJob([raceItem], { source: 'restart-test', operationType: 'classification', ingestId: namespace });
        assert(raceJob);
        cleanupJobIds.push(raceJob.id);
        const claims = await Promise.all([
            claimAiClassificationJob(raceJob.id, { workerId: `${namespace}:race-a` }),
            claimAiClassificationJob(raceJob.id, { workerId: `${namespace}:race-b` }),
        ]);
        assert.equal(claims.filter((claim) => claim.owned).length, 1, 'more than one worker claimed the same job');
        await completeAiClassificationJob(raceJob.id);

        console.log(JSON.stringify({
            pass: true,
            checks: [
                'exact RSS replay inserted no row, job, or usage record',
                'scraper replay while source/content was queued created no overlapping job or AI call',
                'classification and semantic-dedup usage counts remained at one each',
                'processing lock timeout recovered and resumed once',
                'concurrent workers produced one atomic owner',
            ],
        }, null, 2));
    } finally {
        setAiProviderRequestOverrideForTests(null);
        await prisma.aiUsageRecord.deleteMany({ where: { ingest_id: namespace } }).catch(() => undefined);
        await prisma.aiClassificationJob.deleteMany({ where: { id: { in: cleanupJobIds } } }).catch(() => undefined);
        await prisma.marketDriverNews.deleteMany({ where: { source_id: sourceId } }).catch(() => undefined);
        await prisma.$disconnect();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
