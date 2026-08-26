import fs from 'node:fs/promises';
import {
    classifyHeadlines,
    FFE_ANALYST_PROMPT_VERSION,
    getAiEvaluationTelemetry,
    resetAiEvaluationTelemetry,
    type ClassifiedHeadline,
} from '../src/services/groqClassifier.service.js';
import { ENV } from '../src/config/env.js';

type Fixture = {
    name: string;
    text: string;
    check: (row: ClassifiedHeadline) => string | null;
};

const scoreFor = (row: ClassifiedHeadline, asset: string): number =>
    Number(row.assets.find((value) => value.asset === asset)?.score ?? 0);

const fixtures: Fixture[] = [
    { name: 'usd-vs-aud-causality', text: 'Australian Dollar gains as US Dollar struggles amid fading Fed rate hike bets', check: (r) => scoreFor(r, 'USD') >= 0 ? 'USD should be negative when the headline says USD struggles' : null },
    { name: 'uk-claimant-count', text: 'UK Claimant Count Change rises while average earnings and unemployment data include actual and forecast', check: (r) => r.category !== 'ECONOMIC' || r.catalystEligible ? 'UK release must be Macro-only' : null },
    { name: 'gbp-yen-after-uk-labour', text: 'British Pound drops against Yen after UK employment data release', check: (r) => r.causalThemeId?.toUpperCase().includes('JAPAN_GROWTH') ? 'must not become a Japan growth theme' : null },
    { name: 'eur-gbp-uk-unemployment', text: 'Euro holds gains against British Pound as UK unemployment disappoints', check: (r) => r.causalThemeId?.toUpperCase().includes('ECB') ? 'must not become ECB policy repricing' : null },
    { name: 'ulchi-defensive', text: 'Ulchi exercise is defensive, not aimed at attacking North Korea or escalating tensions', check: (r) => scoreFor(r, 'OIL') !== 0 ? 'defensive exercise must not automatically score OIL' : null },
    { name: 'euro-us-iran-risk', text: 'Euro declines as US-Iran war worries lift demand for safe havens', check: (r) => r.category === 'DRIVER' && r.geoState === 'IRRELEVANT' ? 'US-Iran worry should be geo/risk-aware' : null },
    { name: 'routine-domestic-visit', text: 'Canadian minister visits a domestic manufacturing facility during a routine political tour', check: (r) => scoreFor(r, 'CAD') !== 0 || scoreFor(r, 'OIL') !== 0 ? 'routine domestic visit must not create CAD/OIL score' : null },
    { name: 'hormuz-escalation', text: 'Hormuz escalation disrupts tanker shipping and threatens crude supply', check: (r) => scoreFor(r, 'OIL') <= 0 ? 'Hormuz escalation must score OIL positively' : null },
    { name: 'ecb-cut', text: 'ECB signals a faster pace of rate cuts as euro-area inflation cools', check: (r) => scoreFor(r, 'EUR') >= 0 ? 'dovish ECB should not be bullish EUR' : null },
    { name: 'fed-dovish-gold', text: 'Gold rises as lower US yields follow weaker inflation expectations', check: (r) => scoreFor(r, 'GOLD') <= 0 ? 'lower yields should support GOLD' : null },
    { name: 'china-retail-print', text: 'China retail sales actual 3.7%, forecast 4.1%, previous 4.2%', check: (r) => r.category !== 'ECONOMIC' ? 'scheduled China print must be ECONOMIC' : null },
    { name: 'oil-cad-direct', text: 'Canadian dollar strengthens after a sharp, fundamental WTI supply shock', check: (r) => r.category === 'IRRELEVANT' ? 'direct CAD/WTI fundamental story must not be irrelevant' : null },
    { name: 'rba-guidance', text: 'RBA keeps rates restrictive and signals no near-term easing', check: (r) => scoreFor(r, 'AUD') <= 0 ? 'hawkish RBA should support AUD' : null },
    { name: 'japan-gdp-release', text: 'Japan GDP quarter-on-quarter actual 0.3%, forecast 0.5%, previous 0.5%', check: (r) => r.category !== 'ECONOMIC' ? 'Japan GDP print must be ECONOMIC' : null },
    { name: 'silver-only', text: 'Silver price forecast turns lower after a technical resistance rejection', check: (r) => r.category !== 'IRRELEVANT' || r.assets.length > 0 ? 'silver technical item must be irrelevant' : null },
    { name: 'oil-deescalation', text: 'Shipping route through Hormuz reopens after a confirmed ceasefire agreement', check: (r) => scoreFor(r, 'OIL') > 0 ? 'confirmed reopening should not be bullish OIL' : null },
];

function cost(attempts: ReturnType<typeof getAiEvaluationTelemetry>): number {
    const price = (provider: 'openai' | 'groq') => provider === 'openai'
        ? { input: Number(ENV.AI_OPENAI_INPUT_PRICE_PER_MILLION), cached: Number(ENV.AI_OPENAI_CACHED_INPUT_PRICE_PER_MILLION), output: Number(ENV.AI_OPENAI_OUTPUT_PRICE_PER_MILLION) }
        : { input: Number(ENV.AI_GROQ_INPUT_PRICE_PER_MILLION), cached: Number(ENV.AI_GROQ_CACHED_INPUT_PRICE_PER_MILLION), output: Number(ENV.AI_GROQ_OUTPUT_PRICE_PER_MILLION) };
    return attempts.reduce((sum, attempt) => {
        const p = price(attempt.provider);
        const input = Number(attempt.usage.inputTokens ?? 0);
        const cached = Math.min(input, Number(attempt.usage.cachedInputTokens ?? 0));
        const output = Number(attempt.usage.outputTokens ?? 0);
        return sum + ((input - cached) * p.input + cached * p.cached + output * p.output) / 1_000_000;
    }, 0);
}

const reportPath = '/tmp/ffe-ai-first-model-eval.json';
resetAiEvaluationTelemetry();
const results: Array<Record<string, unknown>> = [];
for (let offset = 0; offset < fixtures.length; offset += 8) {
    const batch = fixtures.slice(offset, offset + 8);
    const classified = await classifyHeadlines(batch.map((item) => item.text), [], {
        operationType: 'classification',
        recordUsage: false,
    });
    for (const [index, fixture] of batch.entries()) {
        const row = classified.find((value) => value.index === index);
        results.push({ name: fixture.name, ok: Boolean(row) && fixture.check(row!) === null, failure: row ? fixture.check(row) : 'missing model result', output: row ?? null });
    }
}
const attempts = getAiEvaluationTelemetry();
const report = {
    generatedAt: new Date().toISOString(),
    promptVersion: FFE_ANALYST_PROMPT_VERSION,
    fixtureCount: fixtures.length,
    passed: results.filter((row) => row.ok).length,
    failed: results.filter((row) => !row.ok).length,
    providerCalls: attempts.length,
    primaryCalls: attempts.filter((row) => row.provider === 'openai').length,
    fallbackCalls: attempts.filter((row) => row.provider === 'groq').length,
    totalInputTokens: attempts.reduce((sum, row) => sum + Number(row.usage.inputTokens ?? 0), 0),
    totalOutputTokens: attempts.reduce((sum, row) => sum + Number(row.usage.outputTokens ?? 0), 0),
    totalTokens: attempts.reduce((sum, row) => sum + Number(row.usage.totalTokens ?? 0), 0),
    estimatedCostUsd: Number(cost(attempts).toFixed(8)),
    attempts: attempts.map((row) => ({ ...row, usage: { ...row.usage } })),
    results,
};
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ reportPath, fixtureCount: report.fixtureCount, passed: report.passed, failed: report.failed, providerCalls: report.providerCalls, estimatedCostUsd: report.estimatedCostUsd }, null, 2));
if (report.providerCalls > 20) process.exitCode = 2;
if (report.failed > 0) process.exitCode = 1;
