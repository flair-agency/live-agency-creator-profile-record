import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareEnvironmentTargets, prepareEnvironmentProfilePlan } from '../src/profile-environment.mjs';
import { prepareEnvironmentProfileWrite, applyEnvironmentProfileWrite, verifyEnvironmentProfileWrite } from '../src/profile-execution.mjs';
import { sha256Json } from '../src/profile-plan.mjs';

const NOW = Date.parse('2030-01-02T03:04:00Z'), A = 'recSyntheticA001';

// Same normalized read shape as profile-environment.test.mjs; every operation
// is in memory. The only file is synthetic owner-only avatar input.
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-execution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic-avatar-bytes');
  const avatar = { path: path.join(directory, 'avatar.png'), name: 'avatar.png', mimeType: 'image/png',
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(avatar.path, bytes, { mode: 0o600 });
  const observations = { observedAt: new Date(NOW).toISOString(), rowCount: 1, creators: [{
    creatorRecordId: A, accountKey: 'synthetic.a', observedAt: new Date(NOW).toISOString(), profile: {
      followerCount: 42, followerStatus: 'observed_exact', recentPostCount30d: null, recentPostStatus: 'not_available',
      latestPostAt: null, latestPostStatus: 'not_available', nickname: null, nicknameStatus: 'not_available',
      avatar, avatarStatus: 'observed_exact', featureObservationData: null, featureObservationStatus: 'not_available',
    },
  }] };
  const selection = { environmentId: 'synthetic', environmentKind: 'development', platformId: 'synthetic', generation: 'a'.repeat(64) };
  const state = { creators: [{ creatorRecordId: A, accountKey: 'synthetic.a' }], due: [A], history: [], writes: 0, preparations: 0, calls: [] };
  const row = () => ({ valid: true, recordId: 'recSyntheticHistory001', creatorRecordId: A, timestampMs: NOW,
    followerCount: 42, recentPostCount30d: null, latestPostAtMs: null, nickname: null, featureObservationJson: null, avatarHashes: [avatar.sha256] });
  const access = { selection, async invoke(request) {
    const input = request.input;
    state.calls.push(structuredClone(input));
    let output;
    if (input.operation === 'read-creators') output = { creators: state.creators,
      ...(input.includeDueMembership ? { dueCreatorRecordIds: state.due } : {}), timestampMode: 'observed-at' };
    else if (input.operation === 'read-profile-history') {
      assert.deepEqual(input.creatorRecordIds, [A]);
      output = { profileHistory: state.history, timestampMode: 'observed-at' };
    } else if (input.operation === 'prepare') {
      state.preparations++;
      const prepared = { selection, planSha256: input.planSha256, input, inputSha256: sha256Json(input),
        counts: { create: 1, attach: 1, appendExisting: 0 } };
      output = { ...prepared, intentSha256: sha256Json(prepared) };
    } else if (input.operation === 'apply') {
      state.writes++;
      state.history = [row()];
      state.due = [];
      output = { createdRecordIds: ['recSyntheticHistory001'], createCount: 1, attachCount: 1, appendExistingCount: 0 };
    } else throw Error('unexpected operation');
    return { selection, result: { requestId: request.requestId, capability: request.capability,
      version: request.version, context: request.context, status: 'done', output: structuredClone(output) } };
  } };
  const targets = await prepareEnvironmentTargets({ access, nowMs: NOW });
  const planningReceipt = await prepareEnvironmentProfilePlan({ access, targets, observations, nowMs: NOW });
  const review = await prepareEnvironmentProfileWrite({ access, planningReceipt });
  const approval = { planSha256: planningReceipt.plan.planSha256, createCount: 1, attachCount: 1, reference: 'synthetic-only' };
  const apply = () => applyEnvironmentProfileWrite({ access, review, approval,
    authorize: async () => true, onEvent: async () => {}, sleep: async () => {} });
  return { access, state, row, targets, observations, planningReceipt, review, apply };
}

test('post-write and standalone readback verify original due targets after successful effects remove due membership', async t => {
  const f = await fixture(t);
  const originalReview = structuredClone(f.review);
  const result = await f.apply();
  assert.equal(result.status, 'success');
  assert.equal(result.businessWorkflowVerified, true);
  assert.equal(result.profileVerifiedCount, 1);
  assert.equal(f.state.writes, 1);
  assert.deepEqual(f.state.due, []);
  for (const due of [[], [A]]) {
    f.state.due = due;
    f.state.calls = [];
    const recovered = await verifyEnvironmentProfileWrite({ access: f.access, review: f.review });
    assert.equal(recovered.status, 'verified');
    assert.equal(recovered.businessWorkflowVerified, true);
    assert.deepEqual(recovered.planningReceipt.plan.inputs.manifest, f.targets.manifest);
    assert.deepEqual(recovered.planningReceipt.plan.operations.targetIssues, []);
    assert.deepEqual(f.state.calls, [{ operation: 'read-creators', includeDueMembership: false },
      { operation: 'read-profile-history', creatorRecordIds: [A] }]);
  }
  assert.deepEqual(f.review, originalReview);
  assert.equal(f.state.writes, 1);
});

test('fresh due membership and plan equality still gate preparation and apply', async t => {
  const f = await fixture(t);
  f.state.due = [];
  // Caller-supplied phase flags cannot weaken a public planning operation.
  const current = await prepareEnvironmentProfilePlan({ access: f.access, targets: f.targets,
    observations: f.observations, nowMs: NOW, planning: false, requireDueMembership: false });
  assert.deepEqual(current.plan.operations.targetIssues, [{ creatorRecordId: A, reason: 'not_in_due_view' }]);
  await assert.rejects(prepareEnvironmentProfileWrite({ access: f.access, planningReceipt: f.planningReceipt }), /business plan changed/);
  await assert.rejects(f.apply(), /business plan changed/);
  assert.equal(f.state.preparations, 1);
  assert.equal(f.state.writes, 0);
  f.state.due = [A];
  f.state.history = [f.row()];
  await assert.rejects(f.apply(), /business plan changed/);
  assert.equal(f.state.writes, 0);
});

test('readback retains identity, scope, stored-effect and review checks outside the due view', async t => {
  const f = await fixture(t);
  f.state.due = [];
  const cases = [
    ['account changed', () => { f.state.creators[0].accountKey = 'synthetic.changed'; }, 'creator_account_changed'],
    ['account duplicated', () => { f.state.creators.push({ creatorRecordId: 'recSyntheticB001', accountKey: 'synthetic.a' }); }, 'creator_account_not_unique'],
    ['creator missing', () => { f.state.creators = []; }, 'creator_record_missing'],
    ['history missing', () => { f.state.history = []; }, null, 1, 0],
    ['stored value differs', () => { f.state.history[0].followerCount = 43; }, null, 1, 0],
    ['avatar differs', () => { f.state.history[0].avatarHashes = ['b'.repeat(64)]; }, null, 1, 0],
    ['avatar missing', () => { f.state.history[0].avatarHashes = []; }, null, 0, 1],
  ];
  for (const [name, alter, reason, creates = 0, append = 0] of cases) {
    f.state.creators = [{ creatorRecordId: A, accountKey: 'synthetic.a' }];
    f.state.history = [f.row()];
    alter();
    const result = await verifyEnvironmentProfileWrite({ access: f.access, review: f.review });
    assert.equal(result.status, 'unresolved', name);
    assert.equal(result.businessWorkflowVerified, false, name);
    assert.deepEqual(result.planningReceipt.plan.operations.targetIssues,
      reason ? [{ creatorRecordId: A, reason }] : [], name);
    assert.equal(result.planningReceipt.plan.summary.profileCreateCount, creates, name);
    assert.equal(result.planningReceipt.plan.summary.profileAttachExistingCount, append, name);
  }
  f.state.history = [{ ...f.row(), creatorRecordId: 'recSyntheticB001' }];
  await assert.rejects(verifyEnvironmentProfileWrite({ access: f.access, review: f.review }), /selected scope or row contract/);
  f.state.calls = [];
  f.access.selection.generation = 'b'.repeat(64);
  await assert.rejects(verifyEnvironmentProfileWrite({ access: f.access, review: f.review }), /environment selection changed/);
  f.access.selection.generation = 'a'.repeat(64);
  const changedReview = structuredClone(f.review);
  changedReview.planningReceipt.plan.inputs.manifest.targetMode = 'selected';
  await assert.rejects(verifyEnvironmentProfileWrite({ access: f.access, review: changedReview }), /review hash does not match/);
  assert.deepEqual(f.state.calls, []);
  assert.equal(f.state.writes, 0);
});
