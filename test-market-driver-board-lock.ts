/**
 * Board-lock stability: once a row is board_locked it must never be hidden/demoted by
 * later dedup/realign passes; new paraphrases of locked principals must still be folded
 * at admission (duplicate_of) and must not lock a second time.
 *
 * Run: npm run test:market-driver-board-lock
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { prisma } from './src/lib/prisma.ts';
import {
    getMarketDriverNews,
    markTodaysDeterministicDuplicates,
    marketDayKey,
    realignTodaysMarketDriverScores,
    repairLockedDuplicates,
} from './src/services/marketDriverBoard.service.ts';

const dayKey = marketDayKey();
const suffix = randomUUID().slice(0, 8);

async function cleanup(ids: string[]) {
    if (ids.length === 0) return;
    await prisma.marketDriverNews.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
    const ids: string[] = [];
    try {
        const lockedId = randomUUID();
        const unlockedParaphraseId = randomUUID();
        ids.push(lockedId, unlockedParaphraseId);

        const principalHeadline = `AlphaBoardLockProbe ${suffix}: Widget Council confirms surplus allocation for tracked FX study`;
        const paraphraseHeadline = `AlphaBoardLockProbe ${suffix}: Widget Council confirms surplus allocation for tracked FX study report`;

        await prisma.marketDriverNews.create({
            data: {
                id: lockedId,
                guid: `lock-test-principal-${suffix}`,
                normalized: `alpha board lock probe principal ${suffix}`,
                day_key: dayKey,
                headline: principalHeadline,
                source: 'Test',
                category: 'DRIVER',
                impact: 'High',
                summary: 'Test lock principal',
                assets: [{ asset: 'USD', bias: 'Bullish', score: 1 }],
                duplicate_of: null,
                board_locked: true,
                published_at: new Date(),
            },
        });

        await prisma.marketDriverNews.create({
            data: {
                id: unlockedParaphraseId,
                guid: `lock-test-paraphrase-${suffix}`,
                normalized: `alpha board lock probe paraphrase ${suffix}`,
                day_key: dayKey,
                headline: paraphraseHeadline,
                source: 'Test',
                category: 'DRIVER',
                impact: 'High',
                summary: 'Test lock paraphrase',
                assets: [{ asset: 'USD', bias: 'Bullish', score: 1 }],
                duplicate_of: null,
                board_locked: false,
                published_at: new Date(),
            },
        });

        const before = await getMarketDriverNews(dayKey);
        const beforeHasPrincipal = before.some((r) => r.id === lockedId);
        assert.equal(beforeHasPrincipal, true, 'locked principal must appear on News Headline');

        // Mid-day deterministic dedup must fold the unlocked paraphrase, never the locked principal.
        const marked = await markTodaysDeterministicDuplicates();
        assert.ok(marked >= 1, `expected ≥1 deterministic duplicate mark, got ${marked}`);

        const principal = await prisma.marketDriverNews.findUniqueOrThrow({ where: { id: lockedId } });
        const paraphrase = await prisma.marketDriverNews.findUniqueOrThrow({ where: { id: unlockedParaphraseId } });

        assert.equal(principal.board_locked, true, 'principal stays locked');
        assert.equal(principal.duplicate_of, null, 'locked principal must never get duplicate_of');
        assert.equal(paraphrase.duplicate_of, lockedId, 'unlocked paraphrase folds into locked principal');
        assert.equal(paraphrase.board_locked, false, 'paraphrase must not lock after being folded');

        // Simulate legacy bug: locked + duplicate_of together — repair must unlock it.
        await prisma.marketDriverNews.update({
            where: { id: unlockedParaphraseId },
            data: { board_locked: true },
        });
        const repaired = await repairLockedDuplicates();
        assert.ok(repaired >= 1, 'repair unlocks locked-duplicates');
        const paraphraseAfterRepair = await prisma.marketDriverNews.findUniqueOrThrow({
            where: { id: unlockedParaphraseId },
        });
        assert.equal(paraphraseAfterRepair.board_locked, false, 'locked-duplicate repaired to unlocked');
        assert.equal(paraphraseAfterRepair.duplicate_of, lockedId, 'still a duplicate of principal');

        // Realign must not demote the locked principal (it is skipped entirely).
        await realignTodaysMarketDriverScores();
        const principalAfterRealign = await prisma.marketDriverNews.findUniqueOrThrow({ where: { id: lockedId } });
        assert.equal(principalAfterRealign.board_locked, true);
        assert.equal(principalAfterRealign.category, 'DRIVER');
        assert.equal(principalAfterRealign.impact, 'High');
        assert.equal(principalAfterRealign.duplicate_of, null);

        const after = await getMarketDriverNews(dayKey);
        assert.equal(
            after.some((r) => r.id === lockedId),
            true,
            'locked principal still on board after dedup+realign',
        );
        assert.equal(
            after.some((r) => r.id === unlockedParaphraseId),
            false,
            'folded paraphrase must not appear on News Headline',
        );

        console.log('OK board_locked principal stays visible; paraphrase folded at mid-day dedup');
        console.log('OK realign does not demote locked principal');
        console.log(`All board-lock checks passed (day=${dayKey}).`);
    } finally {
        await cleanup(ids);
        await prisma.$disconnect();
    }
}

main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
});
