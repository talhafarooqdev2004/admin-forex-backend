import assert from 'node:assert/strict';
import { isAllowedMarketDriverSource } from './src/services/marketDriverBoard.service.ts';

const {
    fetchRssItems,
    mergeRssItems,
    isAllowedMarketDriverSource: scraperGate,
} = await import('../forex-scraping/src/services/marketDriverRss.service.js');

assert.equal(isAllowedMarketDriverSource('FinancialJuice'), true);
assert.equal(isAllowedMarketDriverSource('FXStreet'), false);
assert.equal(scraperGate('FinancialJuice'), true);
assert.equal(scraperGate('FXStreet'), false);

const merged = mergeRssItems(
    [{ guid: 'fj-1', sourceId: 'financialjuice:rss', source: 'FinancialJuice', title: 'FJ accepted' }],
    [{ guid: 'fxs-1', sourceId: 'fxstreet:news', source: 'FXStreet', title: 'FXS rejected' }],
);
assert.deepEqual(merged.map((item: { guid: string }) => item.guid), ['fj-1']);

const originalFetch = globalThis.fetch;
const requestedUrls: string[] = [];
try {
    globalThis.fetch = async (input) => {
        requestedUrls.push(String(input));
        return new Response(
            '<?xml version="1.0"?><rss><channel><item><guid>fj-live-1</guid><title>FinancialJuice: FFE source test</title><author>FXStreet</author><pubDate>2026-08-19T00:00:00Z</pubDate></item></channel></rss>',
            { status: 200, headers: { 'content-type': 'application/xml' } },
        );
    };
    const fetched = await fetchRssItems();
    assert.deepEqual(requestedUrls, ['https://www.financialjuice.com/feed.ashx?xml=RSS']);
    assert.deepEqual(fetched.map((item: { source: string; guid: string }) => ({ source: item.source, guid: item.guid })), [
        { source: 'FinancialJuice', guid: 'fj-live-1' },
    ]);
} finally {
    globalThis.fetch = originalFetch;
}

console.log('PASS — only FinancialJuice is fetched/admitted; FXStreet is blocked at scraper/backend boundaries.');
