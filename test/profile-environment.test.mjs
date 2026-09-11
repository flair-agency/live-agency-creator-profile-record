import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
        result = envelope(request, state.failHistory ? { status: 'failed', error: { code: 'SYNTHETIC_READ_DENIED', message: 'private-provider-message',
          ...(state.details === undefined ? {} : { details: state.details }) } }
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

test('the new entry imports only neutral contracts and requires explicit execution inputs', async () => {
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
  assert.throws(() => parseArgs(['apply']), /environment is required/);
  assert.throws(() => parseArgs(['plan', '--apply', 'true']), /invalid option/);
  const apply = ['apply', '--environment', '/private/environment.json', '--generation', 'a'.repeat(64),
    '--review', '/private/review.json', '--output', '/private/result.json', '--expect-sha256', 'b'.repeat(64),
    '--confirm-profile-create', '1', '--confirm-profile-attach', '0', '--approval-ref', 'synthetic-only',
    '--journal-directory', '/private/journals'];
  assert.equal(parseArgs(apply)['confirm-profile-create'], '1');
  await assert.rejects(async () => parseArgs(apply.map(value => value === 'synthetic-only' ? ' ' : value)), /actual approval reference/);
  assert.throws(() => parseArgs(apply.map(value => value === '1' ? '1.5' : value)), /nonnegative integer/);
});

test('failed reads retain only correlated Provider diagnostics for library callers', async () => {
  const f = fixture();
  const targets = await prepareEnvironmentTargets({ access: f.access, limit: 1, nowMs: NOW });
  f.state.failHistory = true;
  for (const details of [undefined, { stage: 'history-fields', reasonCode: 'FIELD_TYPE_MISMATCH', fieldRole: 'profileCreator' },
    { stage: 'history-records', reasonCode: 'UPSTREAM_REJECTED', upstreamCode: 12345 }]) {
    f.state.details = details;
    await assert.rejects(prepareEnvironmentProfilePlan({ access: f.access, targets, observations, nowMs: NOW }), error => {
      assert(error instanceof TypeError);
      assert.equal(error.providerCode, 'SYNTHETIC_READ_DENIED');
      assert.deepEqual(error.details, details);
      assert.equal(Object.hasOwn(error, 'details'), details !== undefined);
      assert.doesNotMatch(error.message, /private-provider-message/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  f.state.corruptCorrelation = true;
  await assert.rejects(prepareEnvironmentProfilePlan({ access: f.access, targets, observations, nowMs: NOW }), error => {
    assert.match(error.message, /requestId/);
    assert.equal(error.providerCode, undefined);
    return true;
  });
});

test('actual CLI stderr carries sanitized diagnostics and failed planning creates no artifact', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-cli-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture();
  const targets = await prepareEnvironmentTargets({ access: f.access, limit: 1, nowMs: NOW });
  for (const [name, value] of Object.entries({ targets, observations })) {
    await writeFile(path.join(directory, `${name}.json`), JSON.stringify(value), { mode: 0o600 });
  }
  const details = { stage: 'history-records', reasonCode: 'UPSTREAM_REJECTED', upstreamCode: 12345 };
  const runtime = path.join(directory, 'runtime.mjs');
  await writeFile(runtime, `
    export function createEnvironmentAccess() {
      Date.now = () => ${NOW};
      const selection = ${JSON.stringify(selection)};
      return { selection, async invoke(request) {
        const history = request.input.operation === 'read-profile-history';
        const mode = process.env.SYNTHETIC_DIAGNOSTIC_MODE;
        const payload = history && mode !== 'success'
          ? { status: 'failed', error: { code: 'SYNTHETIC_READ_DENIED', message: 'private-provider-message',
              cause: 'private-cause', request: 'private-request',
              ...(mode === 'old' ? {} : { details: ${JSON.stringify(details)} }) } }
          : { status: 'done', output: history
              ? { profileHistory: ${JSON.stringify(normalizedHistory)}, timestampMode: 'observed-at' }
              : { creators: ${JSON.stringify(creators)}, dueCreatorRecordIds: ${JSON.stringify(due)}, timestampMode: 'observed-at' } };
        return { selection, binding: { bindingId: 'synthetic' }, result: {
          requestId: request.requestId, capability: request.capability, version: request.version,
          context: request.context, ...payload } };
      } };
    }
  `);
  const loader = path.join(directory, 'loader.mjs');
  await writeFile(loader, `export async function resolve(specifier, context, nextResolve) {
    if (specifier === '@flair-agency/live-agency-runtime/environment') return { url: ${JSON.stringify(new URL(`file://${runtime}`).href)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }`);
  for (const mode of ['detailed', 'old', 'success']) {
    const output = path.join(directory, `${mode}.json`);
    const child = spawnSync(process.execPath, ['--no-warnings', '--loader', loader,
      new URL('../scripts/profile_environment.mjs', import.meta.url).pathname,
      'plan', '--environment', path.join(directory, 'environment.json'), '--generation', selection.generation,
      '--targets', path.join(directory, 'targets.json'), '--observations', path.join(directory, 'observations.json'), '--output', output],
    { encoding: 'utf8', env: { ...process.env, SYNTHETIC_DIAGNOSTIC_MODE: mode } });
    assert.equal(child.error, undefined);
    if (mode === 'success') {
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stderr, '');
      const receipt = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(receipt.plan.summary.profileAlreadyAppliedCount, 1);
      assert.equal(receipt.businessWorkflowVerified, false);
    } else {
      assert.equal(child.status, 2, child.stderr);
      assert.equal(child.stdout, '');
      const diagnostic = JSON.parse(child.stderr);
      assert.equal(diagnostic.code, 'PROFILE_ENVIRONMENT_FAILED');
      assert.equal(diagnostic.providerCode, 'SYNTHETIC_READ_DENIED');
      assert.deepEqual(diagnostic.details, mode === 'old' ? undefined : details);
      assert.doesNotMatch(child.stderr, /private-provider-message|private-cause|private-request/);
      await assert.rejects(access(output), { code: 'ENOENT' });
    }
  }
});

for (const mode of ['acknowledged', 'failed-legacy', 'failed-diagnostic'])
test(`actual apply CLI separates write and readback diagnostics without replay (${mode})`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-cli-readback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture();
  const targets = await prepareEnvironmentTargets({ access: f.access, limit: 1, nowMs: NOW });
  await writeFile(path.join(directory, 'targets.json'), JSON.stringify(targets), { mode: 0o600 });
  await writeFile(path.join(directory, 'observations.json'), JSON.stringify(observations), { mode: 0o600 });
  const details = { stage: 'history-records', reasonCode: 'UPSTREAM_REJECTED', upstreamCode: 12345 };
  const writeDetails = { stage: 'apply', reasonCode: 'SYNTHETIC_WRITE_INTERRUPTED', upstreamCode: 54321, uncertainWrite: true };
  const writeReply = mode === 'acknowledged'
    ? { status: 'done', output: { createdRecordIds: ['recSyntheticCreated'], createCount: 1, attachCount: 0, appendExistingCount: 0 } }
    : { status: 'failed', error: { code: 'SYNTHETIC_WRITE_FAILED', message: 'private-provider-message',
      cause: 'private-cause', request: 'private-request', ...(mode === 'failed-diagnostic' ? { details: writeDetails } : {}) } };
  const runtime = path.join(directory, 'runtime.mjs');
  await writeFile(runtime, `
    import { appendFileSync } from 'node:fs';
    import { sha256Json } from ${JSON.stringify(new URL('../src/profile-plan.mjs', import.meta.url).href)};
    export function createEnvironmentAccess() {
      Date.now = () => ${NOW};
      const selection = ${JSON.stringify(selection)};
      let wrote = false;
      return { selection, async invoke(request) {
        const input = request.input;
        let payload;
        if (input.operation === 'prepare') {
          const prepared = { selection, planSha256: input.planSha256, input, inputSha256: sha256Json(input),
            counts: { create: 1, attach: 0, appendExisting: 0 } };
          payload = { status: 'done', output: { ...prepared, intentSha256: sha256Json(prepared) } };
        } else if (input.operation === 'apply') {
          wrote = true;
          appendFileSync(${JSON.stringify(path.join(directory, 'writes'))}, 'write\\n');
          payload = ${JSON.stringify(writeReply)};
        } else if (wrote && input.operation === 'read-profile-history') {
          payload = { status: 'failed', error: { code: 'SYNTHETIC_READ_DENIED', details: ${JSON.stringify(details)},
            message: 'private-provider-message', cause: 'private-cause', request: 'private-request' } };
        } else payload = { status: 'done', output: input.operation === 'read-creators'
          ? { creators: ${JSON.stringify(creators)}, dueCreatorRecordIds: ${JSON.stringify(due)}, timestampMode: 'observed-at' }
          : { profileHistory: [], timestampMode: 'observed-at' } };
        return { selection, binding: { bindingId: 'synthetic' }, result: {
          requestId: request.requestId, capability: request.capability, version: request.version, context: request.context, ...payload } };
      } };
    }
  `);
  const loader = path.join(directory, 'loader.mjs');
  await writeFile(loader, `export async function resolve(specifier, context, nextResolve) {
    if (specifier === '@flair-agency/live-agency-runtime/environment') return { url: ${JSON.stringify(new URL(`file://${runtime}`).href)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }`);
  const cli = (operation, output, args) => spawnSync(process.execPath, ['--no-warnings', '--loader', loader,
    new URL('../scripts/profile_environment.mjs', import.meta.url).pathname, operation,
    '--environment', path.join(directory, 'environment.json'), '--generation', selection.generation,
    '--output', path.join(directory, output), ...args], { encoding: 'utf8' });
  for (const child of [
    cli('plan', 'plan.json', ['--targets', path.join(directory, 'targets.json'), '--observations', path.join(directory, 'observations.json')]),
    cli('prepare-write', 'review.json', ['--plan', path.join(directory, 'plan.json')]),
  ]) assert.equal(child.status, 0, child.stderr);
  const review = JSON.parse(await readFile(path.join(directory, 'review.json'), 'utf8'));
  const child = cli('apply', 'result.json', ['--review', path.join(directory, 'review.json'),
    '--expect-sha256', review.planningReceipt.plan.planSha256, '--confirm-profile-create', '1',
    '--confirm-profile-attach', '0', '--approval-ref', 'synthetic-only', '--journal-directory', path.join(directory, 'journal')]);
  assert.equal(child.status, 2, child.stderr);
  const diagnostic = JSON.parse(child.stderr);
  assert.equal(diagnostic.code, 'PROFILE_WRITE_OUTCOME_UNRESOLVED');
  assert.equal(diagnostic.uncertainWrite, true);
  assert.equal(diagnostic.providerCode, 'SYNTHETIC_READ_DENIED');
  assert.deepEqual(diagnostic.details, details);
  assert.deepEqual(diagnostic.readbackFailure, { providerCode: 'SYNTHETIC_READ_DENIED', details });
  const writeFailure = mode === 'acknowledged' ? undefined : { providerCode: 'SYNTHETIC_WRITE_FAILED',
    ...(mode === 'failed-diagnostic' ? { details: writeDetails } : {}) };
  assert.deepEqual(diagnostic.writeFailure, writeFailure);
  const journal = await readFile(path.join(directory, 'journal', `${review.reviewSha256}.jsonl`), 'utf8');
  const events = journal.trim().split('\n').map(line => JSON.parse(line).event);
  assert.deepEqual(events.find(event => event.stage === 'write-call-returned').writeFailure, writeFailure);
  assert.deepEqual(events.find(event => event.stage === 'readback-failed').readbackFailure, diagnostic.readbackFailure);
  assert.doesNotMatch(journal, /private-provider-message|private-cause|private-request/);
  assert.doesNotMatch(child.stderr, /private-provider-message|private-cause|private-request/);
  assert.equal(await readFile(path.join(directory, 'writes'), 'utf8'), 'write\n');
  assert.equal(child.stdout, '');
  await assert.rejects(access(path.join(directory, 'result.json')), { code: 'ENOENT' });
});
