/**
 * Analysis mode boundary — GPT-first vs legacy hybrid semantic engine.
 * Default: gpt_first. Set FFE_ANALYSIS_MODE=hybrid to use legacy per-headline pipeline.
 */

export type FfeAnalysisMode = 'gpt_first' | 'hybrid';

export function getFfeAnalysisMode(): FfeAnalysisMode {
    const mode = String(process.env.FFE_ANALYSIS_MODE ?? 'gpt_first').trim().toLowerCase();
    return mode === 'hybrid' ? 'hybrid' : 'gpt_first';
}

export function isGptFirstMode(): boolean {
    return getFfeAnalysisMode() === 'gpt_first';
}

export function isHybridMode(): boolean {
    return getFfeAnalysisMode() === 'hybrid';
}

/** Legacy hybrid semantic layers that MUST NOT modify GPT-first output. */
export const HYBRID_SEMANTIC_LAYERS = [
    'applyOilCausalEligibility',
    'acceptDriverContributions',
    'inferDriverChannel',
    'deriveContractTransmission',
    'deriveCommodityInventoryTransmission',
    'deriveGeoRiskPremium',
    'calculateGeopoliticalRisk (for scoring override)',
    'stripRegimeDuplicateContributions',
    'reconstructFfeCatalystBoard',
] as const;
