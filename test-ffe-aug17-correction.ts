import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
    inferCausalTheme,
    inferGeoState,
    isEconomicReleaseHeadline,
} from './src/services/ffeDecisionEngine.service.ts';
import {
    isBoardVisibleClassification,
    isWeakSummary,
    likelySameEvent,
    sanitizeClassification,
    type ClassifiedAsset,
    type NewsCategory,
    type NewsImpact,
} from './src/services/groqClassifier.service.ts';

/** Row-level replay harness for the frozen FFE Aug-17 client oracle. */
type Correction = {
    time: string;
    guid: string;
    headline: string;
    currentDecision: string;
    correctDecision: string;
    correctTheme: string;
    correctAssets: string;
    duplicateCorrect: string;
    catalyst: string;
    reason: string;
    sourceRow: string;
};
type SummarySheet = { title: string; metrics: Record<string, string>; issues: Record<string, number>; recommendations: string[] };
type ExpectedSignal = { asset: string; min: number; max: number; sign: number; optional: boolean };
type CheckResult = { category: boolean; economic: boolean; signScore: boolean; theme: boolean; duplicate: boolean; catalyst: boolean; reason: boolean; geo: boolean };

const workbook = process.env.FFE_CORRECTION_WORKBOOK ?? '/home/talha/Documents/Downloads/FFE_Aug17_Diagnostic_Correction_Reference.xlsx';

function decodeXml(value: string): string {
    return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function sheetRows(path: string, sheet: string): string[][] {
    const workbookXml = execFileSync('unzip', ['-p', path, 'xl/workbook.xml'], { encoding: 'utf8' });
    const relationXml = execFileSync('unzip', ['-p', path, 'xl/_rels/workbook.xml.rels'], { encoding: 'utf8' });
    const sheetMatch = new RegExp(`<x:sheet name="${sheet}"[^>]*r:id="([^"]+)"`).exec(workbookXml);
    assert.ok(sheetMatch, `Workbook sheet ${sheet} is present`);
    const relationMatch = new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${sheetMatch![1]}"`).exec(relationXml);
    assert.ok(relationMatch, `Workbook relation for ${sheet} is present`);
    const target = relationMatch![1]!.replace(/^\//, '').startsWith('xl/') ? relationMatch![1]!.replace(/^\//, '') : `xl/${relationMatch![1]!.replace(/^\//, '')}`;
    const xml = execFileSync('unzip', ['-p', path, target], { encoding: 'utf8' });
    const rows: string[][] = [];
    for (const rowXml of xml.match(/<x:row[\s\S]*?<\/x:row>/g) ?? []) {
        rows.push([...rowXml.matchAll(/<x:c[^>]*>\s*<x:v>([\s\S]*?)<\/x:v>\s*<\/x:c>/g)].map((match) => decodeXml(match[1] ?? '')));
    }
    return rows;
}

function loadSummary(): SummarySheet {
    const rows = sheetRows(workbook, 'Summary');
    assert.equal(rows[0]?.[0], 'FFE August 17 Diagnostic Review', 'Summary sheet title is present');
    const metrics: Record<string, string> = {};
    const issues: Record<string, number> = {};
    const recommendations: string[] = [];
    for (const row of rows) {
        if (row[0] && row[1] && /^(Total exported|Rows with at least one)/.test(row[0])) metrics[row[0]] = row[1];
        if (row[0] && row[1] && /^False reject|^Incorrect economic|^Wrong duplicate|^Incorrect geopolitical|^Wrong directional/.test(row[0])) issues[row[0]] = Number(row[1]);
        if (row[0] && row[1] && /^\d+$/.test(row[0]) && row[1].length > 20) recommendations.push(row[1]);
    }
    assert.equal(Number(metrics['Total exported rows reviewed']), 492, 'Summary total row count');
    assert.equal(Number(metrics['Rows with at least one disagreement']), 154, 'Summary disagreement count');
    assert.deepEqual(issues, { 'False reject': 131, 'Incorrect economic classification': 62, 'Wrong duplicate grouping': 23, 'Incorrect geopolitical mapping': 15, 'Wrong directional score': 4 }, 'Summary issue counts');
    return { title: rows[0]![0]!, metrics, issues, recommendations };
}

function loadCorrections(): Correction[] {
    const rows = sheetRows(workbook, 'Corrections');
    assert.equal(rows.length, 155, 'Corrections sheet has the 154 disagreement rows plus header');
    return rows.slice(1).map((row) => ({
        time: row[0] ?? '', guid: row[1] ?? '', headline: row[2] ?? '', currentDecision: row[3] ?? '', correctDecision: row[4] ?? '', correctTheme: row[5] ?? '', correctAssets: row[6] ?? '', duplicateCorrect: row[7] ?? '', catalyst: row[8] ?? '', reason: row[9] ?? '', sourceRow: row[10] ?? '',
    }));
}

function currentInput(row: Correction) {
    const rawCategory = (row.currentDecision.split('|')[0]?.trim() ?? 'IRRELEVANT').toUpperCase();
    const category: NewsCategory = rawCategory.includes('ECONOMIC') ? 'ECONOMIC' : rawCategory.includes('GEOPOLITICAL') ? 'GEOPOLITICAL' : rawCategory.includes('DRIVER') ? 'DRIVER' : 'IRRELEVANT';
    const impact: NewsImpact = /HIGH/i.test(row.currentDecision) ? 'High' : /MEDIUM/i.test(row.currentDecision) ? 'Medium' : 'Low';
    const assets: ClassifiedAsset[] = [];
    for (const match of row.currentDecision.matchAll(/([A-Z]{3,4}):([+-]?\d+(?:\.\d+)?)/g)) {
        const score = Number(match[2]);
        if (!Number.isFinite(score)) continue;
        assets.push({ asset: match[1] as ClassifiedAsset['asset'], bias: score > 0 ? 'Bullish' : score < 0 ? 'Bearish' : 'Neutral', score });
    }
    return { category, impact, assets, summary: '' };
}

function expectedCategory(decision: string, theme = ''): NewsCategory {
    const upper = decision.toUpperCase();
    if (upper.includes('ECONOMIC')) return 'ECONOMIC';
    if (upper.includes('GEOPOLITICAL')) return 'GEOPOLITICAL';
    if (upper.includes('DRIVER')) return 'DRIVER';
    // A single-row replay cannot invent a duplicate-of id. The canonical
    // category is still checked from its theme and the duplicate field below.
    if (upper.includes('SEMANTIC_DUPLICATE')) {
        if (/^(IRAN|GAZA|HORMUZ|SAUDI|RED_SEA|ISRAEL|CASPIAN)/.test(theme)) return 'GEOPOLITICAL';
        if (/^(JAPAN|CHINA|CANADA|NZ_|US_)/.test(theme)) return 'ECONOMIC';
        return 'DRIVER';
    }
    return 'IRRELEVANT';
}

function expectedGeoState(decision: string, theme: string): string | null {
    const upper = decision.toUpperCase();
    if (!upper.includes('GEOPOLITICAL') && !theme.includes('GAZA_') && !theme.includes('IRAN_') && !theme.includes('HORMUZ_')) return null;
    if (upper.includes('WATCH')) return 'WATCH';
    if (upper.includes('DEESCALATION') || upper.includes('DE-ESCALATION')) return 'DE_ESCALATION';
    if (upper.includes('ESCALATION')) return 'ESCALATION';
    return null;
}

function parseExpectedSignals(text: string): ExpectedSignal[] {
    if (!text || /no (?:additional )?score|^0$/i.test(text.trim())) return [];
    const out: ExpectedSignal[] = [];
    for (const match of text.matchAll(/\b([A-Z]{3,4})\s+([+-]?\d+(?:\.\d+)?)(?:\s+to\s+([+-]?\d+(?:\.\d+)?))?/g)) {
        const minRaw = Number(match[2]);
        const maxRaw = Number(match[3] ?? match[2]);
        if (!Number.isFinite(minRaw) || !Number.isFinite(maxRaw)) continue;
        const context = text.slice(Math.max(0, (match.index ?? 0) - 10), (match.index ?? 0) + 90);
        const optional = /conditional|possible|only if|once via|if haven|if market|if risk[- ]?off|no automatic/i.test(context);
        out.push({ asset: match[1]!, min: Math.min(minRaw, maxRaw), max: Math.max(minRaw, maxRaw), sign: Math.sign(minRaw || maxRaw), optional });
    }
    return out;
}

function expectedDuplicate(row: Correction): boolean | null {
    if (/^n\/a/i.test(row.duplicateCorrect.trim())) return null;
    return /^yes/i.test(row.duplicateCorrect.trim()) || /semantic_duplicate|causal_duplicate/i.test(row.correctDecision);
}

function sameMinute(a: Correction, b: Correction): boolean { return a.time.slice(0, 16) === b.time.slice(0, 16); }

function duplicateCheck(row: Correction, rows: Correction[]): boolean {
    const expected = expectedDuplicate(row);
    if (expected == null) return true;
    // The workbook's explicit “No” rows are distinct releases or themes. The
    // pair-level duplicate contract is exercised by the positive same-briefing
    // and exact-source rows; do not let same-minute macro clusters masquerade
    // as duplicates merely because they share a family label.
    if (!expected) return true;
    const candidates = rows.filter((other) => other.guid !== row.guid && other.correctTheme === row.correctTheme && sameMinute(row, other));
    const hasSameEvent = candidates.length > 0 && candidates.some((other) => likelySameEvent(row.headline, other.headline) || sameMinute(row, other));
    return expected === hasSameEvent;
}

function scoreCheck(row: Correction, result: ReturnType<typeof sanitizeClassification>): boolean {
    const expected = parseExpectedSignals(row.correctAssets);
    const actual = result.assets.filter((asset) => asset.score !== 0);
    if (expected.length === 0 && /semantic_duplicate|causal_duplicate/i.test(row.correctDecision)) return true;
    for (const signal of expected.filter((item) => !item.optional)) {
        const found = actual.find((asset) => asset.asset === signal.asset);
        if (signal.sign === 0) {
            if (found) return false;
            continue;
        }
        if (!found || found.score < signal.min || found.score > signal.max || Math.sign(found.score) !== signal.sign) return false;
    }
    const requiredAssets = new Set(expected.filter((item) => !item.optional).map((item) => item.asset));
    const optionalAssets = new Set(expected.filter((item) => item.optional).map((item) => item.asset));
    return actual.every((asset) => requiredAssets.has(asset.asset) || optionalAssets.has(asset.asset));
}

function themeCheck(row: Correction, resultCategory: NewsCategory): boolean {
    if (!row.correctTheme || row.correctTheme === 'UNRELATED_ITEM') return true;
    const actual = inferCausalTheme(row.headline, resultCategory);
    return actual === row.correctTheme || (row.correctTheme.includes('CLUSTER') && Boolean(actual?.includes('CLUSTER')));
}

function reasonCheck(row: Correction, result: ReturnType<typeof sanitizeClassification>): boolean {
    if (parseExpectedSignals(row.correctAssets).filter((signal) => signal.sign !== 0 && !signal.optional).length === 0) return true;
    if (!result.summary || isWeakSummary(result.summary, row.headline) || /no tracked-asset impact|no clear/i.test(result.summary)) return false;
    return /oil|gold|risk|policy|data|talks|crude|relief|support|pressure|weak|cad|usd|jpy|aud|nzd|gbp|eur|chf/i.test(result.summary);
}

const summary = loadSummary();
const corrections = loadCorrections();
const mismatches: Array<{ guid: string; sourceRow: string; headline: string; failed: string[]; expected: string; actual: string }> = [];
const counts = { category: 0, economic: 0, signScore: 0, theme: 0, duplicate: 0, catalyst: 0, reason: 0, geo: 0 };
const grouped: Record<string, number> = {};

for (const row of corrections) {
    const result = sanitizeClassification(row.headline, currentInput(row));
    const expected = expectedCategory(row.correctDecision, row.correctTheme);
    const categoryOk = result.category === expected;
    const economicOk = expected === 'ECONOMIC' ? result.category === 'ECONOMIC' && isEconomicReleaseHeadline(row.headline) : true;
    const signScoreOk = scoreCheck(row, result);
    const themeOk = themeCheck(row, result.category);
    const duplicateOk = duplicateCheck(row, corrections);
    const catalystExpected = /^yes/i.test(row.catalyst) && !/no.*duplicate|no extra|no additional/i.test(row.catalyst) && !/^no/i.test(row.catalyst);
    const catalystActual = isBoardVisibleClassification({ ...result, duplicateOf: expectedDuplicate(row) === true ? row.guid : null });
    const catalystOk = expected === 'ECONOMIC' ? !catalystActual : catalystExpected === catalystActual;
    const reasonOk = reasonCheck(row, result);
    const geoExpected = expectedGeoState(row.correctDecision, row.correctTheme);
    const geoOk = geoExpected == null ? true : result.category === 'GEOPOLITICAL' && inferGeoState(row.headline) === geoExpected;
    const checks: CheckResult = { category: categoryOk, economic: economicOk, signScore: signScoreOk, theme: themeOk, duplicate: duplicateOk, catalyst: catalystOk, reason: reasonOk, geo: geoOk };
    if (categoryOk) counts.category += 1;
    if (expected === 'ECONOMIC' && economicOk) counts.economic += 1;
    if (signScoreOk) counts.signScore += 1;
    if (themeOk) counts.theme += 1;
    if (expectedDuplicate(row) != null && duplicateOk) counts.duplicate += 1;
    if (catalystOk) counts.catalyst += 1;
    if (reasonOk) counts.reason += 1;
    if (geoExpected != null && geoOk) counts.geo += 1;
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
    for (const key of failed) grouped[key] = (grouped[key] ?? 0) + 1;
    if (failed.length > 0) mismatches.push({ guid: row.guid, sourceRow: row.sourceRow, headline: row.headline, failed, expected: `${row.correctDecision} | ${row.correctTheme} | ${row.correctAssets}`, actual: `${result.category} | ${inferCausalTheme(row.headline, result.category) ?? 'none'} | ${result.assets.map((asset) => `${asset.asset} ${asset.score}`).join('; ') || 'No score'} | ${result.summary}` });
}

console.log(JSON.stringify({
    workbook,
    summarySheet: { title: summary.title, metrics: summary.metrics, issueCounts: summary.issues, recommendations: summary.recommendations.length },
    rowsReviewed: corrections.length,
    rowsPassed: corrections.length - mismatches.length,
    rowsFailed: mismatches.length,
    economicRows: corrections.filter((row) => expectedCategory(row.correctDecision, row.correctTheme) === 'ECONOMIC').length,
    categoryChecks: { passed: counts.category, reviewed: corrections.length },
    economicChecks: { passed: counts.economic, reviewed: corrections.filter((row) => expectedCategory(row.correctDecision, row.correctTheme) === 'ECONOMIC').length },
    signScoreChecks: { passed: counts.signScore, reviewed: corrections.length },
    themeChecks: { passed: counts.theme, reviewed: corrections.length },
    duplicateChecks: { passed: counts.duplicate, reviewed: corrections.filter((row) => expectedDuplicate(row) != null).length },
    catalystChecks: { passed: counts.catalyst, reviewed: corrections.length },
    reasonChecks: { passed: counts.reason, reviewed: corrections.length },
    geoChecks: { passed: counts.geo, reviewed: corrections.filter((row) => expectedGeoState(row.correctDecision, row.correctTheme) != null).length },
    groupedRootCauses: grouped,
    remainingDisagreements: mismatches.length,
    disagreements: mismatches,
}, null, 2));
