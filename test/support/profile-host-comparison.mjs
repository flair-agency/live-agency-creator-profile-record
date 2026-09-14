#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PROFILE_TARGET_INPUT_KIND, sha256Json } from '../../src/profile-plan.mjs';

const EXPECTED_ROWS_SHA256 = '9ab5c30be2db304bd167d72a082b739933f1ef2b5eb5f0b15d7b9f38931d4976';
const BATCH_SIZE = 5;
const rows = Array.from({ length: 20 }, (_, index) => ({
  creatorRecordId: `recSynthetic${String(index).padStart(3, '0')}`,
  accountKey: `synthetic.${index}`,
}));
const fixture = { version: 1, selection: { generation: 'a'.repeat(64) }, manifest: {
  version: 2, inputKind: PROFILE_TARGET_INPUT_KIND, generatedAt: '2030-01-02T03:04:00Z',
  targetMode: 'selected', rowCount: rows.length, rows, rowsSha256: EXPECTED_ROWS_SHA256,
} };

function check(ok, message) { if (!ok) throw new TypeError(message); }
function stateFile(directory) { return path.join(path.resolve(directory), 'state.json'); }
async function atomicJson(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
async function readState(directory) { return JSON.parse(await readFile(stateFile(directory), 'utf8')); }
function validate(state) {
  check(state.version === 1 && state.fixtureRowsSha256 === EXPECTED_ROWS_SHA256, 'unexpected fixture');
  check(sha256Json(fixture.manifest.rows) === EXPECTED_ROWS_SHA256, 'fixture hash mismatch');
  check(Array.isArray(state.saved) && new Set(state.saved.map(row => row.creatorRecordId)).size === state.saved.length, 'duplicate saved target');
  check(state.saved.every((row, index) => row.creatorRecordId === rows[index].creatorRecordId), 'target order changed');
}
function summary(state) {
  validate(state);
  return { fixtureRowsSha256: state.fixtureRowsSha256, batchSize: BATCH_SIZE, batchesCompleted: state.batchesCompleted,
    savedCount: state.saved.length, pendingCount: rows.length - state.saved.length,
    completedIds: state.saved.map(row => row.creatorRecordId), terminal: state.saved.length === rows.length ? 'complete' : 'continuation_required' };
}

export async function runHostComparison(argv) {
  const [operation, directory, batch] = argv;
  check(directory && ['init', 'batch', 'status'].includes(operation), 'usage: init|status DIRECTORY; batch DIRECTORY 0..3');
  if (operation === 'init') {
    check(sha256Json(fixture.manifest.rows) === EXPECTED_ROWS_SHA256, 'fixture hash mismatch');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const state = { version: 1, fixtureRowsSha256: EXPECTED_ROWS_SHA256, batchesCompleted: 0, saved: [] };
    await atomicJson(stateFile(directory), state);
    return summary(state);
  }
  const state = await readState(directory);
  if (operation === 'status') return summary(state);
  const batchNumber = Number(batch);
  check(Number.isInteger(batchNumber) && batchNumber >= 0 && batchNumber < 4, 'batch must be 0..3');
  validate(state);
  check(batchNumber === state.batchesCompleted, 'batches must run in order once');
  const start = batchNumber * BATCH_SIZE;
  state.saved.push(...rows.slice(start, start + BATCH_SIZE));
  state.batchesCompleted++;
  await atomicJson(stateFile(directory), state);
  return summary(state);
}

const STAGES = new Set(['S1', 'S2', 'S3', 'S4']);
const shortDelay = () => new Promise(resolve => setTimeout(resolve, 25));
const assetFor = row => Buffer.from(`synthetic-asset:${row.creatorRecordId}\n`.repeat(128));
const digest = value => createHash('sha256').update(value).digest('hex');
const longHistory = 'synthetic prior progress: no external source, no production data. '.repeat(180);

function stageSummary(state, extra = {}) {
  check(state.version === 1 && state.fixtureRowsSha256 === EXPECTED_ROWS_SHA256, 'unexpected fixture');
  check(sha256Json(fixture.manifest.rows) === EXPECTED_ROWS_SHA256, 'fixture hash mismatch');
  check(new Set(state.saved.map(row => row.creatorRecordId)).size === state.saved.length, 'duplicate saved target');
  const completedIds = state.saved.map(row => row.creatorRecordId);
  return { stage: state.stage, fixtureRowsSha256: state.fixtureRowsSha256, savedCount: completedIds.length,
    partialCount: state.partialIds.length, pendingCount: rows.length - completedIds.length,
    completedIds, stepCount: state.stepCount, terminal: completedIds.length === rows.length ? 'complete' : 'continuation_required', ...extra };
}

export async function runHostStage(argv) {
  const [operation, directory, stage] = argv;
  check(directory && ['stage-init', 'stage-step', 'stage-status'].includes(operation), 'usage: stage-init DIRECTORY S1..S4; stage-step|stage-status DIRECTORY');
  if (operation === 'stage-init') {
    check(STAGES.has(stage), 'stage must be S1..S4');
    check(sha256Json(fixture.manifest.rows) === EXPECTED_ROWS_SHA256, 'fixture hash mismatch');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const state = { version: 1, fixtureRowsSha256: EXPECTED_ROWS_SHA256, stage, saved: [], partialIds: [], stepCount: 0 };
    await atomicJson(stateFile(directory), state);
    return stageSummary(state, stage === 'S4' ? { syntheticPriorHistory: longHistory } : {});
  }
  const state = await readState(directory);
  check(STAGES.has(state.stage) && Array.isArray(state.partialIds) && Number.isInteger(state.stepCount), 'invalid staged state');
  if (operation === 'stage-status') return stageSummary(state);
  check(state.version === 1 && state.fixtureRowsSha256 === EXPECTED_ROWS_SHA256, 'unexpected fixture');
  check(new Set(state.saved.map(row => row.creatorRecordId)).size === state.saved.length, 'duplicate saved target');
  const completed = new Set(state.saved.map(row => row.creatorRecordId));
  // An S2+ partial target is intentionally retried only after unaffected targets.
  const target = rows.find(row => !completed.has(row.creatorRecordId) && !state.partialIds.includes(row.creatorRecordId))
    ?? rows.find(row => !completed.has(row.creatorRecordId));
  if (!target) return stageSummary(state);
  state.stepCount++;
  const response = { targetId: target.creatorRecordId, transition: [] };
  if (state.stage === 'S4') {
    response.transition.push('navigate', 'wait');
    await shortDelay();
    response.transition.push('ready');
  } else if (state.stage === 'S1') await shortDelay();
  if ((state.stage === 'S2' || state.stage === 'S3' || state.stage === 'S4')
    && target.creatorRecordId === rows[5].creatorRecordId && !state.partialIds.includes(target.creatorRecordId)) {
    state.partialIds.push(target.creatorRecordId);
    response.result = 'partial';
    response.readback = { savedCount: state.saved.length, partialCount: state.partialIds.length };
    await atomicJson(stateFile(directory), state);
    return stageSummary(state, response);
  }
  state.saved.push(target);
  response.result = 'saved';
  if (state.stage === 'S3' || state.stage === 'S4') {
    const asset = assetFor(target);
    response.asset = { size: asset.length, sha256: digest(asset) };
    response.syntheticPayload = `${target.accountKey}:`.padEnd(2048, 'x');
  }
  response.readback = { savedCount: state.saved.length, partialCount: state.partialIds.length };
  if (state.stage === 'S4') response.transition.push('extract', 'readback');
  await atomicJson(stateFile(directory), state);
  return stageSummary(state, response);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const argv = process.argv.slice(2);
    const result = argv[0]?.startsWith('stage-') ? await runHostStage(argv) : await runHostComparison(argv);
    console.log(JSON.stringify(result));
  }
  catch (error) { console.error(JSON.stringify({ status: 'stopped', message: error.message })); process.exitCode = 2; }
}
