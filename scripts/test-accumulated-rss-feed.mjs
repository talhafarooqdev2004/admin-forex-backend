#!/usr/bin/env node
/**
 * Regression tests for accumulated FinancialJuice RSS feed read API.
 * Local only — no live RSS fetch, no accumulator mutation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scrapingRoot = path.join(repoRoot, '../forex-scraping');

const {
    getAccumulatedFeedForActiveBusinessDay,
    mergeRetainedUnitsIntoState,
    loadAccumulatorState,
} = await import(pathToFileURL(path.join(
    scrapingRoot,
    'src/services/financialJuiceRssAccumulator.service.js',
)).href);

const ACTIVE_DAY = '2026-09-04';
const NOW = new Date('2026-09-04T12:00:00.000Z');

function unit(guid, publishedAt) {
    const d = new Date(publishedAt);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    return {
        guid,
        time: `${dd}/${mm}/${yyyy}, ${hh}:${min}`,
        published_at: d.toISOString(),
        epoch: d.getTime(),
        source: 'FinancialJuice',
        source_label: 'FinancialJuice',
        headline: `Headline ${guid}`,
        body: '',
        supporting_lines: [],
        actual: null,
        forecast: null,
        previous: null,
    };
}

async function withTempAccumulator(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fj-accum-api-'));
    try {
        return await fn(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

// Empty state returns count 0 safely.
await withTempAccumulator(async (dir) => {
    const payload = await getAccumulatedFeedForActiveBusinessDay({ now: NOW, accumulatorDir: dir });
    assert.equal(payload.success, true);
    assert.equal(payload.business_day, ACTIVE_DAY);
    assert.equal(payload.count, 0);
    assert.deepEqual(payload.items, []);
});

// Active business-day items are returned and count matches items.length.
await withTempAccumulator(async (dir) => {
    const state = { version: 1, days: {} };
    const merged = mergeRetainedUnitsIntoState(state, [
        unit('1001', '2026-09-04T10:00:00.000Z'),
        unit('1002', '2026-09-04T11:00:00.000Z'),
    ], { now: NOW });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'state.json'), `${JSON.stringify(merged.state, null, 2)}\n`);

    const payload = await getAccumulatedFeedForActiveBusinessDay({ now: NOW, accumulatorDir: dir });
    assert.equal(payload.count, 2);
    assert.equal(payload.items.length, 2);
    assert.equal(payload.count, payload.items.length);
    assert.equal(payload.items[0].guid, '1001');
    assert.equal(payload.items[1].guid, '1002');
    assert.ok(payload.earliest_timestamp);
    assert.ok(payload.latest_timestamp);
});

// Previous-day items stored in state are excluded from active-day response.
await withTempAccumulator(async (dir) => {
    const state = {
        version: 1,
        days: {
            [ACTIVE_DAY]: {
                business_day: ACTIVE_DAY,
                items: {
                    2001: unit('2001', '2026-09-04T10:00:00.000Z'),
                },
                first_seen_at: NOW.toISOString(),
                last_updated_at: NOW.toISOString(),
            },
            '2026-09-03': {
                business_day: '2026-09-03',
                items: {
                    3001: unit('3001', '2026-09-03T20:00:00.000Z'),
                },
                first_seen_at: NOW.toISOString(),
                last_updated_at: NOW.toISOString(),
            },
        },
        updated_at: NOW.toISOString(),
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);

    const payload = await getAccumulatedFeedForActiveBusinessDay({ now: NOW, accumulatorDir: dir });
    assert.equal(payload.count, 1);
    assert.equal(payload.items[0].guid, '2001');
    assert.ok(!payload.items.some((row) => row.guid === '3001'));
});

// Deduplicated GUIDs from accumulator state.
await withTempAccumulator(async (dir) => {
    const state = { version: 1, days: {} };
    const merged = mergeRetainedUnitsIntoState(state, [
        unit('4001', '2026-09-04T10:00:00.000Z'),
        unit('4001', '2026-09-04T10:05:00.000Z'),
    ], { now: NOW });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'state.json'), `${JSON.stringify(merged.state, null, 2)}\n`);

    const payload = await getAccumulatedFeedForActiveBusinessDay({ now: NOW, accumulatorDir: dir });
    assert.equal(payload.count, 1);
    assert.equal(new Set(payload.items.map((row) => row.guid)).size, 1);
});

const reloaded = await loadAccumulatorState({
    accumulatorDir: path.join(scrapingRoot, 'artifacts/financialjuice-rss-accumulator'),
});
if (Object.keys(reloaded.days || {}).length > 0) {
    const live = await getAccumulatedFeedForActiveBusinessDay({
        accumulatorDir: path.join(scrapingRoot, 'artifacts/financialjuice-rss-accumulator'),
    });
    assert.equal(live.count, live.items.length);
}

console.log('PASS: accumulated FinancialJuice feed API tests');
