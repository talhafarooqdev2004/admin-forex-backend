/**
 * Final no-cost production-readiness verification for Daily Market AI processing.
 *
 * This script uses the configured PostgreSQL database, forces both provider keys blank, blocks
 * unexpected network access, and recreates independent backend worker processes. All rows use a
 * random namespace and are removed in finally.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

process.env.OPENAI_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.AI_CLASSIFICATION_BATCH_GAP_MS = '0';
process.env.AI_RETRY_BASE_MS = '0';
process.env.AI_PRIMARY_MAX_ATTEMPTS = '3';
process.env.AI_FALLBACK_MAX_ATTEMPTS = '2';

globalThis.fetch = async () => {
    throw new Error('Verification blocked an unexpected external request');
};

const [{ prisma }, board, queue, classifier, usage, coverage] = await Promise.all([
    import('./src/lib/prisma.js'),
    import('./src/services/marketDriverBoard.service.js'),
    import('./src/services/aiClassificationQueue.service.js'),
    import('./src/services/groqClassifier.service.js'),
    import('./src/services/aiUsage.service.js'),
    import('./src/services/marketDriverCoverageAudit.service.js'),
]);

type TestItem = {
    guid: string;
    sourceId: string;
    sourceKey: string;
    contentHash: string;
    title: string;
    source: string;
    pubDate: string;
};

type CountedCall = {
    operation: string;
    schemaName: string;
    headlineCount: number;
    systemChars: number;
    userChars: number;
    outputChars: number;
};

const namespace = `preopenai:${randomUUID()}`;
const sourcePrefix = namespace.toLowerCase();
const calls: CountedCall[] = [];
const report: Record<string, unknown> = { namespace, noPaidProviderTraffic: true };

function normalizedTitle(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function makeItem(group: string, index: number, title: string, publishedAt = new Date()): TestItem {
    const sourceId = `${sourcePrefix}:${group}`.slice(0, 80);
    const guid = `${group}:guid:${index}`;
    const source = 'PreOpenAIVerification';
    const pubDate = publishedAt.toISOString();
    const sourceKey = createHash('sha256').update(`${sourceId}\n${guid}`).digest('hex');
    const contentHash = createHash('sha256')
        .update(`${sourceId}\n${guid}\n${source}\n${pubDate}\n${normalizedTitle(title)}`)
        .digest('hex');
    return { guid, sourceId, sourceKey, contentHash, title, source, pubDate };
}

function providerResult(user: string, schemaName: string): Record<string, unknown> {
    if (schemaName === 'market_driver_dedup') return { duplicateGroups: [] };
    const indices = [...user.matchAll(/(?:^|\n)(\d+)\.\s/g)].map((match) => Number(match[1]));
    return {
        results: [...new Set(indices)].map((i) => ({
            i,
            category: 'DRIVER',
            impact: 'High',
            assets: [{ asset: 'USD', bias: 'Bullish', score: 1 }],
            summary: 'Synthetic readiness verification',
        })),
        duplicateGroups: [],
        existingDuplicates: [],
    };
}

function installCountingProvider(): void {
    classifier.setAiProviderTransportOverrideForTests(null);
    classifier.setAiProviderRequestOverrideForTests((system, user, options) => {
        const result = providerResult(user, options.schemaName);
        const indices = [...user.matchAll(/(?:^|\n)(\d+)\.\s/g)].map((match) => Number(match[1]));
        calls.push({
            operation: options.operationType,
            schemaName: options.schemaName,
            headlineCount: new Set(indices).size,
            systemChars: system.length,
            userChars: user.length,
            outputChars: JSON.stringify(result).length,
        });
        return result;
    });
}

function operationCounts(from = 0): Record<string, number> {
    return calls.slice(from).reduce<Record<string, number>>((out, call) => {
        out[call.operation] = (out[call.operation] ?? 0) + 1;
        return out;
    }, {});
}

async function runChild(extraEnv: Record<string, string> = {}, jobId?: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx/esm', 'test-ai-worker-process.ts'], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                OPENAI_API_KEY: '',
                GROQ_API_KEY: '',
                AI_CLASSIFICATION_BATCH_GAP_MS: '0',
                AI_RETRY_BASE_MS: '0',
                ...(jobId ? { AI_VERIFY_JOB_ID: jobId } : {}),
                ...extraEnv,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.once('error', reject);
        child.once('exit', (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`Verification child exited ${code}: ${stderr || stdout}`));
        });
    });
}

async function runScraperChild(xml: string): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/test-market-driver-rss-process.mjs'], {
            cwd: new URL('../forex-scraping', import.meta.url).pathname,
            env: { ...process.env, AI_VERIFY_RSS_XML: xml },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.once('error', reject);
        child.once('exit', (code) => {
            if (code !== 0) return reject(new Error(`Scraper verification child exited ${code}: ${stderr || stdout}`));
            const marker = stdout.split('\n').find((line) => line.startsWith('AI_VERIFY_SCRAPER_ITEMS='));
            if (!marker) return reject(new Error(`Scraper verification output missing item marker: ${stdout}`));
            try {
                resolve(JSON.parse(marker.slice('AI_VERIFY_SCRAPER_ITEMS='.length)) as unknown[]);
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function cleanupNamespace(): Promise<void> {
    const jobs = await prisma.aiClassificationJob.findMany({
        where: { ingest_id: { startsWith: namespace } },
        select: { id: true },
    });
    const jobIds = jobs.map((job) => job.id);
    await prisma.aiUsageRecord.deleteMany({
        where: {
            OR: [
                { ingest_id: { startsWith: namespace } },
                ...(jobIds.length ? [{ job_id: { in: jobIds } }] : []),
            ],
        },
    });
    if (jobIds.length) await prisma.aiClassificationJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.marketDriverProcessingRun.deleteMany({ where: { ingest_id: { startsWith: namespace } } });
    await prisma.marketDriverNews.deleteMany({
        where: { OR: [{ source_id: { startsWith: sourcePrefix } }, { source: 'PreOpenAIVerification' }] },
    });
}

function economicItems(group: string, count: number, offset = 0): TestItem[] {
    return Array.from({ length: count }, (_, index) => makeItem(
        group,
        offset + index,
        `United States CPI component ${group}-${offset + index} Actual ${110 + index} Forecast ${100 + index}`,
    ));
}

function asHttpError(status: number, message: string): Error & { status: number } {
    return Object.assign(new Error(message), { status });
}

async function main(): Promise<void> {
    await prisma.$queryRaw`SELECT 1`;

    const migrations = await prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND migration_name IN (
            '20260804090000_ai_classification_queue_usage',
            '20260804120000_market_driver_restart_identity',
            '20260804140000_ai_processing_runs'
        )
    `;
    assert.equal(migrations.length, 3, 'required migrations are not all deployed');
    const uniqueIndexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
            'market_driver_news_source_id_guid_key',
            'market_driver_news_source_key_key',
            'ai_classification_jobs_idempotency_key_key',
            'market_driver_processing_runs_ingest_id_key'
        )
    `;
    assert.equal(uniqueIndexes.length, 4, 'required database uniqueness indexes are missing');
    report.database = { migrations: 3, requiredUniqueIndexes: 4 };

    installCountingProvider();

    const initialItems = [
        makeItem('initial', 1, 'EUR/USD climbs after ECB signals rates will remain restrictive'),
        makeItem('initial', 2, 'USD/JPY slides as Bank of Japan signals further policy tightening'),
    ];
    const initialCallStart = calls.length;
    const initial = await board.ingestMarketDriverRssItems(initialItems, { ingestId: `${namespace}:initial` });
    const initialOps = operationCounts(initialCallStart);
    assert.equal(initial.fresh, 2);
    assert.equal(initial.stored, 2);
    assert.equal(initialOps.classification, 1);
    assert.equal(initialOps.semantic_dedup, 1);
    const initialRows = await prisma.marketDriverNews.count({ where: { source_id: initialItems[0]!.sourceId } });
    const initialJobs = await prisma.aiClassificationJob.count({ where: { ingest_id: `${namespace}:initial` } });
    report.initialIngestion = {
        fetched: 2,
        newRows: initialRows,
        jobs: initialJobs,
        calls: initialOps,
        duplicateSkips: initial.exactDuplicatesSkipped,
    };

    const replayCallStart = calls.length;
    const replay = await board.ingestMarketDriverRssItems(initialItems, { ingestId: `${namespace}:replay` });
    assert.equal(replay.fresh, 0);
    assert.equal(replay.stored, 0);
    assert.deepEqual(operationCounts(replayCallStart), {});
    assert.equal(await prisma.marketDriverNews.count({ where: { source_id: initialItems[0]!.sourceId } }), initialRows);
    assert.equal(await prisma.aiClassificationJob.count({ where: { ingest_id: `${namespace}:replay` } }), 0);

    for (const restartKind of ['scraper-restart', 'backend-restart']) {
        await runChild({
            AI_VERIFY_MODE: 'replay',
            AI_VERIFY_INGEST_ID: `${namespace}:${restartKind}`,
            AI_VERIFY_ITEMS_JSON: JSON.stringify(initialItems),
        });
        assert.equal(await prisma.aiUsageRecord.count({ where: { ingest_id: `${namespace}:${restartKind}` } }), 0);
        assert.equal(await prisma.aiClassificationJob.count({ where: { ingest_id: `${namespace}:${restartKind}` } }), 0);
    }
    report.replayAndRestarts = {
        replayFresh: replay.fresh,
        replayRows: replay.stored,
        additionalAiCalls: 0,
        recreatedJobs: 0,
        recreatedProcesses: 2,
    };

    const scraperGuidA = `${namespace}:scraper-guid-a`;
    const scraperGuidB = `${namespace}:scraper-guid-b`;
    const scraperXml = `<?xml version="1.0"?><rss><channel>
        <item><guid>${scraperGuidA}</guid><title>EUR/USD advances after ECB maintains restrictive guidance</title><author>PreOpenAIVerification</author><pubDate>${new Date().toUTCString()}</pubDate></item>
        <item><guid>${scraperGuidB}</guid><title>USD/JPY falls after Bank of Japan signals tighter policy</title><author>PreOpenAIVerification</author><pubDate>${new Date().toUTCString()}</pubDate></item>
    </channel></rss>`;
    const scraperOutputOne = await runScraperChild(scraperXml);
    const scraperProcessStart = calls.length;
    const scraperInitial = await board.ingestMarketDriverRssItems(scraperOutputOne, { ingestId: `${namespace}:scraper-process-1` });
    const scraperOutputTwo = await runScraperChild(scraperXml);
    assert.deepEqual(scraperOutputTwo, scraperOutputOne, 'recreated scraper produced unstable source identities');
    const scraperReplayStart = calls.length;
    const scraperReplay = await board.ingestMarketDriverRssItems(scraperOutputTwo, { ingestId: `${namespace}:scraper-process-2` });
    assert.equal(scraperInitial.stored, 2);
    assert.equal(scraperReplay.fresh, 0);
    assert.equal(scraperReplay.stored, 0);
    assert.deepEqual(operationCounts(scraperReplayStart), {});
    assert.equal(await prisma.aiClassificationJob.count({ where: { ingest_id: `${namespace}:scraper-process-2` } }), 0);
    report.scraperProcessRestart = {
        recreatedProcesses: 2,
        stableItems: scraperOutputOne.length,
        firstRunCalls: operationCounts(scraperProcessStart),
        secondRunRows: scraperReplay.stored,
        secondRunJobs: 0,
        secondRunAiCalls: 0,
    };

    // Remove recent visible fixtures so the coverage test can prove that one missing item causes
    // one coverage-repair request and no incidental semantic-context request.
    const initialJobIds = (await prisma.aiClassificationJob.findMany({
        where: { ingest_id: `${namespace}:initial` }, select: { id: true },
    })).map((job) => job.id);
    await prisma.aiUsageRecord.deleteMany({ where: { ingest_id: `${namespace}:initial` } });
    if (initialJobIds.length) await prisma.aiClassificationJob.deleteMany({ where: { id: { in: initialJobIds } } });
    await prisma.marketDriverNews.deleteMany({ where: { source_id: initialItems[0]!.sourceId } });

    const coverageTitle = 'EUR/USD rises after ECB signals a rate hike';
    const coverageItem = makeItem('coverage', 1, coverageTitle);
    const coverageDay = board.marketDayKey(new Date(coverageItem.pubDate));
    await prisma.marketDriverNews.create({
        data: {
            id: randomUUID(), guid: coverageItem.guid, source_id: coverageItem.sourceId,
            source_key: coverageItem.sourceKey, content_hash: coverageItem.contentHash,
            normalized: normalizedTitle(coverageTitle), day_key: coverageDay, headline: coverageTitle,
            source: coverageItem.source, category: 'DRIVER', impact: 'High',
            summary: 'Healthy deterministic fixture',
            assets: [{ asset: 'USD', bias: 'Bullish', score: 1 }], duplicate_of: null,
            board_locked: true, classification_completed: true, semantic_dedup_completed: true,
            coverage_repair_completed: true, published_at: new Date(coverageItem.pubDate),
        },
    });
    const rssXml = `<?xml version="1.0"?><rss><channel><item><guid>${coverageItem.guid}</guid><title>${coverageTitle}</title><author>${coverageItem.source}</author><pubDate>${new Date(coverageItem.pubDate).toUTCString()}</pubDate></item></channel></rss>`;
    globalThis.fetch = async () => new Response(rssXml, { status: 200, headers: { 'content-type': 'application/xml' } });
    const healthyStart = calls.length;
    for (let cycle = 0; cycle < 3; cycle += 1) {
        const result = await coverage.runMarketDriverCoverageAudit({ force: true });
        assert.equal(result.pass, true);
        assert.equal(result.healedMissing, 0);
        assert.equal(result.healedHidden, 0);
    }
    assert.deepEqual(operationCounts(healthyStart), {});

    await prisma.marketDriverNews.update({
        where: { source_key: coverageItem.sourceKey },
        data: { board_locked: false, category: 'IRRELEVANT', impact: 'Low', assets: [] },
    });
    const hiddenStart = calls.length;
    const hiddenRepair = await coverage.runMarketDriverCoverageAudit({ force: true });
    assert.equal(hiddenRepair.healedHidden, 1);
    assert.deepEqual(operationCounts(hiddenStart), {});

    await prisma.marketDriverNews.delete({ where: { source_key: coverageItem.sourceKey } });
    const missingStart = calls.length;
    const missingRepair = await coverage.runMarketDriverCoverageAudit({ force: true });
    assert.equal(missingRepair.healedMissing, 1);
    assert.deepEqual(operationCounts(missingStart), { coverage_repair: 1 });
    const postRepairStart = calls.length;
    for (let cycle = 0; cycle < 3; cycle += 1) {
        assert.equal((await coverage.runMarketDriverCoverageAudit({ force: true })).pass, true);
    }
    assert.deepEqual(operationCounts(postRepairStart), {});
    report.coverageAudit = {
        healthyCycles: 6,
        healthyAiCalls: 0,
        hiddenDeterministicRepairAiCalls: 0,
        missingRepairCalls: 1,
    };
    globalThis.fetch = async () => { throw new Error('Verification blocked an unexpected external request'); };

    const queueResults: Record<string, unknown> = {};
    const pendingItem = economicItems('pending', 1)[0]!;
    const pendingJob = await queue.ensureAiClassificationJob([pendingItem], {
        ingestId: `${namespace}:pending`, operationType: 'classification', source: 'verification',
    });
    assert(pendingJob);
    await runChild({}, pendingJob.id);
    const pendingDone = await prisma.aiClassificationJob.findUnique({ where: { id: pendingJob.id } });
    assert.equal(pendingDone?.status, 'completed');
    assert.equal(await prisma.aiUsageRecord.count({ where: { job_id: pendingJob.id, operation_type: 'classification' } }), 1);
    queueResults.pendingResumeCalls = 1;

    const crashItem = economicItems('crash', 1)[0]!;
    const crashJob = await queue.ensureAiClassificationJob([crashItem], {
        ingestId: `${namespace}:crash`, operationType: 'classification', source: 'verification',
    });
    assert(crashJob);
    assert.equal((await queue.claimAiClassificationJob(crashJob.id, { workerId: `${namespace}:crashed-worker` })).owned, true);
    await runChild({}, crashJob.id);
    assert.equal(await prisma.aiUsageRecord.count({ where: { job_id: crashJob.id } }), 0, 'fresh processing lock was double-processed');
    await prisma.aiClassificationJob.update({
        where: { id: crashJob.id },
        data: { locked_at: new Date(Date.now() - 10 * 60_000) },
    });
    await runChild({}, crashJob.id);
    const crashDone = await prisma.aiClassificationJob.findUnique({ where: { id: crashJob.id } });
    assert.equal(crashDone?.status, 'completed');
    assert.equal(crashDone?.stale_recovery_count, 1);
    assert.equal(await prisma.aiUsageRecord.count({ where: { job_id: crashJob.id, operation_type: 'classification' } }), 1);
    queueResults.staleRecoveryCalls = 1;

    const raceItem = economicItems('race', 1)[0]!;
    const raceJob = await queue.ensureAiClassificationJob([raceItem], {
        ingestId: `${namespace}:race`, operationType: 'classification', source: 'verification',
    });
    assert(raceJob);
    await Promise.all([runChild({}, raceJob.id), runChild({}, raceJob.id)]);
    const raceDone = await prisma.aiClassificationJob.findUnique({ where: { id: raceJob.id } });
    assert.equal(raceDone?.status, 'completed');
    assert.equal(await prisma.aiUsageRecord.count({ where: { job_id: raceJob.id, operation_type: 'classification' } }), 1);
    await runChild({}, raceJob.id);
    assert.equal(await prisma.aiUsageRecord.count({ where: { job_id: raceJob.id, operation_type: 'classification' } }), 1);
    queueResults.concurrentWorkers = 2;
    queueResults.concurrentClassificationCalls = 1;
    queueResults.completedJobRestartCalls = 0;
    report.queueRecovery = queueResults;

    const batchResults: Record<string, unknown> = {};
    for (const count of [1, 12, 13, 24]) {
        const ingestId = `${namespace}:batch-${count}`;
        const start = calls.length;
        const result = await board.ingestMarketDriverRssItems(economicItems(`batch-${count}`, count), { ingestId });
        const counts = operationCounts(start);
        assert.equal(result.fresh, count);
        assert.equal(result.stored, count);
        assert.equal(counts.classification, Math.ceil(count / 12));
        assert.equal(counts.semantic_dedup ?? 0, 0);
        batchResults[String(count)] = counts.classification;
    }
    const existing = economicItems('mix-existing', 12);
    await board.ingestMarketDriverRssItems(existing, { ingestId: `${namespace}:mix-seed` });
    const newMix = economicItems('mix-new', 5);
    const mixStart = calls.length;
    const mix = await board.ingestMarketDriverRssItems([...existing.slice(0, 8), ...newMix], { ingestId: `${namespace}:mix` });
    assert.equal(mix.fresh, 5);
    assert.equal(operationCounts(mixStart).classification, 1);
    batchResults.mixedExistingAndNew = { received: 13, fresh: 5, classificationCalls: 1 };
    report.batchRequests = batchResults;

    const semanticContext = makeItem('semantic-context', 1, 'Gold advances as global risk aversion increases safe-haven demand');
    await prisma.marketDriverNews.create({
        data: {
            id: randomUUID(), guid: semanticContext.guid, source_id: semanticContext.sourceId,
            source_key: semanticContext.sourceKey, content_hash: semanticContext.contentHash,
            normalized: normalizedTitle(semanticContext.title), day_key: board.marketDayKey(),
            headline: semanticContext.title, source: semanticContext.source, category: 'DRIVER', impact: 'High',
            summary: 'Stored context only', assets: [{ asset: 'GOLD', bias: 'Bullish', score: 1 }],
            duplicate_of: null, board_locked: true, classification_completed: true,
            semantic_dedup_completed: true, coverage_repair_completed: true,
            published_at: new Date(semanticContext.pubDate),
        },
    });
    const semanticOne = makeItem('semantic-new', 1, 'AUD/USD rises after RBA signals further tightening to contain inflation');
    const semanticStartOne = calls.length;
    await board.ingestMarketDriverRssItems([semanticOne], { ingestId: `${namespace}:semantic-1` });
    const semanticOpsOne = operationCounts(semanticStartOne);
    assert.equal(semanticOpsOne.classification, 1);
    assert.equal(semanticOpsOne.semantic_dedup, 1);
    const contextCheckpoint = await prisma.marketDriverNews.findUnique({ where: { source_key: semanticContext.sourceKey } });
    assert.equal(contextCheckpoint?.semantic_dedup_completed, true);

    const semanticTwo = makeItem('semantic-new', 2, 'NZD/USD falls after RBNZ signals additional easing may be needed');
    const semanticStartTwo = calls.length;
    await board.ingestMarketDriverRssItems([semanticTwo], { ingestId: `${namespace}:semantic-2` });
    const semanticOpsTwo = operationCounts(semanticStartTwo);
    assert.equal(semanticOpsTwo.classification, 1);
    assert.equal(semanticOpsTwo.semantic_dedup, 1);
    assert.equal((await prisma.marketDriverNews.findUnique({ where: { source_key: semanticOne.sourceKey } }))?.semantic_dedup_completed, true);
    report.semanticDedup = {
        firstRunCandidates: 1,
        secondRunCandidates: 1,
        historicalRowsAsCandidates: 0,
        calls: [semanticOpsOne.semantic_dedup, semanticOpsTwo.semantic_dedup],
    };

    // A fresh crashed semantic lease is not stolen. Once stale, the same recovery function used
    // by the new minute cron claims and completes it exactly once.
    await prisma.marketDriverNews.update({
        where: { source_key: semanticTwo.sourceKey },
        data: {
            semantic_dedup_completed: false,
            semantic_dedup_started_at: new Date(),
            semantic_dedup_worker_id: `${namespace}:crashed-semantic`,
        },
    });
    const semanticRecoveryStart = calls.length;
    assert.equal(await board.resumeIncompleteMarketDriverSemanticDedup(), 0);
    assert.deepEqual(operationCounts(semanticRecoveryStart), {});
    await prisma.marketDriverNews.update({
        where: { source_key: semanticTwo.sourceKey },
        data: { semantic_dedup_started_at: new Date(Date.now() - 11 * 60_000) },
    });
    await board.resumeIncompleteMarketDriverSemanticDedup();
    assert.equal((await prisma.marketDriverNews.findUnique({ where: { source_key: semanticTwo.sourceKey } }))?.semantic_dedup_completed, true);
    assert.equal(operationCounts(semanticRecoveryStart).semantic_dedup, 1);
    report.semanticLeaseRecovery = { freshLeaseCalls: 0, staleLeaseCalls: 1 };

    classifier.setAiProviderRequestOverrideForTests(null);
    const fallbackResults: Record<string, unknown> = {};
    const oneHeadline = [{ text: 'EUR/USD rises after central bank guidance', publishedAt: new Date() }];

    let transportCalls: Array<{ provider: 'openai' | 'groq' }> = [];
    classifier.setAiProviderTransportOverrideForTests(async (request) => {
        transportCalls.push(request);
        return {
            parsed: providerResult(request.user, request.schemaName),
            usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100, reasoningTokens: 25, totalTokens: 1100 },
            requestId: `${namespace}:primary-success`,
        };
    });
    assert.equal((await classifier.classifyHeadlines(oneHeadline, [], { ingestId: `${namespace}:provider-primary` })).length, 1);
    assert.deepEqual(transportCalls.map((call) => call.provider), ['openai']);
    const primaryUsage = await prisma.aiUsageRecord.findFirst({ where: { ingest_id: `${namespace}:provider-primary` } });
    assert.equal(primaryUsage?.estimated_total_cost?.toString(), '0.000289');
    fallbackResults.primarySuccess = { primaryAttempts: 1, fallbackAttempts: 0 };

    transportCalls = [];
    classifier.setAiProviderTransportOverrideForTests(async (request) => {
        transportCalls.push(request);
        if (request.provider === 'openai') throw asHttpError(429, 'synthetic rate limit');
        return { parsed: providerResult(request.user, request.schemaName), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    });
    assert.equal((await classifier.classifyHeadlines(oneHeadline, [], { ingestId: `${namespace}:provider-retry` })).length, 1);
    assert.equal(transportCalls.filter((call) => call.provider === 'openai').length, 3);
    assert.equal(transportCalls.filter((call) => call.provider === 'groq').length, 1);
    fallbackResults.retryablePrimary = { primaryAttempts: 3, fallbackAttempts: 1 };

    transportCalls = [];
    const fallbackItem = economicItems('fallback-persist', 1)[0]!;
    classifier.setAiProviderTransportOverrideForTests(async (request) => {
        transportCalls.push(request);
        if (request.provider === 'openai') throw asHttpError(401, 'synthetic authentication failure');
        return { parsed: providerResult(request.user, request.schemaName), usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
    });
    const fallbackPersist = await board.ingestMarketDriverRssItems([fallbackItem], { ingestId: `${namespace}:provider-permanent` });
    assert.equal(fallbackPersist.stored, 1);
    assert.equal(await prisma.marketDriverNews.count({ where: { source_key: fallbackItem.sourceKey } }), 1);
    assert.deepEqual(transportCalls.map((call) => call.provider), ['openai', 'groq']);
    fallbackResults.permanentPrimary = { primaryAttempts: 1, fallbackAttempts: 1, rowsPersisted: 1 };

    transportCalls = [];
    classifier.setAiProviderTransportOverrideForTests(async (request) => {
        transportCalls.push(request);
        if (request.provider === 'openai') return { parsed: {} };
        return { parsed: providerResult(request.user, request.schemaName), usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
    });
    assert.equal((await classifier.classifyHeadlines(oneHeadline, [], { ingestId: `${namespace}:provider-schema` })).length, 1);
    assert.deepEqual(transportCalls.map((call) => call.provider), ['openai', 'groq']);
    fallbackResults.schemaFailure = { primaryAttempts: 1, fallbackAttempts: 1 };

    // If neither provider returns a complete 12-headline response, the claimed durable job must
    // retry its own input in two smaller prompts, without persisting a partial result.
    transportCalls = [];
    const largeMalformedBatch = Array.from({ length: 12 }, (_, index) => ({
        text: `USD catalyst validation headline ${index + 1}`,
        publishedAt: new Date(),
    }));
    classifier.setAiProviderTransportOverrideForTests(async (request) => {
        transportCalls.push(request);
        const headlineCount = new Set([...request.user.matchAll(/(?:^|\n)(\d+)\.\s/g)].map((match) => Number(match[1]))).size;
        return {
            parsed: headlineCount === 12 ? {} : providerResult(request.user, request.schemaName),
            usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        };
    });
    assert.equal((await classifier.classifyHeadlines(largeMalformedBatch, [], { ingestId: `${namespace}:provider-schema-split` })).length, 12);
    assert.deepEqual(transportCalls.map((call) => call.provider), ['openai', 'groq', 'openai', 'openai']);
    fallbackResults.schemaSplitRecovery = { malformedAttempts: 2, smallerPrimaryAttempts: 2, resultsPersistable: 12 };

    transportCalls = [];
    const bothFailItem = economicItems('both-fail', 1)[0]!;
    classifier.setAiProviderTransportOverrideForTests(async (request) => {
        transportCalls.push(request);
        throw asHttpError(500, 'synthetic provider server failure');
    });
    const bothFail = await board.ingestMarketDriverRssItems([bothFailItem], { ingestId: `${namespace}:provider-both-fail` });
    assert.equal(bothFail.stored, 0);
    assert.equal(transportCalls.filter((call) => call.provider === 'openai').length, 3);
    assert.equal(transportCalls.filter((call) => call.provider === 'groq').length, 2);
    const failedJob = await prisma.aiClassificationJob.findFirst({ where: { ingest_id: `${namespace}:provider-both-fail` } });
    assert.equal(failedJob?.status, 'failed');
    assert.equal(await prisma.aiUsageRecord.count({ where: { job_id: failedJob?.id } }), 5);
    fallbackResults.bothFail = { primaryAttempts: 3, fallbackAttempts: 2, jobStatus: failedJob?.status };
    report.providerPolicy = fallbackResults;

    classifier.setAiProviderTransportOverrideForTests(null);
    await usage.recordAiUsage({
        provider: 'openai', model: 'gpt-5.4-nano', operationType: 'semantic_dedup',
        ingestId: `${namespace}:usage-semantic`, usage: { inputTokens: 50, cachedInputTokens: 20, outputTokens: 10, totalTokens: 60 },
        requestStatus: 'success', attemptNumber: 1, isRetry: false, isFallback: false,
    });
    await usage.recordAiUsage({
        provider: 'openai', model: 'gpt-5.4-nano', operationType: 'coverage_repair',
        ingestId: `${namespace}:usage-missing`, usage: null, requestStatus: 'error',
        attemptNumber: 1, isRetry: false, isFallback: false, errorKind: 'network', errorMessage: 'synthetic',
    });
    const missingUsage = await prisma.aiUsageRecord.findFirst({ where: { ingest_id: `${namespace}:usage-missing` } });
    assert.equal(missingUsage?.usage_available, false);
    assert.equal(missingUsage?.input_tokens, null);
    assert.equal(missingUsage?.total_tokens, null);
    assert.equal(missingUsage?.estimated_total_cost, null);
    const retryRows = await prisma.aiUsageRecord.findMany({ where: { ingest_id: `${namespace}:provider-retry` }, orderBy: { created_at: 'asc' } });
    assert.equal(retryRows.length, 4);
    assert.equal(retryRows.filter((row) => row.is_retry).length, 2);
    assert.equal(retryRows.filter((row) => row.is_fallback).length, 1);
    report.usageAccounting = {
        cachedInputNotDoubleCountedCostUsd: primaryUsage?.estimated_total_cost?.toString(),
        retryAttemptRows: retryRows.length,
        missingMetadataStoredAsNull: true,
        operationsVerified: ['classification', 'semantic_dedup', 'coverage_repair'],
    };

    report.instrumentation = {
        totalSyntheticCalls: calls.length,
        byOperation: operationCounts(),
        payloadSamples: calls.slice(0, 8),
    };

    console.log(JSON.stringify({ pass: true, report }, null, 2));
}

try {
    await main();
} finally {
    classifier.setAiProviderRequestOverrideForTests(null);
    classifier.setAiProviderTransportOverrideForTests(null);
    await cleanupNamespace().catch((error) => console.error('Verification cleanup failed', error));
    await prisma.$disconnect();
}
