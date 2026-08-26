import fs from 'node:fs';
const base = '/home/talha/Documents/forex/replay-fixtures/aug18-financialjuice-client-contract-replay-nano-r13.json';
const data = JSON.parse(fs.readFileSync(base, 'utf8'));
const rows = data.rows ?? [];
const summary = data.summary ?? {};

console.log('=== FINAL BOARD (arithmetic proof) ===');
for (const p of summary.finalArithmeticProof ?? []) console.log(`${p.asset}: ${p.sum}  exact=${p.exact}  terms=${JSON.stringify(p.terms)}`);

console.log('\n=== CLIENT COMPARISON ===');
for (const c of summary.clientComparison ?? []) console.log(`${c.asset}: actual=${c.actual} expected=${c.expected} dir=${c.directionMatch} range=${c.rangeMatch}`);
console.log('directionMatches', summary.directionMatches, 'rangeMatches', summary.rangeMatches);
console.log('verdict:', summary.verdict);

console.log('\n=== finalGeo ===');
console.log(JSON.stringify(summary.finalGeo));

console.log('\n=== nonzeroInvalid rows (nonzero contributionChange but not valid/independent/eligible) ===');
for (const r of rows) {
  const changed = Array.isArray(r.contributionChange) ? r.contributionChange : (r.currentAssetContributions ?? []);
  const nz = changed.filter((a) => Number(a.score) !== 0 && a.role !== 'CONFIRMATION');
  if (nz.length > 0 && (!r.valid || !r.independent || !r.catalystEligible)) {
    console.log(`guid=${r.guid} rel=${r.eventRelation} aiRel=${r.aiEventRelation} valid=${r.valid} indep=${r.independent} elig=${r.catalystEligible} status=${r.eventStatus}`);
    console.log(`  HL: ${r.headline.slice(0,110)}`);
    console.log(`  change=${JSON.stringify(nz)}`);
  }
}
