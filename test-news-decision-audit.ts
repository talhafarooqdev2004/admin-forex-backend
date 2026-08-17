import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackDecision, parseNewsDecisionAuditFilters } from './src/services/newsDecisionAudit.service.ts';

test('audit filters default to the current Dubai business day and safe pagination', () => {
    const filters = parseNewsDecisionAuditFilters({ page: '-2', pageSize: '999999', visibleOnly: 'true' });
    assert.match(filters.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(filters.page, 1);
    assert.equal(filters.pageSize, 5000);
    assert.equal(filters.visibleOnly, true);
});

test('fallback taxonomy explains persisted historical rows without fabricating exact detail', () => {
    assert.equal(fallbackDecision({ category: 'ECONOMIC', impact: 'High', assets: [], board_locked: false, duplicate_of: null }).code, 'ECONOMIC_RELEASE');
    assert.equal(fallbackDecision({ category: 'IRRELEVANT', impact: 'Low', assets: [], board_locked: false, duplicate_of: null }).code, 'IRRELEVANT');
    assert.equal(fallbackDecision({ category: 'DRIVER', impact: 'High', assets: [], board_locked: false, duplicate_of: null }).code, 'NO_TRACKED_ASSET_MAPPING');
    assert.equal(fallbackDecision({ category: 'DRIVER', impact: 'High', assets: [{ asset: 'USD', score: 1 }], board_locked: true, duplicate_of: null }).code, 'DRIVER_ACCEPTED');
    assert.equal(fallbackDecision({ category: 'DRIVER', impact: 'High', assets: [{ asset: 'USD', score: 1 }], board_locked: false, duplicate_of: 'canonical' }).code, 'SEMANTIC_DUPLICATE');
});
