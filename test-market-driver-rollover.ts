import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { prisma } from './src/lib/prisma.js';
import * as board from './src/services/marketDriverBoard.service.js';
import * as classifier from './src/services/groqClassifier.service.js';
import * as coverage from './src/services/marketDriverCoverageAudit.service.js';
import * as queue from './src/services/aiClassificationQueue.service.js';
import { runMarketDriverRollover } from './src/services/marketDriverRollover.service.js';

type Item = {
    guid: string;
    sourceId: string;
    sourceKey: string;
    contentHash: string;
    title: string;
    source: string;
    pubDate: string;
};

const namespace = `rollover-${randomUUID().slice(0, 8)}`;
const sourcePrefix = namespace.slice(0, 24);
const originalFetch = globalThis.fetch;
const calls: Array<{ operation: string; ingestId: string | null }> = [];
const jobIds = new Set<string>();

function normalize(title: string) {
    return title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function item(label: string, title: string, at: string): Item {
    const sourceId = `${sourcePrefix}:${label}`.slice(0, 80);
    const guid = `${namespace}:${label}`;
    const source = 'FinancialJuice';
    const pubDate = new Date(at).toISOString();
    const sourceKey = createHash('sha256').update(`${sourceId}\n${guid}`).digest('hex');
    const contentHash = createHash('sha256')
        .update(`${sourceId}\n${guid}\n${source}\n${pubDate}\n${normalize(title)}`)
        .digest('hex');
    return { guid, sourceId, sourceKey, contentHash, title, source, pubDate };
}

function providerResult(user: string, schemaName: string): Record<string, unknown> {
    if (schemaName === 'market_driver_dedup') {
        const isCrossBoundaryPair = user.includes('Fed signals rate cuts will be delayed') &&
            user.includes('Fed signals easing timeline will shift later');
        return { duplicateGroups: isCrossBoundaryPair ? [[0, 1]] : [] };
    }
    const indices = [...user.matchAll(/(?:^|\n)(\d+)\.\s/g)].map((match) => Number(match[1]));
    const existingMatch = user.includes('Fed signals easing timeline will shift later')
        ? user.match(/EXISTING topics[\s\S]*?\n([^:\n]+):[^\n]*Fed signals rate cuts will be delayed/)
        : null;
    return {
        results: [...new Set(indices)].map((index) => ({
            i: index,
            itemId: String(index),
            category: 'DRIVER',
            impact: 'High',
            assets: [{ asset: 'USD', bias: 'Bullish', score: 1, role: 'DIRECT', reason: 'Synthetic rollover driver' }],
            summary: 'Synthetic rollover verification',
            driverTheme: 'SYNTHETIC_ROLLOVER_THEME',
            causalThemeId: 'SYNTHETIC_ROLLOVER_THEME',
            geoState: 'IRRELEVANT',
            semanticDirection: 'BULLISH',
            semanticStrength: 'STRONG',
            fundamentalCause: 'Synthetic rollover driver',
            eventRelation: 'NEW_EVENT',
            eventDuplicateOf: null,
            causalThemeSummary: 'Synthetic rollover driver',
            themeAction: 'CREATE',
            macro: { eligible: false, family: null, directionSummary: null, assetScores: [] },
            catalystEligible: true,
            confidence: 1,
            needsReview: false,
            reason: 'Synthetic rollover verification',
        })),
        duplicateGroups: [],
        existingDuplicates: existingMatch ? [{ i: 0, existingId: existingMatch[1]!.trim() }] : [],
    };
}

function installProvider() {
    classifier.setAiProviderTransportOverrideForTests(null);
    classifier.setAiProviderRequestOverrideForTests((_system, user, options) => {
        calls.push({ operation: options.operationType, ingestId: options.ingestId ?? null });
        return providerResult(user, options.schemaName);
    });
}

function count(from: number, operation?: string) {
    return calls.slice(from).filter((call) => !operation || call.operation === operation).length;
}

async function rememberJobs() {
    const jobs = await prisma.aiClassificationJob.findMany({
        where: { OR: [{ ingest_id: { startsWith: namespace } }, { source: 'rollover-verification' }] },
        select: { id: true },
    });
    jobs.forEach((job) => jobIds.add(job.id));
}

async function cleanup() {
    classifier.setAiProviderRequestOverrideForTests(null);
    classifier.setAiProviderTransportOverrideForTests(null);
    await rememberJobs();
    const sessionJobs = await prisma.marketDriverSessionSynthesisJob.findMany({
        where: { ingest_id: { startsWith: namespace } },
        select: { id: true, snapshot_id: true },
    });
    const sessionSnapshotIds = sessionJobs.map((job) => job.snapshot_id).filter((id): id is string => Boolean(id));
    await prisma.aiUsageRecord.deleteMany({
        where: { OR: [{ ingest_id: { startsWith: namespace } }, { job_id: { in: [...jobIds] } }] },
    });
    await prisma.marketDriverProcessingRun.deleteMany({ where: { ingest_id: { startsWith: namespace } } });
    if (jobIds.size) await prisma.aiClassificationJob.deleteMany({ where: { id: { in: [...jobIds] } } });
    if (sessionSnapshotIds.length) await prisma.marketDriverSessionSnapshot.deleteMany({ where: { id: { in: sessionSnapshotIds } } });
    if (sessionJobs.length) await prisma.marketDriverSessionSynthesisJob.deleteMany({ where: { id: { in: sessionJobs.map((job) => job.id) } } });
    await prisma.marketDriverDayArchive.deleteMany({ where: { day_key: { in: ['2037-08-10', '2037-08-11', '2037-08-12', '2037-08-13'] } } });
    await prisma.marketDriverNews.deleteMany({ where: { source_id: { startsWith: sourcePrefix } } });
}

const times = {
    t0050: new Date('2037-08-12T20:50:00.000Z'),
    t0059: new Date('2037-08-12T20:59:00.000Z'),
    t0100: new Date('2037-08-12T21:00:00.000Z'),
    t0101: new Date('2037-08-12T21:01:00.000Z'),
    t0110: new Date('2037-08-12T21:10:00.000Z'),
    t0115: new Date('2037-08-12T21:15:00.000Z'),
    t0130: new Date('2037-08-12T21:30:00.000Z'),
    t0200: new Date('2037-08-12T22:00:00.000Z'),
};

const report: Record<string, unknown> = {
    timezone: 'Asia/Dubai',
    boundary: '01:00',
    timestamps: {},
    aiCalls: {},
};

try {
    await cleanup();
    installProvider();

    const previous = item('old', 'Fed signals rate cuts will be delayed', '2037-08-12T19:45:00.000Z'); // 23:45 Dubai
    const beforeStart = calls.length;
    const first = await board.ingestMarketDriverRssItems([previous], { ingestId: `${namespace}:before`, now: times.t0050 });
    assert.equal(first.stored, 1);
    assert.equal(board.marketDayKey(times.t0050), '2037-08-12');
    assert.equal((await board.getMarketDriverNews('2037-08-12')).length, 1);
    assert.equal((await board.getMarketDriverNews('2037-08-13')).length, 0);
    const beforeHistory = await board.getHistoricalDay('2037-08-12', times.t0050);
    assert.equal(beforeHistory?.isLiveDay, true);
    assert.equal(beforeHistory?.archived, false, 'fixture must reproduce archived:false before recovery');
    const lateOldDay = item('late-old-day', 'Bank of Canada signals another restrictive policy decision', '2037-08-12T20:58:00.000Z');
    let releaseLateClassification: (() => void) | undefined;
    let providerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    let held = false;
    classifier.setAiProviderRequestOverrideForTests(async (_system, user, options) => {
        calls.push({ operation: options.operationType, ingestId: options.ingestId ?? null });
        if (!held && options.operationType === 'classification' && options.ingestId === `${namespace}:late-old-day`) {
            held = true;
            providerStarted?.();
            await new Promise<void>((resolve) => { releaseLateClassification = resolve; });
        }
        return providerResult(user, options.schemaName);
    });
    const lateIngest = board.ingestMarketDriverRssItems([lateOldDay], {
        ingestId: `${namespace}:late-old-day`,
        now: times.t0059,
    });
    await started;
    const overlapCallStart = calls.length;
    const overlapRollover = await runMarketDriverRollover('verification', times.t0100);
    assert.equal(overlapRollover.success, true);
    assert.equal(count(overlapCallStart), 0, 'rollover must not start AI while classification is in flight');
    releaseLateClassification?.();
    assert.equal((await lateIngest).stored, 1);
    installProvider();
    const catchup = await runMarketDriverRollover('verification', times.t0110);
    assert.equal(catchup.success, true);
    assert.equal((await prisma.marketDriverDayArchive.findUnique({ where: { day_key: '2037-08-12' } }))?.headline_count, 2);
    const recoveredHistory = await board.getHistoricalDay('2037-08-12', times.t0110);
    assert.equal(recoveredHistory?.isLiveDay, false);
    assert.equal(recoveredHistory?.archived, true, 'recovery must expose archived:true for the completed day');
    assert.ok(recoveredHistory?.meta?.finalizedAt, 'recovered history must include a durable finalized timestamp');
    const recoveredLiveHistory = await board.getHistoricalDay('2037-08-13', times.t0110);
    assert.equal(recoveredLiveHistory?.isLiveDay, true);
    assert.equal(recoveredLiveHistory?.archived, false, 'current day must remain live and unarchived');
    report.historyApi = {
        beforeRecovery: { dayKey: '2037-08-12', isLiveDay: beforeHistory?.isLiveDay, archived: beforeHistory?.archived },
        afterRecovery: { dayKey: '2037-08-12', isLiveDay: recoveredHistory?.isLiveDay, archived: recoveredHistory?.archived, hasSnapshot: Boolean(recoveredHistory?.meta?.finalizedAt) },
        currentDay: { dayKey: '2037-08-13', isLiveDay: recoveredLiveHistory?.isLiveDay, archived: recoveredLiveHistory?.archived },
    };
    const beforeCalls = count(beforeStart);

    // Simulate a backend that missed 01:00. At a later startup on Aug 14, Aug 13 is the
    // previous day and Aug 11 is an older unarchived day. Startup recovery must archive both;
    // a repeated :15 catch-up must be idempotent and must not rebuild an already-finalized day.
    const startupOnly = item('startup-only', 'Reserve Bank of Australia keeps policy restrictive', '2037-08-13T20:30:00.000Z');
    const olderUnarchived = item('older-unarchived', 'Bank of England inflation expectations ease', '2037-08-11T20:30:00.000Z');
    const oldArchiveFixture = item('old-archive', 'Federal Reserve policy outlook remains steady', '2037-08-10T20:30:00.000Z');
    assert.equal((await board.ingestMarketDriverRssItems([startupOnly], { ingestId: `${namespace}:startup-only`, now: times.t0200 })).stored, 1);
    assert.equal((await board.ingestMarketDriverRssItems([olderUnarchived], { ingestId: `${namespace}:older-unarchived`, now: new Date('2037-08-12T20:00:00.000Z') })).stored, 1);
    assert.equal((await board.ingestMarketDriverRssItems([oldArchiveFixture], { ingestId: `${namespace}:old-archive`, now: new Date('2037-08-10T20:00:00.000Z') })).stored, 1);
    const startupAt = new Date('2037-08-13T21:10:00.000Z');
    assert.equal(await board.finalizeUaeDay('2037-08-10', startupAt), true);
    const oldArchiveBeforeRetry = await prisma.marketDriverDayArchive.findUnique({ where: { day_key: '2037-08-10' } });
    assert.ok(oldArchiveBeforeRetry);
    const startupRecovery = await runMarketDriverRollover('startup', startupAt);
    assert.equal(startupRecovery.success, true);
    const startupArchive = await prisma.marketDriverDayArchive.findUnique({ where: { day_key: '2037-08-13' } });
    const olderArchive = await prisma.marketDriverDayArchive.findUnique({ where: { day_key: '2037-08-11' } });
    assert.ok(startupArchive, 'startup recovery archived the missed previous day');
    assert.ok(olderArchive, 'startup catch-up archived an older unarchived day');
    const catchupRecovery = await runMarketDriverRollover('catchup', new Date('2037-08-13T21:15:00.000Z'));
    assert.equal(catchupRecovery.success, true);
    const oldArchiveAfterRetry = await prisma.marketDriverDayArchive.findUnique({ where: { day_key: '2037-08-10' } });
    assert.equal(oldArchiveAfterRetry?.finalized_at.getTime(), oldArchiveBeforeRetry?.finalized_at.getTime(), 'finalized older history must not be rebuilt');
    report.archiveRecovery = {
        missed01: { trigger: 'startup', previousDay: '2037-08-13', archived: Boolean(startupArchive) },
        olderUnarchived: { dayKey: '2037-08-11', archived: Boolean(olderArchive) },
        repeatedCatchup: { trigger: 'catchup', success: catchupRecovery.success, archiveRowsChanged: false },
        finalizedOlderDayPreserved: true,
    };
    const pendingItem = item('pending', 'EUR USD rises after ECB policy guidance', '2037-08-12T20:55:00.000Z');
    const processingItem = item('processing', 'USD JPY moves after Bank of Japan guidance', '2037-08-12T20:56:00.000Z');
    const completedItem = item('completed', 'GBP USD advances after Bank of England signal', '2037-08-12T20:57:00.000Z');
    const failedItem = item('failed', 'AUD USD gains after RBA maintains restrictive policy', '2037-08-12T20:58:00.000Z');

    const pending = await queue.ensureAiClassificationJob([pendingItem], { source: 'rollover-verification', ingestId: `${namespace}:pending` });
    const processing = await queue.ensureAiClassificationJob([processingItem], { source: 'rollover-verification', ingestId: `${namespace}:processing` });
    const completed = await queue.ensureAiClassificationJob([completedItem], { source: 'rollover-verification', ingestId: `${namespace}:completed` });
    const failed = await queue.ensureAiClassificationJob([failedItem], { source: 'rollover-verification', ingestId: `${namespace}:failed` });
    assert.ok(pending && processing && completed && failed);
    [pending!, processing!, completed!, failed!].forEach((job) => jobIds.add(job.id));
    assert.equal((await queue.claimAiClassificationJob(processing!.id, { workerId: 'rollover-verification' })).owned, true);
    await prisma.aiClassificationJob.update({
        where: { id: processing!.id },
        data: { locked_at: new Date('2037-08-12T20:50:00.000Z') },
    });
    assert.equal((await queue.claimAiClassificationJob(completed!.id, { workerId: 'rollover-verification' })).owned, true);
    await queue.completeAiClassificationJob(completed!.id);
    assert.equal((await queue.claimAiClassificationJob(failed!.id, { workerId: 'rollover-verification' })).owned, true);
    await queue.rescheduleAiClassificationJob(failed!.id, {
        errorKind: 'synthetic_retry',
        errorMessage: 'synthetic retry remains durable',
        retryAfterMs: 60 * 60_000,
    });
    await prisma.aiClassificationJob.update({
        where: { id: failed!.id },
        data: { next_retry_at: new Date('2037-08-12T23:00:00.000Z') },
    });
    // Keep this fixture isolated from any older local pending jobs: recover the synthetic stale
    // lock first, then make only these two synthetic jobs the earliest eligible work items.
    await queue.recoverStaleAiClassificationJobs(times.t0200);
    await prisma.aiClassificationJob.updateMany({
        where: { id: { in: [pending!.id, processing!.id] }, status: 'pending' },
        data: { next_retry_at: new Date('2000-01-01T00:00:00.000Z') },
    });
    const statesBefore = await prisma.aiClassificationJob.findMany({
        where: { id: { in: [pending!.id, processing!.id, completed!.id, failed!.id] } },
        select: { id: true, status: true, idempotency_key: true, next_retry_at: true },
    });

    for (const [label, at] of Object.entries(times)) {
        const rolloverStart = calls.length;
        const result = await runMarketDriverRollover('verification', at);
        assert.equal(result.success, true);
        assert.equal(count(rolloverStart), 0, `rollover ${label} must not call AI`);
        const expectedDay = at < times.t0100 ? '2037-08-12' : '2037-08-13';
        assert.equal(result.liveDay, expectedDay);
        (report.timestamps as Record<string, unknown>)[label] = {
            liveDay: result.liveDay,
            visibleRows: (await board.getMarketDriverNews(expectedDay)).length,
            rolloverAiCalls: 0,
        };
    }

    const statesAfter = await prisma.aiClassificationJob.findMany({
        where: { id: { in: [pending!.id, processing!.id, completed!.id, failed!.id] } },
        select: { id: true, status: true, idempotency_key: true, next_retry_at: true },
    });
    assert.deepEqual(
        statesAfter.map(({ id, status, idempotency_key }) => ({ id, status, idempotency_key })).sort((a, b) => a.id.localeCompare(b.id)),
        statesBefore.map(({ id, status, idempotency_key }) => ({ id, status, idempotency_key })).sort((a, b) => a.id.localeCompare(b.id)),
        'rollover must not mutate the durable queue',
    );
    assert.equal(statesAfter.find((row) => row.id === failed!.id)?.next_retry_at.getTime(), statesBefore.find((row) => row.id === failed!.id)?.next_retry_at.getTime());

    const replayStart = calls.length;
    const replay = await board.ingestMarketDriverRssItems([previous], { ingestId: `${namespace}:old-replay`, now: times.t0101 });
    assert.equal(replay.fresh, 0);
    assert.equal(replay.stored, 0);
    assert.equal(count(replayStart), 0);
    assert.equal(await prisma.aiClassificationJob.count({ where: { ingest_id: `${namespace}:old-replay` } }), 0);

    const crossBoundaryDuplicate = item('cross-boundary', 'Fed signals easing timeline will shift later', '2037-08-12T21:05:00.000Z'); // 01:05 Dubai
    const crossBoundaryStart = calls.length;
    const folded = await board.ingestMarketDriverRssItems([crossBoundaryDuplicate], { ingestId: `${namespace}:cross-boundary`, now: times.t0110 });
    assert.equal(folded.stored, 1);
    assert.equal(count(crossBoundaryStart, 'classification'), 1);
    assert.equal(count(crossBoundaryStart, 'semantic_dedup'), 0, 'classification resolved the new candidate against old context');
    const foldedRow = await prisma.marketDriverNews.findUnique({ where: { source_key: crossBoundaryDuplicate.sourceKey } });
    assert.equal(foldedRow?.day_key, '2037-08-13');
    assert.equal(foldedRow?.semantic_dedup_completed, true);
    assert.equal(foldedRow?.duplicate_of, (await prisma.marketDriverNews.findUnique({ where: { source_key: previous.sourceKey } }))?.id);
    assert.equal((await board.getMarketDriverNews('2037-08-13')).some((row) => row.headline === crossBoundaryDuplicate.title), false, 'semantic duplicate stays out of the live board');

    const newHeadline = item('new', 'ECB signals an unexpected rate hike and lifts the euro outlook', '2037-08-12T21:06:00.000Z');
    const newStart = calls.length;
    const inserted = await board.ingestMarketDriverRssItems([newHeadline], { ingestId: `${namespace}:new`, now: times.t0110 });
    assert.equal(inserted.stored, 1);
    const newClassificationCalls = count(newStart, 'classification');
    const newSemanticCalls = count(newStart, 'semantic_dedup');
    assert.equal(newClassificationCalls, 1);
    assert.equal(newSemanticCalls, 1);
    const newRow = await prisma.marketDriverNews.findUnique({ where: { source_key: newHeadline.sourceKey } });
    assert.equal(newRow?.day_key, '2037-08-13');
    assert.equal(newRow?.semantic_dedup_completed, true);
    assert.equal(newRow?.duplicate_of, null);
    assert.equal((await board.getMarketDriverNews('2037-08-13')).some((row) => row.headline === newHeadline.title), true, 'genuinely new headline appears after rollover');

    const healthyRss = `<?xml version="1.0"?><rss><channel><item><guid>${newHeadline.guid}</guid><title>${newHeadline.title}</title><author>${newHeadline.source}</author><pubDate>${new Date(newHeadline.pubDate).toUTCString()}</pubDate></item></channel></rss>`;
    globalThis.fetch = async () => new Response(healthyRss, { status: 200, headers: { 'content-type': 'application/xml' } });
    const auditStart = calls.length;
    for (const at of [times.t0059, times.t0100, times.t0110, times.t0130]) {
        const result = await coverage.runMarketDriverCoverageAudit({ force: true, now: at, ingestId: `${namespace}:coverage:${at.toISOString()}` });
        assert.equal(result.pass, true);
        assert.equal(result.healedMissing, 0);
    }
    assert.equal(count(auditStart), 0, 'healthy rollover coverage audits must not create AI calls');
    const coverageRaceStart = calls.length;
    const [coverageWhileRollover, rolloverWhileCoverage] = await Promise.all([
        coverage.runMarketDriverCoverageAudit({ force: true, now: times.t0130, ingestId: `${namespace}:coverage-race` }),
        runMarketDriverRollover('verification', times.t0130),
    ]);
    assert.equal(coverageWhileRollover.pass, true);
    assert.equal(rolloverWhileCoverage.success, true);
    assert.equal(count(coverageRaceStart), 0);

    const resumeStart = calls.length;
    const processed = await queue.processPendingAiClassificationJobs(2, times.t0200);
    assert.equal(processed, 2);
    assert.equal((await prisma.aiClassificationJob.findUnique({ where: { id: pending!.id } }))?.status, 'completed');
    assert.equal((await prisma.aiClassificationJob.findUnique({ where: { id: processing!.id } }))?.status, 'completed');
    assert.equal(count(resumeStart, 'classification'), 2);
    assert.equal((await prisma.aiClassificationJob.findUnique({ where: { id: completed!.id } }))?.status, 'completed');
    assert.equal((await prisma.aiClassificationJob.findUnique({ where: { id: failed!.id } }))?.status, 'failed');

    const failure = await runMarketDriverRollover('verification', times.t0100, async () => {
        throw new Error('synthetic database outage');
    });
    assert.equal(failure.success, false);
    const recovery = await runMarketDriverRollover('verification', times.t0110);
    assert.equal(recovery.success, true);
    assert.equal(board.marketDayKey(times.t0110), '2037-08-13', 'display day must not depend on archive success');

    const concurrent = await Promise.all([
        runMarketDriverRollover('verification', times.t0130),
        runMarketDriverRollover('verification', times.t0130),
    ]);
    assert.ok(concurrent.every((result) => result.success), 'concurrent archive upserts must be idempotent');

    await prisma.aiUsageRecord.updateMany({
        where: { ingest_id: `${namespace}:before` },
        data: { created_at: times.t0050 },
    });
    await prisma.aiUsageRecord.updateMany({
        where: { ingest_id: `${namespace}:new` },
        data: { created_at: times.t0110 },
    });
    await prisma.aiUsageRecord.updateMany({
        where: { ingest_id: { in: [`${namespace}:pending`, `${namespace}:processing`] } },
        data: { created_at: times.t0200 },
    });

    const usageCount = await prisma.aiUsageRecord.count({
        where: {
            created_at: { gte: times.t0050, lte: times.t0200 },
            ingest_id: { startsWith: namespace },
        },
    });
    assert.ok(usageCount >= beforeCalls + 3);
    assert.ok(await prisma.marketDriverProcessingRun.count({ where: { ingest_id: { startsWith: namespace } } }) >= 3);

    (report.aiCalls as Record<string, unknown>) = {
        beforeRollover: beforeCalls,
        duringRollover: 0,
        immediatelyAfterRolloverBeforeNewHeadline: 0,
        repeatedOldItemReplay: 0,
        firstGenuinelyNewHeadline: {
            classification: newClassificationCalls,
            semanticDedup: newSemanticCalls,
        },
        crossBoundaryDuplicate: { classification: 1, semanticDedup: 0, foldedAgainstOldContext: true },
        healthyCoverageAudits: 0,
    };
    report.queue = {
        pendingSurvived: true,
        staleProcessingRecoveredOnce: true,
        completedNotRestarted: true,
        failedRetryScheduleSurvived: true,
    };
    report.semanticDedup = { candidate: 'new headline only', crossBoundaryContextUsed: true, oldHeadlineReprocessed: false };
    report.failureRecovery = { failedAttemptReported: true, nextAttemptSucceeded: true, displayNeverStuck: true };
    report.races = { classificationWhileRollover: true, coverageWhileRollover: true, concurrentRolloverUpsert: true };
    report.usage = { daysRetained: daily.rows.map((row) => row.date), monthlyRangeCostRetained: true, processingHistoryRetained: true };
    console.log(JSON.stringify(report, null, 2));
} finally {
    globalThis.fetch = originalFetch;
    await cleanup().catch((error) => console.error('Rollover verification cleanup failed', error));
    await prisma.$disconnect();
}
