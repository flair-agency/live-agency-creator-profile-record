import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256Json, PROFILE_TARGET_INPUT_KIND, buildProfileSyncPlanFromHistory } from '../src/profile-plan.mjs';
import { createProfileProgress, recordProfileProgress, inspectProfileProgress, assembleProfileObservations } from '../src/profile-progress.mjs';

const at = '2030-01-02T03:04:00Z';
const rows = [{ creatorRecordId: 'recSyntheticA001', accountKey: 'synthetic.a' }, { creatorRecordId: 'recSyntheticB001', accountKey: 'synthetic.b' }];
const targets = { version: 1, selection: { generation: 'a'.repeat(64) }, manifest: { version: 2, inputKind: PROFILE_TARGET_INPUT_KIND, generatedAt: at, targetMode: 'selected', rowCount: 2, rows, rowsSha256: sha256Json(rows) } };
const complete = row => ({ ...row, status: 'completed', evidenceRefs: ['private:synthetic-evidence'], observation: { ...row, observedAt: at, profile: { followerCount: 42, followerStatus: 'observed_exact', recentPostCount30d: null, recentPostStatus: 'not_available', latestPostAt: null, latestPostStatus: 'not_available', nickname: null, nicknameStatus: 'not_available', avatar: null, avatarStatus: 'not_available', featureObservationData: null, featureObservationStatus: 'not_available' } } });

test('restart resumes only unfinished targets and duplicate attempts do not inflate counts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'profile-progress-'));
  const files = ['targets.json', 'progress.json', 'result.json', 'observations.json'].map(name => path.join(dir, name));
  const call = (op, extra = []) => spawnSync(process.execPath, ['scripts/profile_progress.mjs', op, files[0], files[1], ...extra], { encoding: 'utf8' });
  try {
    await writeFile(files[0], JSON.stringify(targets), { mode: 0o600 });
    assert.equal(call('init').status, 0);
    await writeFile(files[2], JSON.stringify(complete(rows[0])), { mode: 0o600 });
    assert.equal(call('record', [files[2]]).status, 0);
    // Every invocation is a fresh process: no REPL state is available.
    assert.equal(call('record', [files[2]]).status, 0);
    const resumed = JSON.parse(call('status').stdout);
    assert.deepEqual(resumed.counts, { total: 2, completed: 1, partial: 0, blocked: 0, pending: 1 });
    assert.deepEqual(resumed.remaining, [rows[1]]);
    assert.equal(call('assemble', [files[3]]).status, 2);
    // Simulate interruption during the atomic writer before rename: an orphan
    // temporary file cannot be mistaken for the committed checkpoint.
    await writeFile(`${files[1]}.interrupted.tmp`, '{', { mode: 0o600 });
    await writeFile(`${files[1]}.lock`, '', { mode: 0o600 });
    assert.equal(call('record', [files[2]]).status, 2);
    assert.equal(JSON.parse(await readFile(files[1])).results.length, 1);
    await rm(`${files[1]}.lock`);
    await writeFile(files[2], JSON.stringify(complete(rows[1])), { mode: 0o600 });
    assert.equal(call('record', [files[2]]).status, 0);
    assert.equal(call('assemble', [files[3]]).status, 0);
    assert.deepEqual(JSON.parse(await readFile(files[3])).creators.map(row => row.creatorRecordId), rows.map(row => row.creatorRecordId));
    assert.equal(call('init').status, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('partial and blocked states retain distinct counts and cannot form a plan input', () => {
  let progress = createProfileProgress(targets);
  for (const [index, status] of ['partial', 'blocked'].entries()) progress = recordProfileProgress(targets, progress, { ...rows[index], status, reason: 'synthetic incomplete evidence', evidenceRefs: [] });
  assert.deepEqual(inspectProfileProgress(targets, progress).counts, { total: 2, completed: 0, partial: 1, blocked: 1, pending: 0 });
  assert.throws(() => assembleProfileObservations(targets, progress));
  progress = recordProfileProgress(targets, progress, complete(rows[0]));
  assert.equal(inspectProfileProgress(targets, progress).counts.completed, 1);
});

test('identity, scope drift, duplicate records, bare images and completed rewrites are rejected', () => {
  const empty = createProfileProgress(targets);
  assert.throws(() => recordProfileProgress(targets, empty, { ...rows[0], status: 'completed', evidenceRefs: ['/private/avatar.png'] }));
  assert.throws(() => recordProfileProgress(targets, empty, { ...complete(rows[0]), accountKey: rows[1].accountKey }));
  assert.throws(() => recordProfileProgress(targets, empty, { ...complete(rows[0]), observation: complete(rows[1]).observation }));
  const progress = recordProfileProgress(targets, empty, complete(rows[0]));
  assert.throws(() => inspectProfileProgress({ ...targets, selection: { generation: 'b'.repeat(64) } }, progress));
  assert.throws(() => inspectProfileProgress(targets, { ...progress, results: [...progress.results, ...progress.results] }));
  assert.throws(() => recordProfileProgress(targets, progress, { ...complete(rows[0]), evidenceRefs: ['changed'] }));
});

test('terminal observations preserve existing planner treatment of failed fields and unavailable profiles', () => {
  const usable = complete(rows[0]);
  usable.observation.profile.avatarStatus = 'authentication_required';
  const unavailable = complete(rows[1]);
  unavailable.observation.profile.followerCount = null;
  unavailable.observation.profile.followerStatus = 'not_available';
  let progress = createProfileProgress(targets);
  for (const result of [usable, unavailable]) progress = recordProfileProgress(targets, progress, result);
  const assembled = assembleProfileObservations(targets, progress);
  const args = { manifest: targets.manifest, profileHistory: [], nowMs: Date.parse(at) };
  const plan = buildProfileSyncPlanFromHistory({ ...args, observations: assembled });
  const direct = buildProfileSyncPlanFromHistory({ ...args, observations: { observedAt: at, rowCount: 2, creators: [usable.observation, unavailable.observation] } });
  assert.deepEqual(plan, direct);
  assert.equal(plan.summary.profileCreateCount, 1);
  assert.equal(plan.summary.profileUnavailableCount, 1);
  assert.equal(plan.summary.targetIssueCount, 0);
  assert.equal(inspectProfileProgress(targets, progress).counts.completed, 2);
});
