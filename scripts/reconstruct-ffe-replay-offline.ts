#!/usr/bin/env node
/**
 * Cached/offline Catalyst reconstruction from completed replay artifacts (no AI calls).
 * Usage: node --import tsx/esm scripts/reconstruct-ffe-replay-offline.ts nano-r14
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reconstructFfeCatalystBoard, type CatalystDriverInput } from '../src/services/ffeCatalystReconstruction.service.js';

const root = path.resolve(process.cwd(), '..');
const tag = process.argv[2] ?? 'nano-r14';
const replayPath = path.join(root, 'replay-fixtures', `aug18-financialjuice-client-contract-replay-${tag}.json`);
const reconPath = path.join(root, 'replay-fixtures', `aug18-financialjuice-driver-reconstruction-${tag}.json`);

type CheckpointDriver = {
    eventId: string;
    themeId: string | null;
    contractFamily: string | null;
    headline: string;
    eventType: string | null;
    relation: string;
    status: string;
    valid: boolean;
    independent: boolean;
    catalystEligible: boolean;
    contributions: CatalystDriverInput['contributions'];
    supportingGuids: string[];
    geoState?: string | null;
    fundamentalCause?: string | null;
};

type ReplayRow = {
    guid: string;
    headline: string;
    category?: string | null;
    eventRelation?: string | null;
    resolvedRelation?: string | null;
    actual?: string | null;
    previous?: string | null;
    geoState?: string | null;
};

function load(tagName: string) {
    const replay = JSON.parse(fs.readFileSync(path.join(root, 'replay-fixtures', `aug18-financialjuice-client-contract-replay-${tagName}.json`), 'utf8')) as { rows: ReplayRow[] };
    const recon = JSON.parse(fs.readFileSync(path.join(root, 'replay-fixtures', `aug18-financialjuice-driver-reconstruction-${tagName}.json`), 'utf8')) as {
        finalGeo: { dominantTheme: string | null; score: number; band: string; eventCount: number; escalationThemes: string[]; deEscalationThemes: string[] };
        checkpoints: Array<{ activeDrivers: CheckpointDriver[] }>;
    };
    const rowsByGuid = new Map(replay.rows.map((row) => [row.guid, row]));
    const active = recon.checkpoints.at(-1)?.activeDrivers ?? [];
    const drivers: CatalystDriverInput[] = active.map((driver) => {
        const anchor = rowsByGuid.get(driver.supportingGuids.at(-1) ?? '') ?? rowsByGuid.get(driver.supportingGuids[0] ?? '');
        return {
            eventId: driver.eventId,
            themeId: driver.themeId,
            contractFamily: driver.contractFamily,
            status: driver.status,
            valid: driver.valid,
            independent: driver.independent,
            catalystEligible: driver.catalystEligible,
            contributions: driver.contributions,
            supportingGuids: driver.supportingGuids,
            headline: driver.headline,
            eventType: driver.eventType,
            geoState: driver.geoState ?? anchor?.geoState ?? null,
            eventRelation: driver.relation,
            category: anchor?.category ?? null,
            actual: anchor?.actual ?? null,
            previous: anchor?.previous ?? null,
        };
    });
    return { drivers, geo: recon.finalGeo, replayPath: path.join(root, 'replay-fixtures', `aug18-financialjuice-client-contract-replay-${tagName}.json`) };
}

function report(tagName: string) {
    const { drivers, geo, replayPath: artifactPath } = load(tagName);
    const { board, collapsed, yieldDriver, geoPremium } = reconstructFfeCatalystBoard(drivers, geo);
    const invariants = spawnSync('npm', ['run', 'test:ffe-replay-invariants', '--', artifactPath], {
        cwd: process.cwd(),
        encoding: 'utf8',
    });
    return {
        tag: tagName,
        board,
        collapsed: collapsed.map((driver) => ({
            key: driver.key,
            themeId: driver.themeId,
            representativeEventId: driver.representativeEventId,
            memberEventIds: driver.memberEventIds,
            contributions: driver.contributions,
            supportingGuids: driver.supportingGuids ?? [],
            provenanceReason: driver.provenanceReason ?? null,
        })),
        yieldDriver: yieldDriver ? {
            active: true,
            direction: yieldDriver.direction,
            reason: yieldDriver.reason,
            supportingEventIds: yieldDriver.supportingEventIds,
            supportingGuids: yieldDriver.supportingGuids,
        } : { active: false, reason: 'No qualifying canonical US yield/real-yield/Fed repricing evidence' },
        geoPremium: geoPremium ? {
            active: true,
            provenance: geoPremium.provenance,
            contributions: geoPremium.contributions,
        } : { active: false },
        invariants: {
            exitCode: invariants.status ?? 1,
            stdout: invariants.stdout?.trim() ?? '',
            stderr: invariants.stderr?.trim() ?? '',
        },
    };
}

const tags = process.argv.length > 3 ? process.argv.slice(2) : [tag];
const results = tags.map(report);
console.log(JSON.stringify({ reconstructedAt: new Date().toISOString(), results }, null, 2));
