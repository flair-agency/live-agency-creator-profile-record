import { validateTargetManifest, normalizeAccountKey, sha256Json } from './profile-plan.mjs';
import { validateProfileObservations } from './contracts.mjs';

const check = (ok, message) => { if (!ok) throw new TypeError(message); };

export function createProfileProgress(targets) {
  validateTargetManifest(targets.manifest);
  check(targets.version === 1 && targets.selection, 'saved environment targets required');
  return { version: 1, targetsSha256: sha256Json(targets), results: [] };
}

function validateResult(targets, result) {
  const target = targets.manifest.rows.find(row => row.creatorRecordId === result.creatorRecordId);
  check(target && normalizeAccountKey(target.accountKey) === normalizeAccountKey(result.accountKey), 'progress target identity mismatch');
  check(['completed', 'partial', 'blocked'].includes(result.status), 'invalid acquisition status');
  check(Array.isArray(result.evidenceRefs) && result.evidenceRefs.every(ref => typeof ref === 'string' && ref.trim()), 'evidence references must be strings');
  if (result.status !== 'completed') check(typeof result.reason === 'string' && result.reason.trim(), 'partial or blocked result needs a reason');
  if (result.observation !== undefined) {
    const observation = result.observation;
    check(observation.creatorRecordId === target.creatorRecordId && normalizeAccountKey(observation.accountKey) === normalizeAccountKey(target.accountKey), 'observation identity mismatch');
    validateProfileObservations({ observedAt: observation.observedAt, rowCount: 1, creators: [observation] });
  }
  if (result.status === 'completed') {
    check(result.observation && result.evidenceRefs.length > 0, 'completed acquisition needs normalized observation and evidence references');
  }
}

export function inspectProfileProgress(targets, progress) {
  const expected = createProfileProgress(targets);
  check(progress.version === 1 && progress.targetsSha256 === expected.targetsSha256, 'progress scope or environment changed');
  check(Array.isArray(progress.results), 'progress results required');
  const seen = new Set();
  for (const result of progress.results) {
    validateResult(targets, result);
    check(!seen.has(result.creatorRecordId), 'duplicate progress target');
    seen.add(result.creatorRecordId);
  }
  const counts = { total: targets.manifest.rowCount, completed: 0, partial: 0, blocked: 0, pending: targets.manifest.rowCount - seen.size };
  for (const result of progress.results) counts[result.status]++;
  const remaining = targets.manifest.rows.filter(row => !progress.results.some(result => result.creatorRecordId === row.creatorRecordId && result.status === 'completed'));
  return { counts, remaining, acquisitionComplete: counts.completed === counts.total, businessWorkflowVerified: false };
}

export function recordProfileProgress(targets, progress, result) {
  inspectProfileProgress(targets, progress);
  validateResult(targets, result);
  const prior = progress.results.find(row => row.creatorRecordId === result.creatorRecordId);
  check(!prior || prior.status !== 'completed' || sha256Json(prior) === sha256Json(result), 'completed result is immutable; preserve it and explicitly prepare a new acquisition scope');
  const next = structuredClone(progress);
  next.results = next.results.filter(row => row.creatorRecordId !== result.creatorRecordId);
  next.results.push(structuredClone(result));
  return next;
}

export function assembleProfileObservations(targets, progress) {
  check(inspectProfileProgress(targets, progress).acquisitionComplete, 'all manifest targets must have completed observations');
  const creators = targets.manifest.rows.map(row => progress.results.find(result => result.creatorRecordId === row.creatorRecordId).observation);
  const observedAt = creators.reduce((latest, row) => Date.parse(row.observedAt) > Date.parse(latest) ? row.observedAt : latest, targets.manifest.generatedAt);
  return validateProfileObservations({ observedAt, rowCount: creators.length, creators });
}
