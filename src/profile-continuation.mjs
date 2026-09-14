import { inspectProfileProgress, recordProfileProgress } from './profile-progress.mjs';

const check = (ok, message) => { if (!ok) throw new TypeError(message); };

// TODO(flair-agency/live-agency#75): a selected host must bind this pure
// continuation state to actual task dispatch; this module never opens a source
// session or assumes that a model will continue after returning a final answer.
export function nextProfileTarget(targets, progress) {
  const state = inspectProfileProgress(targets, progress);
  return state.remaining[0] ?? null;
}

/**
 * Runs one bounded acquisition turn. The supplied acquire function may report
 * that its host turn ended before it produced a result. In that case no target
 * is marked complete and the caller receives a durable continuation boundary.
 */
export async function runProfileAcquisitionTurn({ targets, progress, acquire, maxTargets = 1 }) {
  check(typeof acquire === 'function', 'acquire function required');
  check(Number.isInteger(maxTargets) && maxTargets > 0, 'positive maxTargets required');
  let current = structuredClone(progress);
  const attempted = [];
  for (let index = 0; index < maxTargets; index++) {
    // A target-local partial/blocked result must not monopolize this bounded
    // turn. A later turn begins from it again, while this turn may continue
    // with independent rows.
    const target = inspectProfileProgress(targets, current).remaining
      .find(row => !attempted.includes(row.creatorRecordId)) ?? null;
    if (!target) return { status: 'complete', progress: current, attempted };
    const reply = await acquire(structuredClone(target), inspectProfileProgress(targets, current));
    if (reply?.status === 'turn_ended') {
      return { status: 'continuation_required', progress: current, attempted,
        stopReason: reply.reason ?? 'host turn ended before an acquisition result was saved' };
    }
    check(reply?.result, 'acquisition must return a saved-target result or turn_ended');
    current = recordProfileProgress(targets, current, reply.result);
    attempted.push(target.creatorRecordId);
  }
  const unfinished = nextProfileTarget(targets, current);
  return { status: unfinished ? 'continuation_required' : 'complete', progress: current, attempted,
    stopReason: unfinished ? 'bounded turn limit reached' : undefined };
}
