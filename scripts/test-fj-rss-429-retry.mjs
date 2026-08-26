#!/usr/bin/env node
/**
 * Unit test for admin-backend FinancialJuice RSS 429 retry/backoff (no live feed).
 */
import assert from 'node:assert/strict';
import {
    computeExponentialBackoffMs,
    fetchFinancialJuiceRssXml,
    parseRetryAfterMs,
    resetFinancialJuiceRssFetchStateForTests,
} from '../src/services/financialJuiceRssFetch.service.ts';

const SAMPLE_XML = `<?xml version="1.0"?><rss><channel><item><title>FinancialJuice: Test</title><guid>test1</guid></item></channel></rss>`;

assert.equal(parseRetryAfterMs('2'), 2000);
assert.equal(parseRetryAfterMs('0'), 0);
assert.equal(computeExponentialBackoffMs(1, 2000), 2000);
assert.equal(computeExponentialBackoffMs(2, 2000), 4000);
assert.equal(computeExponentialBackoffMs(3, 2000), 8000);

let callCount = 0;
let now = 1_000_000;
const fetchMock = async () => {
    callCount += 1;
    if (callCount <= 2) {
        return {
            status: 429,
            ok: false,
            headers: {
                get(name) {
                    if (name.toLowerCase() === 'retry-after') return callCount === 1 ? '1' : null;
                    return null;
                },
            },
            async text() { return ''; },
        };
    }
    return {
        status: 200,
        ok: true,
        headers: { get() { return null; } },
        async text() { return SAMPLE_XML; },
    };
};

resetFinancialJuiceRssFetchStateForTests();
const waits = [];
const xml = await fetchFinancialJuiceRssXml('https://example.test/rss', {
    maxRetries: 3,
    minIntervalMs: 0,
    backoffBaseMs: 2000,
    fetchImpl: fetchMock,
    nowFn: () => now,
    sleepFn: async (ms) => { waits.push(ms); },
});

assert.equal(callCount, 3);
assert.equal(waits[0], 1000, 'first retry should honor Retry-After=1s');
assert.equal(waits[1], 4000, 'second retry should use exponential backoff for attempt 2');
assert.match(xml, /<rss>/);

let exhaustedCalls = 0;
const always429 = async () => {
    exhaustedCalls += 1;
    return {
        status: 429,
        ok: false,
        headers: { get() { return null; } },
        async text() { return ''; },
    };
};

resetFinancialJuiceRssFetchStateForTests();
let exhausted = false;
try {
    await fetchFinancialJuiceRssXml('https://example.test/rss', {
        maxRetries: 2,
        minIntervalMs: 0,
        backoffBaseMs: 100,
        fetchImpl: always429,
        nowFn: () => now,
        sleepFn: async () => {},
    });
} catch (error) {
    exhausted = true;
    assert.equal(error.status, 429);
    assert.equal(error.stage, 'RSS_FETCH');
    assert.match(error.message, /429/);
}
assert.equal(exhausted, true);
assert.equal(exhaustedCalls, 3, '1 initial + 2 retries');

resetFinancialJuiceRssFetchStateForTests();
let sharedCalls = 0;
const sharedFetch = async () => {
    sharedCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
        status: 200,
        ok: true,
        headers: { get() { return null; } },
        async text() { return SAMPLE_XML; },
    };
};

await Promise.all([
    fetchFinancialJuiceRssXml('https://example.test/shared', {
        minIntervalMs: 0,
        fetchImpl: sharedFetch,
        sleepFn: async () => {},
    }),
    fetchFinancialJuiceRssXml('https://example.test/shared', {
        minIntervalMs: 0,
        fetchImpl: sharedFetch,
        sleepFn: async () => {},
    }),
]);
assert.equal(sharedCalls, 1, 'concurrent callers should share one in-flight fetch');

console.log(JSON.stringify({
    pass: true,
    retry_after_test: 'PASS',
    success_after_retries: 'PASS',
    exhausted_retries: 'PASS',
    in_flight_dedupe: 'PASS',
}, null, 2));
