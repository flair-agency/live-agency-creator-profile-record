#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

if (import.meta.url === `file://${process.argv[1]}`) {
  try { console.log(JSON.stringify(await runHostComparison(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ status: 'stopped', message: error.message })); process.exitCode = 2; }
}
