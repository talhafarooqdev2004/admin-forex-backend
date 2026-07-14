import assert from 'node:assert/strict';
import test from 'node:test';

import {
    dayKeyFromPubDate,
    marketDayKey,
} from './src/services/marketDriverBoard.service.js';
import {
    calculateGeopoliticalRisk,
    type GeoHeadline,
} from './src/services/geopoliticalRisk.service.js';

test('UAE market day changes exactly at 01:00 Asia/Dubai', () => {
    assert.equal(marketDayKey(new Date('2026-07-11T20:59:59Z')), '2026-07-11');
    assert.equal(marketDayKey(new Date('2026-07-11T21:00:00Z')), '2026-07-12');
    assert.equal(dayKeyFromPubDate('2026-07-11T21:00:00Z'), '2026-07-12');
});

test('missing or invalid RSS pubDate is rejected', () => {
    assert.equal(dayKeyFromPubDate(null), null);
    assert.equal(dayKeyFromPubDate(''), null);
    assert.equal(dayKeyFromPubDate('not-a-date'), null);
});

function geo(overrides: Partial<GeoHeadline> = {}): GeoHeadline {
    return {
        headline: 'Iran military strike threatens shipping in Strait of Hormuz',
        impact: 'High',
        summary: 'Escalation raises oil risk',
        assets: [{ asset: 'OIL', bias: 'Bullish', score: 1 }],
        published_at: new Date('2026-07-12T05:00:00Z'),
        created_at: new Date('2026-07-12T05:01:00Z'),
        ...overrides,
    };
}

test('unchanged geopolitical input produces an unchanged score and band', () => {
    const rows = [geo()];
    assert.deepEqual(calculateGeopoliticalRisk(rows), calculateGeopoliticalRisk([...rows]));
});

test('geopolitical gauge ignores hidden Low, undated, and unscored rows', () => {
    const result = calculateGeopoliticalRisk([
        geo({ impact: 'Low' }),
        geo({ published_at: null }),
        geo({ assets: [{ asset: 'OIL', bias: 'Neutral', score: 0 }] }),
    ]);
    assert.equal(result.score, 0);
    assert.equal(result.eventCount, 0);
});

test('same-theater paraphrases count once', () => {
    const result = calculateGeopoliticalRisk([
        geo(),
        geo({
            headline: 'IRGC warns tanker traffic in Hormuz after missile attack',
            published_at: new Date('2026-07-12T06:00:00Z'),
        }),
    ]);
    assert.equal(result.eventCount, 1);
});
