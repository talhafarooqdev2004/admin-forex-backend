#!/usr/bin/env node
/**
 * Re-ingest an existing successful FFE ChatGPT artifact (no ChatGPT, no RSS).
 *
 * Usage:
 *   node --import tsx/esm scripts/reingest-ffe-artifact.mjs [run-dir]
 *   FFE_REINGEST_TARGET=production node --import tsx/esm scripts/reingest-ffe-artifact.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendRoot, '..');

dotenv.config({ path: path.join(backendRoot, '.env') });
dotenv.config({ path: path.join(repoRoot, 'forex-scraping/.env') });

const DEFAULT_RUN_DIR = path.join(
    repoRoot,
    'forex-scraping/artifacts/ffe-daily-runs/ffe-2026-08-28T11-11-21-255Z',
);

const runDir = path.resolve(process.argv[2] || DEFAULT_RUN_DIR);
const chatgptPath = path.join(runDir, 'chatgpt-result.json');
const pipelinePath = path.join(runDir, 'pipeline-result.json');

if (!fs.existsSync(chatgptPath) || !fs.existsSync(pipelinePath)) {
    console.error(JSON.stringify({ ok: false, error: `Missing artifact files in ${runDir}` }, null, 2));
    process.exit(1);
}

const captured = JSON.parse(fs.readFileSync(chatgptPath, 'utf8'));
const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf8'));
const snapshot = pipeline.snapshot;

const payload = {
    run_id: `${snapshot.run_id}-reingest-${Date.now()}`,
    business_day: snapshot.business_day,
    input_hash: snapshot.input_hash,
    prompt_hash: snapshot.prompt_hash,
    prompt_version: snapshot.prompt_version,
    retained_count: snapshot.retained_count,
    financialjuice_count: snapshot.financialjuice_count,
    fxstreet_count: snapshot.fxstreet_count,
    cutoff: snapshot.cutoff,
    source_units: snapshot.source_units,
    pipeline_status: 'success',
    force_reingest: true,
    chatgpt: {
        raw_response: captured.raw_response,
        response_hash: captured.response_hash,
        response_length: captured.response_length,
        parent_conversation_id: captured.parent_conversation_id,
        branch_conversation_id: captured.branch_conversation_id,
        response_wait_ms: captured.response_wait_ms,
        submitted_at: captured.submitted_at,
        completed_at: captured.completed_at,
        screenshot_path: captured.screenshot_path,
    },
};

const target = String(process.env.FFE_REINGEST_TARGET || 'local').toLowerCase();

async function reingestLocal() {
    const { ingestFfePipelineResult } = await import('../src/services/ffePipelineIngest.service.ts');
    return ingestFfePipelineResult(payload);
}

async function reingestProduction() {
    const baseUrl = String(
        process.env.ADMIN_BACKEND_URL
        || process.env.PRODUCTION_ADMIN_BACKEND_URL
        || 'https://fxfundamentaltrend.com',
    ).replace(/\/$/, '');
    const webhookPath = process.env.FFE_DAILY_PIPELINE_WEBHOOK_PATH || '/api/v1/webhooks/ffe/daily-pipeline';
    const secret = String(process.env.SCRAPER_WEBHOOK_SECRET || '').trim();
    const response = await fetch(`${baseUrl}${webhookPath}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'x-scraper-webhook-key': secret } : {}),
        },
        body: JSON.stringify(payload),
    });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = { raw: text };
    }
    if (!response.ok) {
        throw new Error(parsed?.message || parsed?.error || text || `HTTP ${response.status}`);
    }
    return parsed?.data ?? parsed;
}

const result = target === 'production'
    ? await reingestProduction()
    : await reingestLocal();

console.log(JSON.stringify({
    ok: true,
    target,
    run_dir: runDir,
    business_day: snapshot.business_day,
    input_hash: snapshot.input_hash,
    result,
}, null, 2));
