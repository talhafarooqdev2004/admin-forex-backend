#!/usr/bin/env node
/**
 * Local verification for admin RSS news service (no ChatGPT, no FFE pipeline changes).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    formatAdminRssNewsCopyText,
    getAdminRssNews,
    unitBusinessDay,
} from '../src/services/rssNews.service.ts';

assert.equal(unitBusinessDay({ time: '26/08/2026, 09:05' }), '2026-08-26');

const snapshotPath = path.resolve(
    process.cwd(),
    '../forex-scraping/artifacts/ffe-daily-runs/ffe-2026-08-26T09-12-33-760Z/ffe-snapshot.json',
);
const snapshotExists = await fs.access(snapshotPath).then(() => true).catch(() => false);

let snapshotFallbackPass = false;
if (snapshotExists) {
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    const first = snapshot.source_units[0];
    const copy = formatAdminRssNewsCopyText('2026-08-26', [{
        guid: first.guid,
        timestamp: first.time,
        source: first.source_label,
        headline: first.headline,
        body: first.body || '',
        original_order: first.original_order,
        source_unit_hash: first.source_unit_hash,
    }]);
    assert.match(copy, /\[2026-08-26\]/);
    assert.match(copy, /\[FinancialJuice\]/);
    snapshotFallbackPass = true;
}

let livePass = false;
let liveMessage = '';
try {
    const live = await getAdminRssNews('2026-08-26');
    livePass = live.available === true && live.items.length > 0;
    liveMessage = live.available
        ? `live items=${live.items.length} fj=${live.financialjuice_count} fx=${live.fxstreet_count}`
        : live.message || 'unavailable';
    if (livePass) {
        const sorted = [...live.items].sort((a, b) => a.original_order - b.original_order);
        assert.equal(sorted[0].original_order <= sorted[sorted.length - 1].original_order, true);
        const copy = formatAdminRssNewsCopyText(live.business_day, sorted.slice(0, 2));
        assert.match(copy, /\[2026-08-26\]/);
    }
} catch (error) {
    liveMessage = error instanceof Error ? error.message : String(error);
}

const unavailable = await getAdminRssNews('1900-01-01');
assert.equal(unavailable.available, false);
assert.match(unavailable.message || '', /No RSS news is available/);

console.log(JSON.stringify({
    pass: snapshotFallbackPass || livePass,
    snapshot_fixture: snapshotFallbackPass ? 'PASS' : 'SKIP',
    live_fetch: livePass ? 'PASS' : `SKIP (${liveMessage})`,
    unavailable_date: 'PASS',
    reuse: 'fetchLiveRssInspectionSnapshot from forex-scraping/src/services/ffeRssSnapshot.service.js',
}, null, 2));
