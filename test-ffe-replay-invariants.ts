import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

type ReplayAsset = { asset?: string; score?: number; bias?: string; role?: string };
type ReplayRow = {
    time: string;
    guid: string;
    headline: string;
    aiEventRelation?: string | null;
    resolvedRelation?: string | null;
    eventRelation?: string | null;
    principalCanonicalEventId?: string | null;
    newEventMinted?: boolean;
    eventStatus?: string;
    valid?: boolean;
    independent?: boolean;
    catalystEligible?: boolean;
    currentAssetContributions?: ReplayAsset[];
    contributionChange?: ReplayAsset[];
    counterEvidence?: string[];
    transmissionReason?: string | null;
};

const defaultResult = path.resolve(process.cwd(), '../replay-fixtures/aug18-financialjuice-client-contract-replay.json');
const resultPath = path.resolve(process.argv[2] ?? process.env.FFE_REPLAY_RESULT ?? defaultResult);
const payload = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as { summary: Record<string, unknown>; rows: ReplayRow[] };
const rows = payload.rows ?? [];
const summary = payload.summary ?? {};

assert.equal(rows.length, Number(summary.inputRows), 'replay row count must equal summary inputRows');
assert.equal(new Set(rows.map((row) => row.guid)).size, rows.length, 'source GUIDs must be unique');
const parseTime = (value: string) => {
    const match = /^(\d{2})\/(\d{2})\/(\d{4}),\s+(\d{2}):(\d{2})$/.exec(value);
    assert.ok(match, `invalid Dubai timestamp: ${value}`);
    return Date.parse(`${match![3]}-${match![2]}-${match![1]}T${match![4]}:${match![5]}:00+04:00`);
};
for (let i = 1; i < rows.length; i += 1) assert.ok(parseTime(rows[i - 1]!.time) <= parseTime(rows[i]!.time), 'replay must remain chronological');

// Structural invariants evaluate the SYSTEM's reconciled decision (resolvedRelation), not the raw
// AI label (aiEventRelation is provenance only). The canonical resolver reconciles any dangling
// prior-referencing relation into a first-occurrence NEW_EVENT or principal-free IRRELEVANT context.
const relation = (row: ReplayRow) => String(row.resolvedRelation ?? row.eventRelation ?? row.aiEventRelation ?? 'NEW_EVENT').toUpperCase();
// A relation "requires a principal" iff it is meaningless without pointing at an existing tracked
// event. FORECAST_UPCOMING (a not-yet-occurred event) and HISTORICAL_COMMENTARY (a recap of a
// possibly out-of-window past event) are standalone context and never reference a tracked principal.
const requiresPrincipal = new Set(['SAME_EVENT', 'EVENT_UPDATE', 'STRENGTHENING_EVIDENCE', 'WEAKENING_EVIDENCE', 'REVERSAL', 'DE_ESCALATION', 'CONFIRMATION', 'PRICE_REACTION']);
let principalViolations = 0;
let mintedNonNewViolations = 0;
let evidenceContributionViolations = 0;
let eligibleZeroViolations = 0;
let nonzeroInvalidViolations = 0;
let signViolations = 0;
let conditionalStrongViolations = 0;
const evidenceRelations = new Set(['SAME_EVENT', 'CONFIRMATION', 'PRICE_REACTION', 'HISTORICAL_COMMENTARY', 'MACRO_RELEASE', 'FORECAST_UPCOMING', 'IRRELEVANT']);
for (const row of rows) {
    const current = Array.isArray(row.currentAssetContributions) ? row.currentAssetContributions : [];
    const changed = Array.isArray(row.contributionChange) ? row.contributionChange : current;
    const nonzeroChanged = changed.filter((asset) => Number(asset.score) !== 0 && asset.role !== 'CONFIRMATION');
    if (requiresPrincipal.has(relation(row)) && !row.principalCanonicalEventId) principalViolations += 1;
    if (relation(row) !== 'NEW_EVENT' && row.newEventMinted) mintedNonNewViolations += 1;
    if (evidenceRelations.has(relation(row)) && nonzeroChanged.length > 0) evidenceContributionViolations += 1;
    if (row.catalystEligible && current.filter((asset) => asset.role !== 'CONFIRMATION' && Number(asset.score) !== 0).length === 0) eligibleZeroViolations += 1;
    if (nonzeroChanged.length > 0 && (!row.valid || !row.independent || !row.catalystEligible)) nonzeroInvalidViolations += 1;
    for (const asset of [...current, ...changed]) {
        const score = Number(asset.score);
        const bias = String(asset.bias ?? '').toLowerCase();
        if ((score > 0 && !/(bullish|positive)/.test(bias)) || (score < 0 && !/(bearish|negative)/.test(bias)) || (score === 0 && bias && !/(neutral|mixed|none)/.test(bias))) signViolations += 1;
    }
    const context = `${row.headline} ${row.transmissionReason ?? ''} ${(row.counterEvidence ?? []).join(' ')}`.toLowerCase();
    if (/(mulls?|may|might|could|possible|unconfirmed|preparatory|preparation|considering|plans? to)/.test(context)
        && !/(confirmed|attacked|attack|hit|damage|closed|closure|disrupted|disruption|actual)/.test(context)
        && nonzeroChanged.some((asset) => Math.abs(Number(asset.score)) === 1)) conditionalStrongViolations += 1;
}

assert.equal(mintedNonNewViolations, 0, 'only NEW_EVENT may mint a canonical identity');
assert.equal(principalViolations, 0, 'state-changing/evidence relations must reference an existing principal');
assert.equal(evidenceContributionViolations, 0, 'evidence-only relations cannot add a non-zero contribution');
assert.equal(eligibleZeroViolations, 0, 'catalystEligible=true requires a non-zero contribution');
assert.equal(nonzeroInvalidViolations, 0, 'non-zero contributions require valid independent eligible state');
assert.equal(signViolations, 0, 'score/bias pairs must be directionally consistent');
assert.equal(conditionalStrongViolations, 0, 'conditional/preparatory evidence cannot receive strong +/-1');

const proof = Array.isArray(summary.finalArithmeticProof) ? summary.finalArithmeticProof as Array<{ exact?: boolean }> : [];
assert.ok(proof.length >= 10 && proof.every((row) => row.exact === true), 'final Catalyst arithmetic must reconstruct exactly for all ten assets');
const statuses = new Set(rows.map((row) => String(row.eventStatus ?? '')));
assert.ok(statuses.size > 1 || statuses.has('EVIDENCE_ONLY'), 'replay must retain meaningful non-ACTIVE/evidence state');
console.log(JSON.stringify({
    resultPath,
    rows: rows.length,
    uniqueGuids: new Set(rows.map((row) => row.guid)).size,
    statuses: [...statuses],
    principalViolations,
    mintedNonNewViolations,
    evidenceContributionViolations,
    eligibleZeroViolations,
    nonzeroInvalidViolations,
    signViolations,
    conditionalStrongViolations,
    arithmetic: 'PASS',
}, null, 2));
