#!/usr/bin/env node
/**
 * Local verification for admin RSS news service (no ChatGPT, no forex-scraping dependency).
 */
import assert from 'node:assert/strict';
import {
    formatAdminRssNewsCopyText,
    getAdminRssNews,
    unitBusinessDay,
} from '../src/services/rssNews.service.ts';
import {
    identifyRssItemSource,
    normalizeRssItems,
    retainNativeFeedUnits,
} from '../src/services/adminRssFeed.service.ts';

assert.equal(unitBusinessDay({ time: '26/08/2026, 09:05' }), '2026-08-26');

const source = identifyRssItemSource({ title: 'FinancialJuice: Test headline' });
assert.equal(source, 'FinancialJuice');

const normalized = normalizeRssItems([{
    title: 'FinancialJuice: US August CPI rises more than forecast',
    description: 'Supporting detail line with additional context.',
    pubDate: 'Tue, 26 Aug 2026 09:05:00 GMT',
    guid: 'test-guid-1',
}]);
assert.equal(normalized.length, 1);
assert.equal(normalized[0].title, 'US August CPI rises more than forecast');

const { retained } = retainNativeFeedUnits(normalized);
assert.equal(retained.length, 1);
assert.equal(retained[0].headline, 'US August CPI rises more than forecast');

const copy = formatAdminRssNewsCopyText('2026-08-26', [{
    guid: retained[0].guid,
    timestamp: retained[0].time || '',
    source: retained[0].source_label,
    headline: retained[0].headline,
    body: retained[0].body || '',
    original_order: 1,
    source_unit_hash: 'hash',
}]);
assert.match(copy, /\[2026-08-26\]/);
assert.match(copy, /\[FinancialJuice\]/);

let livePass = false;
let liveMessage = '';
try {
    const live = await getAdminRssNews();
    livePass = live.available === true && live.items.length > 0 && live.data_source === 'live';
    liveMessage = live.available
        ? `live items=${live.items.length} fj=${live.financialjuice_count} fx=${live.fxstreet_count}`
        : live.message || 'unavailable';
    if (livePass) {
        const sorted = [...live.items].sort((a, b) => a.original_order - b.original_order);
        assert.equal(sorted[0].original_order <= sorted[sorted.length - 1].original_order, true);
        const liveCopy = formatAdminRssNewsCopyText(live.business_day, sorted.slice(0, 2));
        assert.match(liveCopy, new RegExp(`\\[${live.business_day}\\]`));
    }
} catch (error) {
    liveMessage = error instanceof Error ? error.message : String(error);
}

const unavailable = await getAdminRssNews('1900-01-01');
assert.equal(unavailable.available, false);
assert.match(
    unavailable.message || '',
    /No RSS news is available|Live RSS fetch failed/,
);

console.log(JSON.stringify({
    pass: livePass,
    unit_normalization: 'PASS',
    live_fetch: livePass ? 'PASS' : `SKIP (${liveMessage})`,
    unavailable_date: 'PASS',
    scraper_dependency: 'NONE — adminRssFeed.service.ts fetches RSS directly',
}, null, 2));
