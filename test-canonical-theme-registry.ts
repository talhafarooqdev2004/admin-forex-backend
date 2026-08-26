import assert from 'node:assert/strict';
import {
    InMemoryCanonicalThemeRegistry,
    buildCanonicalThemeId,
    resolveCanonicalThemeDecision,
} from './src/services/canonicalThemeRegistry.service.ts';

const day = '2026-08-18';
const registry = new InMemoryCanonicalThemeRegistry(day);

const created = registry.apply({
    action: 'CREATE_NEW_THEME',
    themeKey: 'hormuz-supply-risk',
    label: 'Hormuz supply risk',
    summary: 'Confirmed shipping disruption raises crude risk',
    status: 'ACTIVE',
    assetContributions: [{ asset: 'OIL', bias: 'Bullish', score: 1, role: 'DIRECT', reason: 'supply disruption' }],
    confidence: 0.95,
});
assert(created.themeId);
assert.equal(registry.list().length, 1);
assert.equal(registry.list()[0]!.assetContributions[0]!.score, 1);

const joined = registry.apply({
    action: 'JOIN_EXISTING_THEME',
    themeId: created.themeId,
    themeKey: 'hormuz-supply-risk',
    label: 'Hormuz supply risk',
    summary: 'WTI confirms the existing supply risk',
    status: 'ACTIVE',
    assetContributions: [{ asset: 'OIL', bias: 'Bullish', score: 0, role: 'CONFIRMATION', reason: 'price confirmation' }],
    confidence: 0.9,
});
assert.equal(joined.themeId, created.themeId);
assert.equal(registry.list().length, 1, 'confirmation must not create a second theme');
assert.equal(registry.list()[0]!.assetContributions[0]!.score, 1, 'confirmation must not add or erase score');

const strengthenedJoin = registry.apply({
    action: 'JOIN_EXISTING_THEME',
    themeId: created.themeId,
    themeKey: 'hormuz-supply-risk',
    label: 'Hormuz supply risk',
    summary: 'A second wire confirms the same causal cluster',
    status: 'ACTIVE',
    geoState: 'ESCALATION',
    eventRelation: 'NEW_EVENT',
    assetContributions: [{ asset: 'OIL', bias: 'Bullish', score: 0.5, role: 'DIRECT', reason: 'same supply chain' }],
    confidence: 0.9,
});
assert.equal(strengthenedJoin.themeId, created.themeId);
assert.equal(registry.list()[0]!.assetContributions[0]!.score, 1, 'a weaker JOIN must not dilute theme state');
assert.equal(registry.list()[0]!.geoState, 'ESCALATION');

const reversed = registry.apply({
    action: 'REVERSE_EXISTING_THEME',
    themeId: created.themeId,
    themeKey: 'hormuz-supply-risk',
    label: 'Hormuz supply risk',
    summary: 'Route reopened and risk premium reverses',
    status: 'REVERSED',
    assetContributions: [],
    confidence: 0.85,
});
assert.equal(reversed.themeId, created.themeId);
assert.equal(registry.list()[0]!.status, 'REVERSED');
assert.equal(registry.list()[0]!.assetContributions[0]!.score, -1);

const unknownJoin = resolveCanonicalThemeDecision({
    action: 'JOIN_EXISTING_THEME',
    themeId: 'theme_not_in_context',
    themeKey: 'new-policy-theme',
    label: 'New policy theme',
    summary: 'No matching active candidate',
    assetContributions: [],
    confidence: 0.5,
}, registry.list());
assert.equal(unknownJoin.action, 'CREATE_NEW_THEME', 'unknown model theme IDs must not be trusted');
assert.equal(buildCanonicalThemeId(day, 'hormuz-supply-risk'), created.themeId);

console.log('PASS — canonical theme create/join/confirmation/reversal and unknown-id validation.');
