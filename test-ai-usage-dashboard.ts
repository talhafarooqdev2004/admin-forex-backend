import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { aiUsageCostAlertStatus, parsePagination, resolveReportRange, sanitizeAiError } from './src/services/aiUsageDashboard.service.ts';

const today = resolveReportRange({ preset: 'today' });
assert.equal(today.timezone, 'Asia/Dubai');
assert.equal(today.to.getTime() - today.from.getTime(), 24 * 60 * 60 * 1000);
assert.deepEqual(resolveReportRange({ preset: 'custom', from: today.fromDate, to: today.fromDate }).from, today.from);

const beforeRollover = resolveReportRange({ preset: 'today' }, new Date('2026-08-12T20:59:00.000Z'));
assert.equal(beforeRollover.fromDate, '2026-08-12');
assert.equal(beforeRollover.from.toISOString(), '2026-08-11T21:00:00.000Z');
assert.equal(beforeRollover.to.toISOString(), '2026-08-12T21:00:00.000Z');
const atRollover = resolveReportRange({ preset: 'today' }, new Date('2026-08-12T21:00:00.000Z'));
assert.equal(atRollover.fromDate, '2026-08-13');
assert.equal(atRollover.from.toISOString(), '2026-08-12T21:00:00.000Z');
assert.equal(atRollover.to.toISOString(), '2026-08-13T21:00:00.000Z');

const custom = resolveReportRange({ preset: 'custom', from: '2026-08-01', to: '2026-08-07' });
assert.equal(custom.fromDate, '2026-08-01');
assert.equal(custom.toDate, '2026-08-07');
assert.throws(() => resolveReportRange({ preset: 'custom', from: '2026-08-07', to: '2026-08-01' }));
assert.throws(() => resolveReportRange({ preset: 'custom', from: '2025-01-01', to: '2026-08-01' }));
assert.throws(() => resolveReportRange({ preset: 'unknown' }));

assert.deepEqual(parsePagination({ page: '0', pageSize: '9999' }), { page: 1, pageSize: 100, skip: 0 });
assert.deepEqual(parsePagination({ page: '3', pageSize: '25' }), { page: 3, pageSize: 25, skip: 50 });
assert.equal(aiUsageCostAlertStatus('1.99'), 'normal');
assert.equal(aiUsageCostAlertStatus('2'), 'attention');
assert.equal(aiUsageCostAlertStatus('5'), 'warning');
assert.equal(aiUsageCostAlertStatus('8.01'), 'critical');

const sanitized = sanitizeAiError('Bearer sk-test-secret authorization: sk-other token=abc prompt stays out');
assert.ok(!sanitized?.includes('sk-test-secret'));
assert.ok(!sanitized?.includes('sk-other'));
assert.ok(!sanitized?.includes('token=abc'));

const route = await readFile('./src/routes/aiUsageDashboard.routes.ts', 'utf8');
assert.match(route, /authorize\('admin'\)/);
assert.match(route, /jobs\/:id\/retry/);
assert.doesNotMatch(route, /OPENAI_API_KEY|GROQ_API_KEY|Authorization: Bearer/);

console.log('AI usage dashboard validation tests passed');
