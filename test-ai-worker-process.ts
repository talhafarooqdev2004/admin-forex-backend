/**
 * Child process used by test-ai-production-readiness.ts to recreate backend workers and race
 * independent processes against the same PostgreSQL queue. Provider keys are forced blank and a
 * synthetic provider is installed before any work is claimed.
 */
process.env.OPENAI_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.AI_CLASSIFICATION_BATCH_GAP_MS = '0';
process.env.AI_RETRY_BASE_MS = '0';

globalThis.fetch = async () => {
    throw new Error('Verification child blocked an unexpected external request');
};

const [{ prisma }, queue, classifier] = await Promise.all([
    import('./src/lib/prisma.js'),
    import('./src/services/aiClassificationQueue.service.js'),
    import('./src/services/groqClassifier.service.js'),
]);

classifier.setAiProviderRequestOverrideForTests((_system, user, options) => {
    if (options.schemaName === 'market_driver_dedup') return { duplicateGroups: [] };
    const indices = [...user.matchAll(/(?:^|\n)(\d+)\.\s/g)].map((match) => Number(match[1]));
    return {
        results: [...new Set(indices)].map((i) => ({
            i,
            category: 'DRIVER',
            impact: 'High',
            assets: [{ asset: 'USD', bias: 'Bullish', score: 1 }],
            summary: 'Synthetic worker verification',
        })),
        duplicateGroups: [],
        existingDuplicates: [],
    };
});

try {
    if (process.env.AI_VERIFY_MODE === 'replay') {
        const board = await import('./src/services/marketDriverBoard.service.js');
        const items = JSON.parse(process.env.AI_VERIFY_ITEMS_JSON || '[]') as unknown[];
        const result = await board.ingestMarketDriverRssItems(items, {
            ingestId: process.env.AI_VERIFY_INGEST_ID || undefined,
        });
        console.log(`AI_VERIFY_REPLAY_RESULT=${JSON.stringify({ fresh: result.fresh, stored: result.stored })}`);
    } else if (process.env.AI_VERIFY_JOB_ID) {
        const processed = await queue.processAiClassificationJobForTests(process.env.AI_VERIFY_JOB_ID);
        console.log(`AI_VERIFY_WORKER_PROCESSED=${processed}`);
    } else {
        const processed = await queue.processPendingAiClassificationJobs(1);
        console.log(`AI_VERIFY_WORKER_PROCESSED=${processed}`);
    }
} finally {
    classifier.setAiProviderRequestOverrideForTests(null);
    await prisma.$disconnect();
}
