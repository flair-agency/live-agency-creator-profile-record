import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateProviderResult } from '@flair-agency/provider-protocol';
import { prepareEnvironmentTargets, requestEnvironmentObservations,
  acceptEnvironmentObservations, prepareEnvironmentProfilePlan } from '../src/profile-environment.mjs';
import { exportProfileTargets, prepareProfilePlan } from '../scripts/profile_lark_runtime.mjs';
import { parseArgs } from '../scripts/profile_environment.mjs';

const NOW = Date.parse('2030-01-02T03:04:00Z');
const A = 'recSyntheticA001', B = 'recSyntheticB001';
const selection = { environmentId: 'synthetic', environmentKind: 'development', platformId: 'synthetic', generation: 'a'.repeat(64) };
const config = { appToken: 'synthetic', creatorTableId: 'creators', profileTableId: 'history', dueViewId: 'due', fieldIds: {
  creatorAccount: 'account', profileTimestamp: 'time', profileCreator: 'creator', profileFollowerCount: 'followers',
  profileRecentPostCount30d: 'posts', profileLatestPostAt: 'latest', profileNickname: 'nickname', profileAvatar: 'avatar', profileFeatureObservationData: 'feature',
} };
const field = (field_id, ui_type, property) => ({ field_id, field_name: field_id, ui_type, ...(property ? { property } : {}) });
const fields = [field('time', 'DateTime'), field('creator', 'DuplexLink', { table_id: 'creators', multiple: false }),
  field('followers', 'Number'), field('posts', 'Number'), field('latest', 'DateTime'), field('nickname', 'Text'), field('avatar', 'Attachment'), field('feature', 'Text')];
const creators = [{ creatorRecordId: A, accountKey: 'synthetic.a' }, { creatorRecordId: B, accountKey: '@Synthetic.B' }];
const due = [B, A];
const rawHistory = [{ record_id: 'recHistory0001', fields: { creator: [B], time: NOW, followers: 42 } }];
const normalizedHistory = [{ valid: true, recordId: 'recHistory0001', creatorRecordId: B, timestampMs: NOW,
  followerCount: 42, recentPostCount30d: null, latestPostAtMs: null, nickname: null, featureObservationJson: null, avatarHashes: [] }];
const observations = { observedAt: new Date(NOW).toISOString(), rowCount: 1, creators: [{ creatorRecordId: B,
  accountKey: 'synthetic.b', observedAt: new Date(NOW).toISOString(), profile: { followerCount: 42, followerStatus: 'observed_exact',
    recentPostCount30d: null, recentPostStatus: 'not_available', latestPostAt: null, latestPostStatus: 'not_available',
    nickname: null, nicknameStatus: 'not_available', avatar: null, avatarStatus: 'not_available',
    featureObservationData: null, featureObservationStatus: 'not_available' } }] };

// Captures the Runtime access port; it does not simulate installation verification.
function fixture() {
  const calls = [];
  const state = { failHistory: false, corruptCorrelation: false, wrongHistoryScope: false };
  const envelope = (request, payload) => ({ requestId: request.requestId, capability: request.capability,
    version: request.version, context: structuredClone(request.context), ...payload });
  const access = {
    selection: structuredClone(selection),
    async invoke(request) {
      calls.push(structuredClone(request));
      let result;
      if (request.capability === 'creator-profile-observation-source/v2') {
        result = envelope(request, { status: 'interaction-required', instructions: 'Use synthetic normalized observations.' });
      } else if (request.input.operation === 'read-creators') {
        result = envelope(request, { status: 'done', output: { creators, dueCreatorRecordIds: due, timestampMode: 'observed-at' } });
      } else {
        assert.equal(request.input.operation, 'read-profile-history');
        assert.deepEqual(request.input.creatorRecordIds, [B]);
        result = envelope(request, state.failHistory ? { status: 'failed', error: { code: 'SYNTHETIC_READ_DENIED', message: 'denied' } }
          : { status: 'done', output: { profileHistory: state.wrongHistoryScope
            ? normalizedHistory.map(row => ({ ...row, creatorRecordId: A })) : normalizedHistory, timestampMode: 'observed-at' } });
      }
      if (state.corruptCorrelation) result.requestId = 'different-request';
      return { selection: structuredClone(access.selection), binding: { bindingId: 'synthetic' }, result };
    },
    async validateInstructionResult(request, result) {
      calls.push({ validation: true });
      validateProviderResult(result, request);
      return { selection: structuredClone(access.selection), result };
    },
  };
  const client = {
    async listFields(_base, table) { return table === 'creators' ? [field('account', 'Text')] : fields; },
    async listRecords(_base, table, query = {}) {
      if (table === 'history') return structuredClone(rawHistory);
      const ordered = query.view_id ? due.map(id => creators.find(row => row.creatorRecordId === id)) : creators;
      return ordered.map(row => ({ record_id: row.creatorRecordId, fields: { account: row.accountKey } }));
    },
    async attachmentSha256() { throw Error('no attachments in this fixture'); },
  };
  return { access, calls, state, client, envelope };
}

test('due targets, instruction correlation and scoped history preserve the legacy plan and hash', async () => {
  const f = fixture();
  const targets = await prepareEnvironmentTargets({ access: f.access, limit: 1, nowMs: NOW });
  const manifest = await exportProfileTargets({ client: f.client, config, mode: 'due', limit: 1, nowMs: NOW });
  assert.deepEqual(targets.manifest, manifest);
  assert.deepEqual(manifest.rows, [{ creatorRecordId: B, accountKey: 'synthetic.b' }]);
  const handoff = await requestEnvironmentObservations({ access: f.access, targets });
  assert.equal(handoff.result.status, 'interaction-required');
  assert.deepEqual(handoff.request.input, manifest);
  const accepted = await acceptEnvironmentObservations({ access: f.access, targets, handoff,
    result: f.envelope(handoff.request, { status: 'done', output: observations }) });
  const receipt = await prepareEnvironmentProfilePlan({ access: f.access, targets, observations: accepted, nowMs: NOW });
  const legacy = await prepareProfilePlan({ client: f.client, config, manifest, observations, nowMs: NOW });
  assert.deepEqual(receipt.plan, legacy.plan);
  assert.equal(receipt.plan.summary.profileAlreadyAppliedCount, 1);
  assert.equal(receipt.businessWorkflowVerified, false);
  assert.deepEqual(f.calls.filter(call => call.input?.operation === 'read-profile-history').map(call => call.input),
    [{ operation: 'read-profile-history', creatorRecordIds: [B] }]);
});

test('generation drift and uncorrelated or failed replies cannot become a plan', async () => {
  const f = fixture();
  const targets = await prepareEnvironmentTargets({ access: f.access, limit: 1, nowMs: NOW });
  const handoff = await requestEnvironmentObservations({ access: f.access, targets });
  f.calls.length = 0;
  f.access.selection.generation = 'b'.repeat(64);
  await assert.rejects(requestEnvironmentObservations({ access: f.access, targets }), /selection changed/);
  await assert.rejects(prepareEnvironmentProfilePlan({ access: f.access, targets, observations, nowMs: NOW }), /selection changed/);
  assert.equal(f.calls.length, 0);
  f.access.selection = structuredClone(selection);
  await assert.rejects(acceptEnvironmentObservations({ access: f.access, targets, handoff,
    result: { ...f.envelope(handoff.request, { status: 'done', output: observations }), requestId: 'unrelated' } }), /requestId/);
  f.state.corruptCorrelation = true;
  await assert.rejects(prepareEnvironmentTargets({ access: f.access, nowMs: NOW }), /requestId/);
  f.state.corruptCorrelation = false;
  f.state.failHistory = true;
  await assert.rejects(prepareEnvironmentProfilePlan({ access: f.access, targets, observations, nowMs: NOW }), /SYNTHETIC_READ_DENIED/);
  f.state.failHistory = false;
  f.state.wrongHistoryScope = true;
  await assert.rejects(prepareEnvironmentProfilePlan({ access: f.access, targets, observations, nowMs: NOW }), /selected scope or row contract/);
});

test('the new entry imports only neutral contracts and rejects apply', async () => {
  // Inspect the reachable local import graph, including dynamic imports.
  const visited = new Set();
  async function inspect(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    const text = await readFile(url, 'utf8');
    const imports = [...text.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
    for (const specifier of imports) {
      assert.doesNotMatch(specifier, /(?:lark-base|tiktok-web)-provider|profile_lark_runtime|profile_sync_core/);
      if (specifier.startsWith('.')) await inspect(new URL(specifier, url));
    }
  }
  await inspect(new URL('../scripts/profile_environment.mjs', import.meta.url));
  assert(visited.has(new URL('../src/profile-observation.mjs', import.meta.url).href));
  assert.throws(() => parseArgs(['apply']), /no apply operation/);
  assert.throws(() => parseArgs(['plan', '--apply', 'true']), /invalid option/);
});
