#!/usr/bin/env node
/**
 * Regression tests for accumulated FinancialJuice RSS feed persistence + read API.
 * Local only — no live RSS fetch, no forex-scraping filesystem dependency.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    getAccumulatedFinancialJuiceFeed,
    syncAccumulatedFinancialJuiceFeed,
} from '../src/services/accumulatedRssFeed.service.ts';
import { resetAccumulatedRssPersistState } from '../src/services/accumulatedRssPersist.service.ts';

const ACTIVE_DAY = '2026-09-04';
const PREVIOUS_DAY = '2026-09-03';
const NOW = new Date('2026-09-04T12:00:00.000Z');

function item(guid, publishedAt, source = 'FinancialJuice') {
    const d = new Date(publishedAt);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    return {
        guid,
        timestamp: `${dd}/${mm}/${yyyy}, ${hh}:${min}`,
        source,
        headline: `Headline ${guid}`,
        body: '',
        original_order: 1,
        source_unit_hash: `hash-${guid}`,
        published_at: d.toISOString(),
        epoch: d.getTime(),
    };
}

async function withPersistEnv(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fj-accum-persist-'));
    const statePath = path.join(dir, 'state.json');
    const previousPath = process.env.ACCUMULATED_RSS_STATE_PATH;
    process.env.ACCUMULATED_RSS_STATE_PATH = statePath;
    resetAccumulatedRssPersistState({ deleteFile: true });

    try {
        return await fn({ dir, statePath });
    } finally {
        resetAccumulatedRssPersistState({ deleteFile: true });
        if (previousPath == null) delete process.env.ACCUMULATED_RSS_STATE_PATH;
        else process.env.ACCUMULATED_RSS_STATE_PATH = previousPath;
        await fs.rm(dir, { recursive: true, force: true });
    }
}

// Empty state returns count 0 safely.
await withPersistEnv(async () => {
    const payload = await getAccumulatedFinancialJuiceFeed(NOW);
    assert.equal(payload.success, true);
    assert.equal(payload.business_day, ACTIVE_DAY);
    assert.equal(payload.count, 0);
    assert.deepEqual(payload.items, []);
});

// Sync stores data and GET returns persisted items.
await withPersistEnv(async () => {
    const syncPayload = {
        business_day: ACTIVE_DAY,
        count: 2,
        earliest_timestamp: '2026-09-04T10:00:00.000Z',
        latest_timestamp: '2026-09-04T11:00:00.000Z',
        financialjuice_count: 2,
        fxstreet_count: 0,
        items: [
            item('1001', '2026-09-04T10:00:00.000Z'),
            item('1002', '2026-09-04T11:00:00.000Z'),
        ],
    };

    const syncResult = syncAccumulatedFinancialJuiceFeed(syncPayload, NOW);
    assert.equal(syncResult.count, 2);
    assert.equal(syncResult.added, 2);

    const payload = await getAccumulatedFinancialJuiceFeed(NOW);
    assert.equal(payload.count, 2);
    assert.equal(payload.items.length, 2);
    assert.equal(payload.count, payload.items.length);
    assert.equal(payload.items[0].guid, '1001');
    assert.equal(payload.items[1].guid, '1002');
});

// Repeated sync does not duplicate items.
await withPersistEnv(async () => {
    const syncPayload = {
        business_day: ACTIVE_DAY,
        items: [
            item('2001', '2026-09-04T10:00:00.000Z'),
            item('2002', '2026-09-04T11:00:00.000Z'),
        ],
    };

    syncAccumulatedFinancialJuiceFeed(syncPayload, NOW);
    const second = syncAccumulatedFinancialJuiceFeed(syncPayload, NOW);
    assert.equal(second.added, 0);

    const payload = await getAccumulatedFinancialJuiceFeed(NOW);
    assert.equal(payload.count, 2);
    assert.equal(new Set(payload.items.map((row) => row.guid)).size, 2);
});

// Deduplication by GUID on repeated sync with overlapping items.
await withPersistEnv(async () => {
    syncAccumulatedFinancialJuiceFeed({
        business_day: ACTIVE_DAY,
        items: [item('3001', '2026-09-04T10:00:00.000Z')],
    }, NOW);
    syncAccumulatedFinancialJuiceFeed({
        business_day: ACTIVE_DAY,
        items: [
            item('3001', '2026-09-04T10:05:00.000Z'),
            item('3002', '2026-09-04T11:00:00.000Z'),
        ],
    }, NOW);

    const payload = await getAccumulatedFinancialJuiceFeed(NOW);
    assert.equal(payload.count, 2);
    assert.equal(payload.items.find((row) => row.guid === '3001')?.headline, 'Headline 3001');
});

// Previous-day items stored in persistence are excluded from active-day GET.
await withPersistEnv(async () => {
    syncAccumulatedFinancialJuiceFeed({
        business_day: ACTIVE_DAY,
        items: [item('4001', '2026-09-04T10:00:00.000Z')],
    }, NOW);
    syncAccumulatedFinancialJuiceFeed({
        business_day: PREVIOUS_DAY,
        items: [item('4002', '2026-09-03T20:00:00.000Z')],
    }, NOW);

    const payload = await getAccumulatedFinancialJuiceFeed(NOW);
    assert.equal(payload.count, 1);
    assert.equal(payload.items[0].guid, '4001');
    assert.ok(!payload.items.some((row) => row.guid === '4002'));
});

// Count matches stored items and source breakdown.
await withPersistEnv(async () => {
    syncAccumulatedFinancialJuiceFeed({
        business_day: ACTIVE_DAY,
        items: [
            item('5001', '2026-09-04T10:00:00.000Z', 'FinancialJuice'),
            item('5002', '2026-09-04T11:00:00.000Z', 'FXStreet'),
        ],
    }, NOW);

    const payload = await getAccumulatedFinancialJuiceFeed(NOW);
    assert.equal(payload.count, payload.items.length);
    assert.equal(payload.financialjuice_count, 1);
    assert.equal(payload.fxstreet_count, 1);
    assert.ok(payload.earliest_timestamp);
    assert.ok(payload.latest_timestamp);
});

console.log('PASS: accumulated FinancialJuice feed API tests');
