/**
 * Live feed coverage audit: FJ RSS + FXStreet RSS vs today's board.
 * Thin wrapper around the SAME self-healing audit the production cron runs every 30 min
 * (src/services/marketDriverCoverageAudit.service.ts) — one source of truth, no drift
 * between what CI checks and what production enforces.
 *
 * Run: npm run test:market-driver-feed-coverage
 * Requires DATABASE_URL (importing the service loads .env via config/env).
 * Exits 1 if any rule-required live headline is still missing/hidden AFTER auto-heal.
 */
import { runMarketDriverCoverageAudit } from './src/services/marketDriverCoverageAudit.service.js';

const result = await runMarketDriverCoverageAudit();

console.log('Feed coverage audit', result.liveDay, result.ranAt);
console.log({
    feedsFetched: result.feedsFetched,
    feedsFailed: result.feedsFailed,
    uniqueLive: result.uniqueLiveItems,
    requiredByRules: result.requiredByRules,
});

console.log('\n=== RESULT ===');
console.log({
    liveDay: result.liveDay,
    requiredOk: result.requiredOk,
    healedMissing: result.healedMissing,
    healedHidden: result.healedHidden,
    gaps: result.residualGaps.length,
    systemVisible: result.systemVisible,
});

if (!result.pass) {
    console.error('\nGAPS (survived auto-heal):');
    for (const g of result.residualGaps) {
        console.error(`${g.kind} (${g.detail}) | ${g.source} | ${g.headline}`);
    }
    process.exit(1);
}
console.log('PASS — every rule-required live FJ/FXS headline is present and board-visible.');
process.exit(0);
