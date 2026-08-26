#!/usr/bin/env node
/**
 * Offline parser for August 19 FinancialJuice snapshot (holdout input normalization).
 * No AI calls. Filters FXStreet syndicated rows and promotional junk.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    fingerprintFinancialJuiceSourceUnit,
    retainFinancialJuiceSnapshotUnits,
} from '../src/services/ffeEvidencePreprocess.service.js';

type ParsedRow = {
    time: string;
    source: 'FinancialJuice';
    guid: string;
    headline: string;
    body?: string;
    supporting_lines?: string[];
    source_unit_hash?: string;
    actual?: string;
    forecast?: string;
    previous?: string;
};

const root = path.resolve(process.cwd(), '..');
const rawPath = path.join(root, 'replay-fixtures', 'aug19-financialjuice-snapshot-raw.txt');
const outPath = path.join(root, 'replay-fixtures', 'financialjuice-2026-08-19-ai-replay.json');
const statsPath = path.join(root, 'replay-fixtures', 'aug19-financialjuice-parse-stats.json');

function toEpoch(value: string): number {
    return Date.parse(value.replace(/^(\d{2})\/(\d{2})\/(\d{4}),\s+(\d{2}):(\d{2})$/, '$3-$2-$1T$4:$5:00+04:00'));
}

const raw = fs.readFileSync(rawPath, 'utf8');
const { totalParsed, fxstreetExcluded, junkExcluded, retained: units } = retainFinancialJuiceSnapshotUnits(raw);

const retained: ParsedRow[] = units
    .sort((a, b) => toEpoch(a.time) - toEpoch(b.time))
    .map((unit, index) => {
        const row: ParsedRow = {
            time: unit.time,
            source: 'FinancialJuice',
            guid: `aug19fj${String(index + 1).padStart(5, '0')}`,
            headline: unit.headline,
            body: unit.body || undefined,
            supporting_lines: unit.supporting_lines.length ? unit.supporting_lines : undefined,
        };
        if (unit.actual !== undefined) row.actual = unit.actual;
        if (unit.forecast !== undefined) row.forecast = unit.forecast;
        if (unit.previous !== undefined) row.previous = unit.previous;
        row.source_unit_hash = fingerprintFinancialJuiceSourceUnit(row);
        return row;
    });

if (!retained.length) throw new Error('No FinancialJuice rows retained');
if (new Set(retained.map((row) => row.guid)).size !== retained.length) throw new Error('Duplicate GUIDs');
for (let i = 1; i < retained.length; i += 1) {
    if (toEpoch(retained[i - 1]!.time) > toEpoch(retained[i]!.time)) throw new Error(`Chronology break at ${retained[i]!.guid}`);
}

const stats = {
    parsedAt: new Date().toISOString(),
    totalParsedRows: totalParsed,
    financialJuiceNativeRetained: retained.length,
    fxstreetRowsExcluded: fxstreetExcluded,
    junkPromotionalRowsExcluded: junkExcluded,
    firstRetainedTimestamp: retained[0]!.time,
    finalRetainedTimestamp: retained.at(-1)!.time,
    outputFixture: outPath,
};

fs.writeFileSync(outPath, JSON.stringify(retained, null, 2));
fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 2));
