/**
 * GPT-first runtime pinning — analyst model/config must not silently fall back
 * to the per-headline classification model (gpt-5.4-nano).
 */

import { ENV } from '../config/env.js';
import type { StructuredJsonRequestOptions } from './groqClassifier.service.js';

export const FFE_GPT_FIRST_PINNED_DEFAULTS = {
    model: 'gpt-5.4-mini',
    reasoningEffort: 'high' as const,
    useBackground: true,
    timeoutMs: 600_000,
    maxOutputTokens: 128_000,
};

export type GptFirstRuntimeConfig = {
    model: string;
    reasoningEffort: StructuredJsonRequestOptions['reasoningEffort'];
    useBackground: boolean;
    timeoutMs: number;
    maxOutputTokens: number;
};

const ALLOWED_REASONING = new Set(['none', 'low', 'medium', 'high', 'xhigh']);

/**
 * Resolve GPT-first execution config.
 * Never reads OPENAI_CLASSIFICATION_MODEL. Unset GPT-first vars use pinned defaults.
 */
export function resolveGptFirstRuntime(overrides: {
    model?: string;
    reasoningEffort?: StructuredJsonRequestOptions['reasoningEffort'];
    useBackground?: boolean;
    timeoutMs?: number;
    maxOutputTokens?: number;
} = {}): GptFirstRuntimeConfig {
    const reasoningRaw = overrides.reasoningEffort
        ?? ENV.FFE_GPT_FIRST_REASONING_EFFORT
        ?? FFE_GPT_FIRST_PINNED_DEFAULTS.reasoningEffort;
    const reasoningEffort = ALLOWED_REASONING.has(String(reasoningRaw))
        ? reasoningRaw as StructuredJsonRequestOptions['reasoningEffort']
        : FFE_GPT_FIRST_PINNED_DEFAULTS.reasoningEffort;

    return {
        model: overrides.model || ENV.FFE_GPT_FIRST_MODEL || FFE_GPT_FIRST_PINNED_DEFAULTS.model,
        reasoningEffort,
        useBackground: overrides.useBackground ?? ENV.FFE_GPT_FIRST_USE_BACKGROUND ?? FFE_GPT_FIRST_PINNED_DEFAULTS.useBackground,
        timeoutMs: overrides.timeoutMs ?? ENV.FFE_GPT_FIRST_TIMEOUT_MS ?? FFE_GPT_FIRST_PINNED_DEFAULTS.timeoutMs,
        maxOutputTokens: Math.max(
            overrides.maxOutputTokens ?? ENV.FFE_GPT_FIRST_MAX_OUTPUT_TOKENS ?? FFE_GPT_FIRST_PINNED_DEFAULTS.maxOutputTokens,
            32_000,
        ),
    };
}

export function gptFirstUsesClassificationFallback(model: string): boolean {
    return model.trim().toLowerCase() === 'gpt-5.4-nano';
}
