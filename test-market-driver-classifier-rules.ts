/**
 * Golden regression suite for Market Driver board rules (doc §1/§4/§22/§34).
 *
 * Simulates worst-case Groq drift (IRRELEVANT/Low/no assets) and asserts
 * sanitizeClassification recovers universal categories — so new daily headlines
 * do not require code changes for known rule families.
 *
 * Run: npm run test:market-driver-rules
 */
import assert from 'node:assert/strict';
import {
    isBoardVisibleClassification,
    sanitizeClassification,
    likelySameEvent,
    eventFingerprint,
    stripOilFromFxReactionWrap,
    type ClassifiedAsset,
    type NewsCategory,
    type NewsImpact,
} from './src/services/groqClassifier.service.ts';

type Expect = {
    visible: boolean;
    category?: NewsCategory | NewsCategory[];
    assetsInclude?: string[];
};

const DRIFT = {
    category: 'IRRELEVANT' as NewsCategory,
    impact: 'Low' as NewsImpact,
    assets: [] as ClassifiedAsset[],
    summary: '',
};

function run(headline: string, expect: Expect, from = DRIFT) {
    const out = sanitizeClassification(headline, from);
    const visible = isBoardVisibleClassification(out);
    assert.equal(visible, expect.visible, `${headline}\n  visible=${visible} want ${expect.visible} → ${out.category}/${out.impact}`);
    if (expect.category) {
        const ok = Array.isArray(expect.category)
            ? expect.category.includes(out.category)
            : out.category === expect.category;
        assert.ok(ok, `${headline}\n  category=${out.category} want ${JSON.stringify(expect.category)}`);
    }
    if (expect.assetsInclude) {
        for (const a of expect.assetsInclude) {
            assert.ok(
                out.assets.some((x) => x.asset === a),
                `${headline}\n  missing asset ${a}; got ${out.assets.map((x) => x.asset).join(',')}`,
            );
        }
    }
    return out;
}

/** Must appear on News Headline even if Groq labels IRRELEVANT/Low. */
const MUST_SHOW: { headline: string; category?: Expect['category']; assetsInclude?: string[] }[] = [
    // FX wraps (Forex tab / FXS)
    { headline: 'Euro posts modest gains above 1.1350 as traders await US CPI inflation release', category: 'DRIVER', assetsInclude: ['EUR'] },
    { headline: 'Japanese Yen consolidates as USD bulls look to US CPI and Fed\'s Warsh', category: 'DRIVER', assetsInclude: ['JPY'] },
    { headline: 'Canadian Dollar gains on higher oil prices', category: 'DRIVER', assetsInclude: ['CAD'] },
    { headline: 'New Zealand dollar climbs 0.51% to 0.5775', category: 'DRIVER', assetsInclude: ['NZD'] },
    { headline: 'EUR/JPY Price Forecast: Gains ground to near 185.00', category: 'DRIVER', assetsInclude: ['EUR'] },
    { headline: 'AUD/USD Price Forecast: Tests nine-day EMA barrier near 0.6950', category: 'DRIVER', assetsInclude: ['AUD'] },
    { headline: 'Forex Today: US Dollar surges as Hormuz tensions send Oil to one-month high', category: ['DRIVER', 'GEOPOLITICAL'], assetsInclude: ['USD'] },
    { headline: 'Chinese Yuan: Consolidation after sharper drop against US Dollar – UOB', category: 'DRIVER', assetsInclude: ['USD'] },
    { headline: 'WTI spikes amid escalating Middle East Tensions', category: ['DRIVER', 'GEOPOLITICAL'], assetsInclude: ['OIL'] },
    { headline: 'Gold bounces off two-week low as USD bulls turn cautious ahead of US CPI', category: 'DRIVER', assetsInclude: ['GOLD'] },
    // CB speech / fixing (any official — not person-specific)
    { headline: 'RBNZ\'s Conway: Inflation to Return to 2% Over Medium Term', category: 'DRIVER', assetsInclude: ['NZD'] },
    { headline: 'Reserve Bank of NZ chief economist: additional easing of monetary stimulus probably needed', category: 'DRIVER', assetsInclude: ['NZD'] },
    { headline: 'PBOC sets USD/CNY reference rate at 6.7990 vs. 6.7972 previous', category: 'DRIVER', assetsInclude: ['USD'] },
    { headline: 'China PBOC likely to set yuan midpoint at 6.7927 per dollar: estimate', category: 'DRIVER', assetsInclude: ['USD'] },
    // Geopolitical
    { headline: 'US CENTCOM says US forces complete new strikes on Iranian military targets', category: 'GEOPOLITICAL', assetsInclude: ['OIL'] },
    { headline: 'Centcom: U.S. forces conduct fresh strikes on Iranian military targets', category: 'GEOPOLITICAL', assetsInclude: ['OIL'] },
    { headline: 'Iranian missiles hit two UAE tankers in Hormuz — Reuters', category: 'GEOPOLITICAL', assetsInclude: ['OIL'] },
    { headline: 'Trump on Iran: planning another significant strike Monday night', category: 'GEOPOLITICAL', assetsInclude: ['OIL'] },
    { headline: 'Iran’s Revolutionary Guards: Targeted U.S. Air Base in Jordan with Ballistic Missiles - Fars News', category: 'GEOPOLITICAL', assetsInclude: ['OIL'] },
    // Japan portfolio policy (role-based, not name-based)
    {
        headline: 'Japan’s finance minister: Sharp shift in asset management environment could prompt review of GPIF portfolio',
        category: 'DRIVER',
        assetsInclude: ['JPY'],
    },
    {
        headline: 'Japan finance minister: Japan\'s asset appeal to rise as government advances growth strategy',
        category: 'DRIVER',
        assetsInclude: ['JPY'],
    },
];

/** Must NOT appear on News Headline. */
const MUST_HIDE: string[] = [
    'Bitcoin holds at $62,000 – Pi Network leads losses',
    'Silver Price Forecast: XAG/USD dips as oil surge lifts Fed hike odds',
    'Malaysian Ringgit: Johor result keeps policy continuity – OCBC',
    'Singapore Dollar: Upside risks with CPI and Warsh in view – OCBC',
    'India Gold price today: Gold rises, according to FXStreet data',
    'China Trade Balance USD above forecasts ($121B) in June: Actual ($125.62B)',
    'China June trade surplus climbs to 859 billion yuan',
    'UK BRC Retail Sales YoY Actual 1.7% (Forecast 2.7%, Previous 3.4%)',
    'Japan Finmin: No change in Japan-U.S. joint statement on GPIF',
    'Japan FinMin: no comment on whether GPIF asset allocation shift could reduce foreign investments',
    'Nvidia cuts Asia buyer list in China chip crackdown: FT',
    'Chinese government delegation to tour North Korea July 15-17: KCNA',
];

let passed = 0;
console.log('=== MUST SHOW (recover from IRRELEVANT/Low drift) ===');
for (const c of MUST_SHOW) {
    run(c.headline, { visible: true, category: c.category, assetsInclude: c.assetsInclude });
    console.log('OK', c.headline.slice(0, 88));
    passed++;
}

console.log('\n=== MUST HIDE ===');
for (const h of MUST_HIDE) {
    run(h, { visible: false });
    console.log('OK hide', h.slice(0, 88));
    passed++;
}

// ECONOMIC prints that Groq correctly labels ECONOMIC should stay non-board
console.log('\n=== KEEP ECONOMIC OFF BOARD ===');
{
    const out = sanitizeClassification('China Exports (YoY) above expectations (18.2%) in June: Actual (27%)', {
        category: 'ECONOMIC',
        impact: 'Medium',
        assets: [{ asset: 'USD', bias: 'Bullish', score: 0.5 }],
        summary: 'Trade print',
    });
    // Scheduled print path: FX wrap detector should not promote china exports actual
    assert.equal(out.category, 'ECONOMIC', `china exports became ${out.category}`);
    assert.equal(isBoardVisibleClassification(out), false);
    console.log('OK China exports stays ECONOMIC/off-board');
    passed++;
}

console.log(`\nAll ${passed} golden rule checks passed.`);

console.log('\n=== DOC §3 OIL / IRAN DEDUP + FX WRAPS ===');
{
    assert.equal(
        eventFingerprint('Centcom: U.S. forces conduct fresh strikes on Iranian military targets'),
        eventFingerprint('US CENTCOM says US forces complete new strikes on Iranian military targets'),
    );
    assert.ok(
        likelySameEvent(
            'Centcom: U.S. forces conduct fresh strikes on Iranian military targets',
            'US CENTCOM says US forces complete new strikes on Iranian military targets',
        ),
    );
    assert.equal(
        eventFingerprint('WTI spikes amid escalating Middle East Tensions'),
        eventFingerprint('WTI Price Forecast: Advances to four-week top, near $80.00 on Hormuz supply risks'),
    );
    assert.ok(
        likelySameEvent(
            "Iran's Revolutionary Guards: Targeted U.S. Air Base in Jordan with Ballistic Missiles - Fars News",
            'Jordan: Intercepts and shoots down four missiles entering Jordanian airspace from Iranian territory - state news agency',
        ),
    );
    assert.notEqual(
        eventFingerprint('Trump on Iran: planning another significant strike Monday night'),
        eventFingerprint('Trump on Iran: believes a deal is achievable'),
        'distinct Trump asks stay separate',
    );

    const wrap = stripOilFromFxReactionWrap(
        'British Pound Sterling buckles as Trump builds the Hormuz toll booth he swore would never exist',
        [
            { asset: 'GBP', bias: 'Bearish', score: -0.5 },
            { asset: 'OIL', bias: 'Bullish', score: 0.5 },
        ],
    );
    assert.ok(!wrap.some((a) => a.asset === 'OIL'), 'FX wraps must not keep OIL');
    assert.ok(wrap.some((a) => a.asset === 'GBP'));

    const sanitized = sanitizeClassification(
        'Australian Dollar weakens to near 0.6900 as US launches more strikes against Iran',
        {
            category: 'GEOPOLITICAL',
            impact: 'Medium',
            assets: [
                { asset: 'AUD', bias: 'Bearish', score: -0.5 },
                { asset: 'OIL', bias: 'Bullish', score: 0.5 },
            ],
            summary: 'AUD soft on Iran strikes',
        },
    );
    assert.ok(!sanitized.assets.some((a) => a.asset === 'OIL'), 'sanitize drops OIL from AUD wrap');
    console.log('OK §3 fingerprints + FX-wrap OIL strip');
}
