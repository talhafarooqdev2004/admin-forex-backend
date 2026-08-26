/**
 * GPT-first production path — ChatGPT Project ingest → validate → persist → board read.
 * The old OpenAI API semantic analysis execution path has been removed.
 */

import { prisma } from '../lib/prisma.js';
import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';
import { FFE_NEWS_SOURCE, marketDayKey, type CatalystBoardRow } from './marketDriverBoard.service.js';
import { isGptFirstMode } from './ffeAnalysisMode.service.js';
import {
    completeGptFirstSessionItems,
    sessionInputHash,
    type GptFirstAnalysisOutput,
    type GptFirstAnalysisResult,
    type GptFirstSessionInput,
    type GptFirstSessionItem,
    FFE_GPT_FIRST_PROMPT_VERSION,
} from './ffeGptFirstAnalysis.service.js';
import { TRACKED_ASSETS } from './groqClassifier.service.js';

export const GPT_FIRST_SOURCE = 'gpt_first';

export type GptFirstPersistedAnalysis = {
    dayKey: string;
    inputHash: string;
    promptVersion: string;
    model: string;
    provider: string;
    accepted: boolean;
    analysis: GptFirstAnalysisOutput;
    persistedAt: string;
};

export async function buildGptFirstSessionInput(dayKey: string): Promise<GptFirstSessionInput | null> {
    const rows = await prisma.marketDriverNews.findMany({
        where: {
            day_key: dayKey,
            source: FFE_NEWS_SOURCE,
        },
        orderBy: [{ published_at: 'asc' }, { id: 'asc' }],
        select: {
            guid: true,
            headline: true,
            published_at: true,
            created_at: true,
            macro_actual: true,
            macro_forecast: true,
            macro_previous: true,
        },
    });
    if (!rows.length) return null;

    const items: GptFirstSessionItem[] = completeGptFirstSessionItems(rows.map((row) => ({
        guid: row.guid,
        time: (row.published_at ?? row.created_at).toISOString(),
        headline: row.headline,
        actual: row.macro_actual,
        forecast: row.macro_forecast,
        previous: row.macro_previous,
        source_label: FFE_NEWS_SOURCE,
    })));

    return {
        source: 'FinancialJuice',
        business_day: dayKey,
        cutoff: items.at(-1)!.time,
        items,
    };
}

export function gptFirstOutputToCatalystBoard(output: GptFirstAnalysisOutput): CatalystBoardRow[] {
    return TRACKED_ASSETS.map((asset) => {
        const row = output.final_board.find((entry) => entry.asset === asset);
        const score = row?.score ?? 0;
        const driverRefs = row?.driver_refs ?? [];
        return {
            asset,
            bullishCount: score > 0 ? driverRefs.length || 1 : 0,
            bearishCount: score < 0 ? driverRefs.length || 1 : 0,
            driverScore: score,
            themes: driverRefs,
        };
    });
}

export async function persistGptFirstAnalysis(
    dayKey: string,
    result: GptFirstAnalysisResult,
): Promise<void> {
    if (!result.accepted) {
        logger.warn('[GptFirst] Refusing to persist analysis that failed integrity validation', {
            dayKey,
            issues: result.validation.issues.slice(0, 5),
        });
        return;
    }

    const inputHash = result.output.session.input_hash;
    const catalystBoard = gptFirstOutputToCatalystBoard(result.output);
    const latest = await prisma.marketDriverSessionSnapshot.findFirst({
        where: { day_key: dayKey, source: GPT_FIRST_SOURCE },
        orderBy: { version: 'desc' },
        select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    await prisma.marketDriverSessionSnapshot.create({
        data: {
            day_key: dayKey,
            source: GPT_FIRST_SOURCE,
            ledger_fingerprint: inputHash.slice(0, 64),
            version,
            status: result.accepted ? 'VALID' : 'REJECTED',
            as_of: new Date(),
            prompt_version: result.promptVersion,
            provider: result.provider,
            model: result.model,
            snapshot: result.output as object,
            catalyst_board: catalystBoard,
            macro_board: result.output.macro,
            driver_clusters: result.output.drivers,
            geo_state: result.output.geo,
            confidence: result.output.quality.model_confidence,
            needs_review: result.needsReview || !result.accepted || result.output.quality.warnings.length > 0,
            input_event_count: result.output.session.input_count,
            input_theme_count: result.output.drivers.length,
        },
    });
}

export async function getLatestGptFirstAnalysis(dayKey: string): Promise<GptFirstPersistedAnalysis | null> {
    const row = await prisma.marketDriverSessionSnapshot.findFirst({
        where: { day_key: dayKey, source: GPT_FIRST_SOURCE, status: 'VALID' },
        orderBy: { version: 'desc' },
    });
    if (!row) return null;
    return {
        dayKey,
        inputHash: row.ledger_fingerprint,
        promptVersion: row.prompt_version,
        model: row.model ?? 'chatgpt-browser-automation',
        provider: row.provider ?? 'chatgpt_project',
        accepted: row.status === 'VALID',
        analysis: row.snapshot as GptFirstAnalysisOutput,
        persistedAt: row.created_at.toISOString(),
    };
}

export async function getGptFirstCatalystBoard(dayKey: string = marketDayKey()): Promise<CatalystBoardRow[] | null> {
    const persisted = await getLatestGptFirstAnalysis(dayKey);
    if (!persisted?.accepted) return null;
    return gptFirstOutputToCatalystBoard(persisted.analysis);
}

export { isGptFirstMode, FFE_GPT_FIRST_PROMPT_VERSION };
