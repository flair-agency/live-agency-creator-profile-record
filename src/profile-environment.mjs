import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { validateProviderResult } from '@flair-agency/provider-protocol';
import { validateProfileObservations } from './contracts.mjs';
import { PROFILE_TARGET_INPUT_KIND, normalizeAccountKey, isRecordId,
  validateTargetManifest, buildProfileSyncPlanFromHistory, sha256Json, planIsBlocked } from './profile-plan.mjs';

const READ = 'creator-profile-datastore-read/v1';
const SOURCE = 'creator-profile-observation-source/v2';
const check = (ok, message) => { if (!ok) throw new TypeError(message); };
const same = (a, b) => sha256Json(a) === sha256Json(b);

function selected(access, savedSelection = access.selection) {
  check(typeof access?.invoke === 'function', 'selected environment access is required');
  check(same(access.selection, savedSelection), 'environment selection changed; prepare new targets');
  return structuredClone(access.selection);
}

async function read(access, input) {
  const request = { requestId: randomUUID(), capability: READ, version: '1.0.0',
    context: selected(access), input };
  const reply = await access.invoke(request);
  selected(access, reply.selection);
  validateProviderResult(reply.result, request);
  if (reply.result.status !== 'done') {
    const error = new TypeError(`profile read did not complete: ${reply.result.error?.code ?? reply.result.status}`);
    if (reply.result.status === 'failed') {
      error.providerCode = reply.result.error.code;
      // The selected Provider owns sanitization; retain only its diagnostic fields.
      if (reply.result.error.details !== undefined) error.details = structuredClone(reply.result.error.details);
    }
    throw error;
  }
  return reply;
}

function creatorRows(output, mode) {
  check(Array.isArray(output.creators), 'creator result is invalid');
  let rows = output.creators;
  if (mode === 'due') {
    check(Array.isArray(output.dueCreatorRecordIds), 'due membership is required');
    const byId = new Map(rows.map(row => [row.creatorRecordId, row]));
    rows = output.dueCreatorRecordIds.map(id => {
      check(byId.has(id), 'due creator is absent from creator snapshot');
      return byId.get(id);
    });
  }
  return rows.map((row, index) => {
    check(isRecordId(row.creatorRecordId), `creator row ${index + 1} record ID is invalid`);
    const accountKey = normalizeAccountKey(row.accountKey);
    check(accountKey, `creator row ${index + 1} account is invalid`);
    return { creatorRecordId: row.creatorRecordId, accountKey };
  });
}

export async function prepareEnvironmentTargets({ access, mode = 'due', selectedAccounts = [], limit = 20, nowMs = Date.now() }) {
  check(['due', 'selected', 'all'].includes(mode), 'target mode is invalid');
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'limit must be between 1 and 100');
  check(mode === 'selected' || selectedAccounts.length === 0, 'selected accounts require selected mode');
  const reply = await read(access, { operation: 'read-creators', includeDueMembership: mode === 'due' });
  const rows = creatorRows(reply.result.output, mode);
  const byAccount = new Map();
  for (const row of rows) {
    check(!byAccount.has(row.accountKey), `creator account is duplicated: ${row.accountKey}`);
    byAccount.set(row.accountKey, row);
  }
  const seen = new Set();
  const chosen = mode === 'selected' ? selectedAccounts.map(value => {
    const key = normalizeAccountKey(value);
    check(key && !seen.has(key), `selected account is invalid or duplicated: ${value}`);
    seen.add(key);
    check(byAccount.has(key), `selected account is absent from datastore: ${value}`);
    return byAccount.get(key);
  }) : rows;
  const targets = chosen.slice(0, limit);
  const manifest = validateTargetManifest({ version: 2, inputKind: PROFILE_TARGET_INPUT_KIND,
    generatedAt: new Date(nowMs).toISOString(), targetMode: mode, rowCount: targets.length,
    rows: targets, rowsSha256: sha256Json(targets) });
  return { version: 1, selection: selected(access), manifest, readBinding: reply.binding };
}

function validateTargets(access, targets) {
  check(targets?.version === 1, 'environment targets version is invalid');
  selected(access, targets.selection);
  return validateTargetManifest(targets.manifest);
}

export async function requestEnvironmentObservations({ access, targets }) {
  const manifest = validateTargets(access, targets);
  const request = { requestId: randomUUID(), capability: SOURCE, version: '2',
    context: selected(access), input: structuredClone(manifest) };
  const reply = await access.invoke(request);
  selected(access, reply.selection);
  validateProviderResult(reply.result, request);
  if (reply.result.status === 'done') validateProfileObservations(reply.result.output);
  return { version: 1, selection: selected(access), manifest, request, ...reply };
}

// Correlation proves which request was answered, not that visible evidence was true.
export async function acceptEnvironmentObservations({ access, targets, handoff, result }) {
  const manifest = validateTargets(access, targets);
  selected(access, handoff.selection);
  check(same(manifest, handoff.request?.input), 'source handoff targets changed');
  check(handoff.request?.capability === SOURCE && handoff.request.version === '2'
    && same(handoff.request.context, access.selection), 'source handoff selection is invalid');
  const reply = await access.validateInstructionResult(handoff.request, result);
  selected(access, reply.selection);
  validateProviderResult(reply.result, handoff.request);
  check(reply.result.status === 'done', 'source observation did not complete');
  return validateProfileObservations(reply.result.output);
}

function targetIssues(manifest, output) {
  check(Array.isArray(output.creators), 'creator result is invalid');
  if (manifest.targetMode === 'due') check(Array.isArray(output.dueCreatorRecordIds), 'due membership is required');
  const byId = new Map(output.creators.map(row => [row.creatorRecordId, row]));
  const dueIds = new Set(output.dueCreatorRecordIds ?? []);
  const counts = new Map();
  for (const row of output.creators) {
    const key = normalizeAccountKey(row.accountKey);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const issues = [];
  for (const row of manifest.rows) {
    const current = byId.get(row.creatorRecordId);
    const expected = normalizeAccountKey(row.accountKey);
    const reason = !current ? 'creator_record_missing'
      : normalizeAccountKey(current.accountKey) !== expected ? 'creator_account_changed'
      : counts.get(expected) !== 1 ? 'creator_account_not_unique'
      : manifest.targetMode === 'due' && !dueIds.has(row.creatorRecordId) ? 'not_in_due_view' : null;
    if (reason) issues.push({ creatorRecordId: row.creatorRecordId, reason });
  }
  return issues;
}

function normalizedHistory(rows, manifest) {
  check(Array.isArray(rows), 'profile history result is invalid');
  const ids = new Set(manifest.rows.map(row => row.creatorRecordId));
  const count = value => value === null || (Number.isSafeInteger(value) && value >= 0);
  for (const row of rows) {
    check(row && typeof row.valid === 'boolean' && typeof row.recordId === 'string', 'profile history row is invalid');
    if (!row.valid) {
      check(Array.isArray(row.reasons) && row.reasons.length > 0
        && row.reasons.every(reason => typeof reason === 'string' && reason), 'invalid profile reasons are required');
      continue;
    }
    check(isRecordId(row.recordId) && ids.has(row.creatorRecordId) && Number.isFinite(row.timestampMs)
      && count(row.followerCount) && count(row.recentPostCount30d)
      && (row.latestPostAtMs === null || Number.isFinite(row.latestPostAtMs))
      && (row.nickname === null || typeof row.nickname === 'string')
      && (row.featureObservationJson === null || typeof row.featureObservationJson === 'string')
      && Array.isArray(row.avatarHashes) && row.avatarHashes.every(hash => /^[a-f0-9]{64}$/.test(hash)),
    'normalized profile history violates the selected scope or row contract');
  }
  return rows;
}

export async function prepareEnvironmentProfilePlan({ access, targets, observations, nowMs = Date.now() }) {
  const manifest = validateTargets(access, targets);
  validateProfileObservations(observations);
  for (const creator of observations.creators) {
    const avatar = creator.profile.avatar;
    if (!avatar) continue;
    const file = await open(avatar.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      check(stat.isFile() && stat.size === avatar.size && (stat.mode & 0o077) === 0
        && (typeof process.getuid !== 'function' || stat.uid === process.getuid()),
      'avatar must be an owner-only regular file matching observation size');
      const hash = createHash('sha256');
      let size = 0;
      for await (const bytes of file.createReadStream({ autoClose: false })) {
        size += bytes.length;
        hash.update(bytes);
      }
      check(size === avatar.size && hash.digest('hex') === avatar.sha256,
        'avatar file differs from observation metadata');
    } finally { await file.close(); }
  }
  const creators = await read(access, { operation: 'read-creators', includeDueMembership: manifest.targetMode === 'due' });
  const issues = targetIssues(manifest, creators.result.output);
  // Always bind the history read to selected creators; never widen an empty list.
  const history = manifest.rows.length ? await read(access, { operation: 'read-profile-history',
    creatorRecordIds: manifest.rows.map(row => row.creatorRecordId) }) : null;
  const timestampMode = creators.result.output.timestampMode;
  check(['observed-at', 'created-at'].includes(timestampMode), 'timestamp mode is invalid');
  if (history) check(history.result.output.timestampMode === timestampMode, 'timestamp mode changed during read');
  const plan = buildProfileSyncPlanFromHistory({ manifest, observations,
    profileHistory: normalizedHistory(history ? history.result.output.profileHistory : [], manifest), nowMs });
  plan.operations.targetIssues.push(...issues);
  plan.summary.targetIssueCount = plan.operations.targetIssues.length;
  delete plan.planSha256;
  plan.planSha256 = sha256Json(plan);
  const receipt = { version: 1, selection: selected(access), timestampMode, plan,
    status: planIsBlocked(plan) ? 'blocked' : 'planned', businessWorkflowVerified: false };
  return { ...receipt, receiptSha256: sha256Json(receipt) };
}
