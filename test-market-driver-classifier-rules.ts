import assert from 'node:assert/strict';
import {
    CATALYST_CURRENCIES,
    eventFingerprint,
    isBoardVisibleClassification,
    likelySameEvent,
    sanitizeClassification,
    type ClassifiedAsset,
    type NewsCategory,
    type NewsImpact,
} from './src/services/groqClassifier.service.ts';

const DRIFT = {
    category: 'IRRELEVANT' as NewsCategory,
    impact: 'Low' as NewsImpact,
    assets: [] as ClassifiedAsset[],
    summary: '',
};

function classify(headline: string, input = DRIFT) {
    return sanitizeClassification(headline, input);
}

function scoreOf(result: ReturnType<typeof classify>, currency: string) {
    return result.assets.find((asset) => asset.asset === currency)?.score;
}

function assertScores(headline: string, expected: Record<string, number>, input = DRIFT) {
    const result = classify(headline, input);
    assert.equal(isBoardVisibleClassification(result), true, `${headline} should be visible`);
    assert.deepEqual(
        Object.fromEntries(result.assets.map((asset) => [asset.asset, asset.score])),
        expected,
        headline,
    );
    for (const asset of result.assets) assert.ok(CATALYST_CURRENCIES.includes(asset.asset as never));
}

console.log('=== FFE Catalyst Driver Scoring Rules ===');

assertScores(
    'Confirmed missile strikes disrupt Hormuz shipping and trigger broad risk-off flows',
    { USD: 0.5, CHF: 0.5, AUD: -0.5, NZD: -0.5, EUR: -0.25, GBP: -0.25 },
);

assertScores(
    'Confirmed Hormuz shipping disruption sends USD/JPY lower as safe-haven yen buying accelerates',
    { USD: 0.5, CHF: 0.5, AUD: -0.5, NZD: -0.5, EUR: -0.25, GBP: -0.25, JPY: 0.5 },
);

assertScores(
    'Brent surges on a major Hormuz supply disruption',
    { CAD: 1, JPY: -0.5, EUR: -0.25 },
);

assertScores(
    'WTI falls as a supply disruption eases and Hormuz shipping reopens',
    { CAD: -1, JPY: 0.25 },
);

assertScores(
    'China announces major stimulus and iron ore demand rebounds strongly',
    { AUD: 1, NZD: 0.25 },
);

assertScores(
    'Severe China property deterioration causes a sharp fall in copper demand',
    { AUD: -1, NZD: -0.25 },
);

assertScores('Global Dairy Trade records a strong dairy-price rise', { NZD: 0.5 });

assertScores(
    'Fed signals rates may remain higher for longer',
    { USD: 0.5 },
    { category: 'DRIVER', impact: 'Medium', assets: [{ asset: 'USD', bias: 'Bullish', score: 0.5 }], summary: 'Fed guidance' },
);

assertScores(
    'ECB policymakers express mild inflation concern',
    { EUR: 0.25 },
    { category: 'DRIVER', impact: 'Medium', assets: [{ asset: 'EUR', bias: 'Bullish', score: 0.25 }], summary: 'ECB guidance' },
);

const HIDDEN = [
    'EUR/USD may fall toward 1.1200',
    'GBP/USD remains above the 200-day average',
    'AUD/JPY tests resistance after breakout',
    'EUR/USD Price Forecast: Gains ground to near 1.1850',
    'US CPI Actual 3.1% Forecast 3.0% Previous 2.9%',
    'Bitcoin rallies after crypto ETF inflows',
    'Company earnings lift Nvidia shares',
    'Officials may discuss policy next month',
    'Chinese Yuan: Credit softness may spur PBoC easing – Commerzbank',
    'Chinese yuan forecast: bulls expect strength ahead',
    'PBOC officials speculate on yuan direction next month',
    'Yuan climbs as traders position for firmer economic data',
];
for (const headline of HIDDEN) {
    const result = classify(headline);
    assert.equal(isBoardVisibleClassification(result), false, `${headline} must be excluded`);
    assert.equal(result.category, 'IRRELEVANT');
}

assert.ok(
    eventFingerprint('WTI spikes amid escalating Middle East Tensions') ===
        eventFingerprint('WTI Price Forecast: Advances to four-week top, near $80.00 on Hormuz supply risks') &&
        likelySameEvent(
            'WTI spikes amid escalating Middle East Tensions',
            'WTI Price Forecast: Advances to four-week top, near $80.00 on Hormuz supply risks',
        ),
    'same underlying oil shock must only count once per currency',
);

console.log('All FFE Catalyst Driver scoring checks passed.');
