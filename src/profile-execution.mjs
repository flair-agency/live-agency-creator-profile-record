import { randomUUID } from 'node:crypto';
import { validateProviderResult } from '@flair-agency/provider-protocol';
import { prepareEnvironmentProfilePlan } from './profile-environment.mjs';
import { sha256Json, validateProfileSyncPlan, planIsBlocked } from './profile-plan.mjs';

const CAPABILITY = 'creator-profile-datastore-write/v1';
const check = (ok, message) => { if (!ok) throw new TypeError(message); };
const same = (a, b) => sha256Json(a) === sha256Json(b);
// Read errors already contain only the selected Provider's sanitized diagnostics.
const diagnostics = error => error.providerCode === undefined ? {} : {
  providerCode: error.providerCode,
  ...(error.details === undefined ? {} : { details: structuredClone(error.details) }),
};
const unsigned = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

function validatePlanningReceipt(access, receipt) {
  check(receipt?.version === 1 && receipt.receiptSha256 === sha256Json(unsigned(receipt, 'receiptSha256')),
    'planning receipt hash does not match');
  check(same(receipt.selection, access.selection), 'environment selection changed');
  validateProfileSyncPlan(receipt.plan);
  return receipt;
}

async function freshPlan(access, receipt) {
  validatePlanningReceipt(access, receipt);
  return prepareEnvironmentProfilePlan({ access,
    targets: { version: 1, selection: receipt.selection, manifest: receipt.plan.inputs.manifest },
    observations: receipt.plan.inputs.observations, nowMs: receipt.plan.builtAtMs });
}

async function invoke(access, input, execution) {
  const request = { requestId: randomUUID(), capability: CAPABILITY, version: '1.0.0',
    context: structuredClone(access.selection), input };
  const reply = await access.invoke(request, execution);
  check(same(reply.selection, access.selection), 'write result environment changed');
  validateProviderResult(reply.result, request);
  return reply.result;
}

function effects(plan) {
  return { operation: 'prepare', planSha256: plan.planSha256,
    creates: structuredClone(plan.operations.profileCreates),
    appendExisting: plan.operations.profileAttachExisting.map(({ recordId, avatar }) => ({ recordId, avatar: structuredClone(avatar) })) };
}

function validatePrepared(access, prepared, plan) {
  const input = effects(plan);
  check(prepared && prepared.planSha256 === plan.planSha256 && same(prepared.selection, access.selection)
    && same(prepared.input, input) && prepared.inputSha256 === sha256Json(input)
    && same(prepared.counts, { create: plan.summary.profileCreateCount, attach: plan.summary.profileAttachCount,
      appendExisting: plan.summary.profileAttachExistingCount })
    && prepared.intentSha256 === sha256Json(unsigned(prepared, 'intentSha256')), 'prepared write differs from the business plan');
}

export async function prepareEnvironmentProfileWrite({ access, planningReceipt }) {
  const current = await freshPlan(access, planningReceipt);
  check(current.plan.planSha256 === planningReceipt.plan.planSha256, 'business plan changed; review the new plan');
  check(!planIsBlocked(current.plan), 'blocking issues prevent write preparation');
  const count = current.plan.summary.profileCreateCount + current.plan.summary.profileAttachExistingCount;
  if (!count) return { status: 'unchanged', planningReceipt: current, businessWorkflowVerified: false };
  const result = await invoke(access, effects(current.plan));
  check(result.status === 'done', `write preparation failed: ${result.error?.code ?? result.status}`);
  validatePrepared(access, result.output, current.plan);
  const review = { version: 1, selection: structuredClone(access.selection), planningReceipt: current, prepared: result.output };
  return { ...review, reviewSha256: sha256Json(review) };
}

function validateReview(access, review) {
  check(review?.version === 1 && review.reviewSha256 === sha256Json(unsigned(review, 'reviewSha256')),
    'write review hash does not match');
  check(same(review.selection, access.selection), 'environment selection changed');
  validatePlanningReceipt(access, review.planningReceipt);
  validatePrepared(access, review.prepared, review.planningReceipt.plan);
}

export async function verifyEnvironmentProfileWrite({ access, review }) {
  validateReview(access, review);
  const receipt = await freshPlan(access, review.planningReceipt);
  const verified = !planIsBlocked(receipt.plan) && receipt.plan.summary.profileCreateCount === 0
    && receipt.plan.summary.profileAttachExistingCount === 0;
  return { status: verified ? 'verified' : 'unresolved', verified, businessWorkflowVerified: verified,
    reviewSha256: review.reviewSha256, planningReceipt: receipt };
}

export async function applyEnvironmentProfileWrite({ access, review, approval, authorize, onEvent,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  validateReview(access, review);
  const plan = review.planningReceipt.plan;
  check(approval?.planSha256 === plan.planSha256 && approval.createCount === plan.summary.profileCreateCount
    && approval.attachCount === plan.summary.profileAttachCount && typeof approval.reference === 'string'
    && approval.reference.trim(), 'exact plan, counts and actual approval reference are required');
  check(typeof authorize === 'function' && typeof onEvent === 'function', 'trusted authorization and durable events are required');
  const current = await freshPlan(access, review.planningReceipt);
  check(current.plan.planSha256 === plan.planSha256 && !planIsBlocked(current.plan), 'business plan changed; review the new plan');
  check(await authorize(review, approval) === true, 'business plan not authorized');
  await onEvent({ stage: 'approval-confirmed', reviewSha256: review.reviewSha256, selection: review.selection, approval });
  let result, writeError, writeFailure, readbackFailure, failureStage = null;
  try {
    result = await invoke(access, { operation: 'apply', prepared: review.prepared }, {
      authorizeIntent: async intent => same(intent, review.prepared) && await authorize(review, approval) === true,
      onEvent: event => onEvent({ stage: 'provider-event', reviewSha256: review.reviewSha256, event }),
    });
    if (result.status !== 'done') {
      writeError = result.error?.code ?? result.status;
      // The Provider owns sanitization. Keep its diagnostic envelope separate
      // from a later readback failure; neither its message nor cause is retained.
      writeFailure = diagnostics({ providerCode: writeError, details: result.error?.details });
      // Preserve only a small diagnostic value, never the private service payload.
      const stage = result.error?.details?.stage;
      failureStage = typeof stage === 'string' && /^[a-z-]{1,40}$/.test(stage) ? stage : null;
    }
    else {
      const output = result.output;
      const ids = output?.createdRecordIds;
      if (!Array.isArray(ids) || ids.length !== plan.summary.profileCreateCount
        || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id)
        || output.createCount !== plan.summary.profileCreateCount
        || output.attachCount !== plan.summary.profileAttachCount
        || output.appendExistingCount !== plan.summary.profileAttachExistingCount) writeError = 'WRITE_ACKNOWLEDGEMENT_MISMATCH';
    }
  } catch (error) { writeError = error.code ?? 'WRITE_CALL_INCOMPLETE'; }

  try {
    await onEvent({ stage: 'write-call-returned', reviewSha256: review.reviewSha256,
      writeError: writeError ?? null, failureStage, providerReportedUncertainWrite: result?.error?.details?.uncertainWrite === true,
      ...(writeFailure === undefined ? {} : { writeFailure }) });
    // Retain the existing bounded readback sequence. Only reads may repeat.
    let verification;
    for (const delay of [0, 500, 1500, 3000]) {
      if (delay) await sleep(delay);
      try { verification = await verifyEnvironmentProfileWrite({ access, review }); }
      catch (error) {
        // Preserve the known read failure even if recording it also fails.
        readbackFailure = diagnostics(error);
        await onEvent({ stage: 'readback-failed', reviewSha256: review.reviewSha256,
          code: error.code ?? 'READBACK_INCOMPLETE', readbackFailure });
        throw Object.assign(new Error('write outcome unresolved; inspect journal and read back without resending'),
          { uncertainWrite: true, cause: error, ...readbackFailure, readbackFailure });
      }
      if (verification.verified) break;
    }
    if (!verification?.verified) {
      await onEvent({ stage: 'unresolved', reviewSha256: review.reviewSha256, writeError: writeError ?? null });
      return { status: 'unresolved', verified: false, businessWorkflowVerified: false, reviewSha256: review.reviewSha256,
        writeError: writeError ?? null, ...(writeFailure === undefined ? {} : { writeFailure }), verification };
    }
    const completed = { status: 'success', verified: true, businessWorkflowVerified: true, reviewSha256: review.reviewSha256,
      planSha256: plan.planSha256, profileCreatedCount: plan.summary.profileCreateCount,
      profileAttachedCount: plan.summary.profileAttachCount,
      profileVerifiedCount: verification.planningReceipt.plan.summary.profileAlreadyAppliedCount,
      recoveredFromAmbiguousResponse: Boolean(writeError),
      ...(writeFailure === undefined ? {} : { writeFailure }), verification };
    await onEvent({ stage: 'business-verified', reviewSha256: review.reviewSha256, planSha256: plan.planSha256 });
    return completed;
  } catch (error) {
    // Includes durable-event failures after invocation: do not turn missing
    // evidence into a claim that no write occurred or make the old review retryable.
    throw Object.assign(new Error('write or its evidence is unresolved; preserve the journal and verify without resending'),
      { code: 'PROFILE_WRITE_OUTCOME_UNRESOLVED', uncertainWrite: true, cause: error, ...(readbackFailure ?? diagnostics(error)),
        ...(writeFailure === undefined ? {} : { writeFailure }),
        ...(readbackFailure === undefined ? {} : { readbackFailure }) });
  }
}
