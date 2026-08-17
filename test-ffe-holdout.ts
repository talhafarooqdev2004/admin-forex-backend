import assert from 'node:assert/strict';
import { inferGeoState } from './src/services/ffeDecisionEngine.service.ts';
import { isBoardVisibleClassification, likelySameEvent, sanitizeClassification } from './src/services/groqClassifier.service.ts';

type Case = {
    name: string;
    headline: string;
    category: 'ECONOMIC' | 'DRIVER' | 'GEOPOLITICAL' | 'IRRELEVANT';
    asset?: string;
    sign?: number;
    visible?: boolean;
    geoState?: string;
};

const cases: Case[] = [
    {
        name: 'unseen Canada CPI surprise',
        headline: 'Canada core CPI came in at 2.4% versus 2.2% in July',
        category: 'ECONOMIC', asset: 'CAD', sign: 1, visible: false,
    },
    {
        name: 'unseen China activity miss',
        headline: 'China Retail Sales Actual 0.8% (Forecast 1.2%) in July',
        category: 'ECONOMIC', asset: 'AUD', sign: -1, visible: false,
    },
    {
        name: 'unseen diplomatic watch',
        headline: 'Iran and Oman continue difficult talks with no confirmed outcome',
        category: 'GEOPOLITICAL', visible: false, geoState: 'WATCH',
    },
    {
        name: 'unseen confirmed escalation',
        headline: 'Iranian forces launch a missile strike near a commercial tanker',
        category: 'GEOPOLITICAL', asset: 'OIL', sign: 1, visible: true, geoState: 'ESCALATION',
    },
    {
        name: 'unseen confirmed de-escalation',
        headline: 'Confirmed ceasefire agreement reopens the shipping route',
        category: 'GEOPOLITICAL', asset: 'OIL', sign: -1, visible: true, geoState: 'DE_ESCALATION',
    },
    {
        name: 'unseen central-bank guidance',
        headline: 'RBA says persistent inflation keeps a hike on the table',
        category: 'DRIVER', asset: 'AUD', sign: 1, visible: true,
    },
    {
        name: 'opposing yield direction',
        headline: 'Gold falls as US real yields rise and the dollar firms',
        category: 'DRIVER', asset: 'GOLD', sign: -1, visible: true,
    },
];

for (const testCase of cases) {
    const result = sanitizeClassification(testCase.headline, { category: testCase.category, impact: 'Medium', assets: [], summary: '' });
    assert.equal(result.category, testCase.category, testCase.name);
    if (testCase.asset) {
        const asset = result.assets.find((item) => item.asset === testCase.asset);
        assert.ok(asset, `${testCase.name}: expected ${testCase.asset}`);
        assert.equal(Math.sign(asset!.score), testCase.sign, `${testCase.name}: sign`);
    }
    if (testCase.geoState) assert.equal(inferGeoState(testCase.headline), testCase.geoState, `${testCase.name}: geo state`);
    assert.equal(isBoardVisibleClassification(result), testCase.visible, `${testCase.name}: Catalyst visibility`);
}

assert.equal(likelySameEvent(
    'RBA inflation remains sticky; another hike is possible',
    'RBA says inflation remains sticky; another hike remains possible',
), true, 'unseen same-policy briefing paraphrases deduplicate');
assert.equal(likelySameEvent(
    'Gold rises as real yields fall in the morning',
    'Gold falls as real yields rise in the evening',
), false, 'opposing moves remain separate events');

console.log(JSON.stringify({ holdoutCases: cases.length, duplicatePairs: 2, passed: true }));
