import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareEnvironmentTargets, prepareEnvironmentProfilePlan } from '../src/profile-environment.mjs';
import { prepareEnvironmentProfileWrite, applyEnvironmentProfileWrite,
  verifyEnvironmentProfileWrite } from '../src/profile-execution.mjs';
import { sha256Json } from '../src/profile-plan.mjs';

// Tool names and effect order model a candidate Plugin composition. Arguments,
// replies and authorization are synthetic; this does not exercise the Codex host,
// official MCP schemas, a real Lark API, or actual owner approval.
const NOW = Date.parse('2030-01-02T03:04:00Z');
const CREATOR = 'recSyntheticPilotCreator001';
const HISTORY = 'recSyntheticPilotHistory001';
const MCP_SEARCH = 'bitable_v1_appTableRecord_search';
const MCP_CREATE = 'bitable_v1_appTableRecord_create';
// This is a synthetic-only candidate adapter, not a tool in Lark MCP 0.5.1.
const AVATAR_UPLOAD = 'pilot.synthetic.avatar.uploadBeforeCreate';

async function pilot(t, { loseCreateResponse = false, failUpload = false, avatarPath } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-plugin-pilot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic-profile-avatar');
  const avatar = { path: avatarPath ?? path.join(directory, 'avatar.png'), name: 'avatar.png',
    mimeType: 'image/png', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(avatar.path, bytes, { mode: 0o600 });
  const selection = { environmentId: 'synthetic-pilot', environmentKind: 'development',
    platformId: 'synthetic', generation: 'a'.repeat(64) };
  const state = { due: [CREATOR], history: [], toolCalls: [], events: [], uploads: new Map() };
  const observations = { observedAt: new Date(NOW).toISOString(), rowCount: 1, creators: [{
    creatorRecordId: CREATOR, accountKey: 'synthetic.pilot', observedAt: new Date(NOW).toISOString(),
    profile: { followerCount: 42, followerStatus: 'observed_exact',
      recentPostCount30d: null, recentPostStatus: 'not_available',
      latestPostAt: null, latestPostStatus: 'not_available',
      nickname: null, nicknameStatus: 'not_available', avatar, avatarStatus: 'observed_exact',
      featureObservationData: null, featureObservationStatus: 'not_available' },
  }] };

  async function callTool(name, args) {
    state.toolCalls.push({ name, args: structuredClone(args) });
    if (name === MCP_SEARCH) {
      if (args.table === 'creators') return [{ record_id: CREATOR, fields: { account: 'synthetic.pilot' } }];
      if (args.table === 'history') return state.history.map(row => structuredClone(row));
    }
    if (name === AVATAR_UPLOAD) {
      if (failUpload) throw Object.assign(new Error('synthetic upload failure'), { code: 'UPLOAD_FAILED' });
      const file = await readFile(args.path);
      assert.equal(file.length, args.size);
      assert.equal(createHash('sha256').update(file).digest('hex'), args.sha256);
      const token = 'synthetic-avatar-token';
      state.uploads.set(token, args.sha256);
      return { file_token: token };
    }
    if (name === MCP_CREATE) {
      assert.equal(args.table, 'history');
      const token = args.fields.avatar[0].file_token;
      assert.equal(state.uploads.get(token), avatar.sha256, 'create must use the uploaded avatar');
      assert.equal(state.history.length, 0, 'uncertain creates must not be replayed');
      state.history.push({ record_id: HISTORY, fields: structuredClone(args.fields) });
      state.due = [];
      if (loseCreateResponse) throw Object.assign(new Error('synthetic response lost'), { code: 'RESPONSE_LOST' });
      return { record_id: HISTORY };
    }
    throw new Error(`unexpected synthetic tool: ${name}`);
  }

  const access = { selection, async invoke(request, execution) {
    const { input } = request;
    let output;
    if (input.operation === 'read-creators') {
      const creators = await callTool(MCP_SEARCH, { table: 'creators' });
      output = { creators: creators.map(row => ({ creatorRecordId: row.record_id,
        accountKey: row.fields.account })), timestampMode: 'observed-at',
      ...(input.includeDueMembership ? { dueCreatorRecordIds: state.due } : {}) };
    } else if (input.operation === 'read-profile-history') {
      assert.deepEqual(input.creatorRecordIds, [CREATOR]);
      const rows = await callTool(MCP_SEARCH, { table: 'history', creator: CREATOR });
      output = { profileHistory: rows.map(row => ({ valid: true, recordId: row.record_id,
        creatorRecordId: row.fields.creator, timestampMs: row.fields.observedAt,
        followerCount: row.fields.followers, recentPostCount30d: null, latestPostAtMs: null,
        nickname: null, featureObservationJson: null,
        avatarHashes: row.fields.avatar.map(item => state.uploads.get(item.file_token)) })),
      timestampMode: 'observed-at' };
    } else if (input.operation === 'prepare') {
      const prepared = { selection, planSha256: input.planSha256, input,
        inputSha256: sha256Json(input), counts: { create: 1, attach: 1, appendExisting: 0 } };
      output = { ...prepared, intentSha256: sha256Json(prepared) };
    } else if (input.operation === 'apply') {
      assert.equal(await execution.authorizeIntent(input.prepared), true);
      const create = input.prepared.input.creates[0];
      const uploaded = await callTool(AVATAR_UPLOAD, create.avatar);
      await execution.onEvent({ stage: 'avatar-uploaded', token: uploaded.file_token });
      const created = await callTool(MCP_CREATE, { table: 'history', fields: {
        creator: CREATOR, observedAt: NOW, followers: 42, avatar: [uploaded],
      } });
      output = { createdRecordIds: [created.record_id], createCount: 1, attachCount: 1,
        appendExistingCount: 0 };
    } else throw new Error(`unexpected operation: ${input.operation}`);
    return { selection, result: { requestId: request.requestId, capability: request.capability,
      version: request.version, context: request.context, status: 'done', output } };
  } };
  const targets = await prepareEnvironmentTargets({ access, nowMs: NOW });
  const planningReceipt = await prepareEnvironmentProfilePlan({ access, targets, observations, nowMs: NOW });
  const review = await prepareEnvironmentProfileWrite({ access, planningReceipt });
  const approval = { planSha256: planningReceipt.plan.planSha256, createCount: 1,
    attachCount: 1, reference: 'synthetic-pilot-only' };
  const apply = () => applyEnvironmentProfileWrite({ access, review, approval,
    authorize: async () => true, onEvent: async event => { state.events.push(event); },
    sleep: async () => {} });
  return { access, state, review, apply, callTool, observations, targets, avatar };
}

// This is a candidate domain-operation composition over the same synthetic lower
// effects. The parent PoC separately proves MCP transport; this comparison does
// not claim to exercise a Plugin host or select this tool boundary.
async function candidateDomainOperation(f) {
  const creator = f.observations.creators[0];
  assert.equal(creator.creatorRecordId, f.targets.manifest.rows[0].creatorRecordId);
  assert.equal(creator.profile.avatar.sha256, f.avatar.sha256);
  const prior = await f.callTool(MCP_SEARCH, { table: 'history', creator: creator.creatorRecordId });
  if (prior.length) return { status: 'unknown', reason: 'existing_row_requires_reconciliation' };
  let token;
  try { token = (await f.callTool(AVATAR_UPLOAD, f.avatar)).file_token; }
  catch { return { status: 'unknown', stage: 'upload' }; }
  try {
    await f.callTool(MCP_CREATE, { table: 'history', fields: {
      creator: creator.creatorRecordId, observedAt: Date.parse(creator.observedAt),
      followers: creator.profile.followerCount, avatar: [{ file_token: token }],
    } });
  } catch { /* The create may have succeeded; only readback can decide. */ }
  const rows = await f.callTool(MCP_SEARCH, { table: 'history', creator: creator.creatorRecordId });
  if (rows.length !== 1 || rows[0].fields.creator !== creator.creatorRecordId
    || rows[0].fields.followers !== creator.profile.followerCount
    || rows[0].fields.observedAt !== Date.parse(creator.observedAt)
    || f.state.uploads.get(rows[0].fields.avatar?.[0]?.file_token) !== f.avatar.sha256) {
    return { status: 'unknown', stage: 'readback' };
  }
  return { status: 'completed', recordId: rows[0].record_id };
}

for (const scenario of [
  { name: 'normal create' },
  { name: 'lost create response', loseCreateResponse: true },
  { name: 'failed upload', failUpload: true },
]) {
  test(`same-input synthetic outcome: ${scenario.name}`, async t => {
    const retained = await pilot(t, scenario);
    const candidate = await pilot(t, { ...scenario, avatarPath: retained.avatar.path });
    assert.deepEqual(candidate.observations, retained.observations);
    assert.deepEqual(candidate.targets.manifest, retained.targets.manifest);
    assert.equal(candidate.avatar.sha256, retained.avatar.sha256);
    const currentResult = await retained.apply();
    const candidateResult = await candidateDomainOperation(candidate);
    assert.equal(candidateResult.status === 'completed', currentResult.status === 'success');
    assert.deepEqual(candidate.state.history, retained.state.history);
    for (const f of [candidate, retained]) {
      const create = f.state.toolCalls.find(call => call.name === MCP_CREATE);
      if (!scenario.failUpload) assert.deepEqual(create.args, { table: 'history', fields: {
        creator: CREATOR, observedAt: NOW, followers: 42,
        avatar: [{ file_token: 'synthetic-avatar-token' }],
      } });
    }
    assert.deepEqual(candidate.state.toolCalls.filter(call => [AVATAR_UPLOAD, MCP_CREATE].includes(call.name))
      .map(call => call.name), retained.state.toolCalls.filter(call => [AVATAR_UPLOAD, MCP_CREATE].includes(call.name))
      .map(call => call.name));
    assert.equal(candidate.state.toolCalls.filter(call => call.name === MCP_CREATE).length,
      retained.state.toolCalls.filter(call => call.name === MCP_CREATE).length);
  });
}

test('synthetic Profile pilot uploads an avatar before creating history and verifies readback', async t => {
  const f = await pilot(t);
  const result = await f.apply();
  assert.equal(result.status, 'success');
  assert.equal(result.businessWorkflowVerified, true);
  assert.deepEqual(f.state.toolCalls.filter(call => [AVATAR_UPLOAD, MCP_CREATE].includes(call.name))
    .map(call => call.name), [AVATAR_UPLOAD, MCP_CREATE]);
  assert.equal((await verifyEnvironmentProfileWrite({ access: f.access, review: f.review })).verified, true);
});

test('lost create response is reconciled by readback without replay', async t => {
  const f = await pilot(t, { loseCreateResponse: true });
  const result = await f.apply();
  assert.equal(result.status, 'success');
  assert.equal(result.recoveredFromAmbiguousResponse, true);
  assert.equal(f.state.toolCalls.filter(call => call.name === MCP_CREATE).length, 1);
  assert.equal(f.state.history.length, 1);
});

test('upload failure leaves no history and remains unresolved without a blind create', async t => {
  const f = await pilot(t, { failUpload: true });
  const result = await f.apply();
  assert.equal(result.status, 'unresolved');
  assert.equal(result.businessWorkflowVerified, false);
  assert.equal(f.state.toolCalls.filter(call => call.name === MCP_CREATE).length, 0);
  assert.equal(f.state.history.length, 0);
});
