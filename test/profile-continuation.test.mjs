import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Json, PROFILE_TARGET_INPUT_KIND } from '../src/profile-plan.mjs';
import { createProfileProgress, inspectProfileProgress } from '../src/profile-progress.mjs';
import { runProfileAcquisitionTurn } from '../src/profile-continuation.mjs';

const at = '2030-01-02T03:04:00Z';
const rows = Array.from({ length: 20 }, (_, index) => ({ creatorRecordId: `recSynthetic${String(index).padStart(3, '0')}`, accountKey: `synthetic.${index}` }));
const targets = { version: 1, selection: { generation: 'a'.repeat(64) }, manifest: { version: 2, inputKind: PROFILE_TARGET_INPUT_KIND, generatedAt: at, targetMode: 'selected', rowCount: rows.length, rows, rowsSha256: sha256Json(rows) } };
const resultFor = (row, status = 'completed') => ({ ...row, status, evidenceRefs: ['private:synthetic-evidence'], ...(status === 'completed' ? { observation: { ...row, observedAt: at, profile: { followerCount: 42, followerStatus: 'observed_exact', recentPostCount30d: null, recentPostStatus: 'not_available', latestPostAt: null, latestPostStatus: 'not_available', nickname: null, nicknameStatus: 'not_available', avatar: null, avatarStatus: 'not_available', featureObservationData: null, featureObservationStatus: 'not_available' } } } : { reason: 'synthetic target-local interruption' }) });

test('a host final-answer boundary is resumable and 20 targets eventually complete without duplicates', async () => {
  let progress = createProfileProgress(targets);
  const saved = new Map();
  const events = [];
  const attemptedAfterPartial = [];
  let turn = 0;
  while (true) {
    turn++;
    const run = await runProfileAcquisitionTurn({ targets, progress, maxTargets: 4, acquire: async row => {
      // This models a host that emits final_answer then task_complete before
      // target 3 can be saved. It is deliberately a fixture, not a live LLM.
      if (turn === 1 && row.creatorRecordId === rows[2].creatorRecordId) {
        events.push('final_answer', 'task_complete');
        return { status: 'turn_ended', reason: 'synthetic host final answer' };
      }
      // A target-local partial result is retained, then replaced by the later
      // final observation instead of blocking unrelated targets.
      if (turn === 2 && row.creatorRecordId === rows[4].creatorRecordId) return { result: resultFor(row, 'partial') };
      if (turn === 2) attemptedAfterPartial.push(row.creatorRecordId);
      const result = resultFor(row);
      saved.set(row.creatorRecordId, (saved.get(row.creatorRecordId) ?? 0) + 1);
      return { result };
    } });
    progress = run.progress;
    if (run.status === 'complete') break;
    assert.ok(turn < 12, 'controller must not loop indefinitely');
  }
  assert.deepEqual(events, ['final_answer', 'task_complete']);
  assert.deepEqual(inspectProfileProgress(targets, progress).counts, { total: 20, completed: 20, partial: 0, blocked: 0, pending: 0 });
  assert.equal(saved.size, 20);
  assert.ok([...saved.values()].every(count => count === 1), 'completed targets are not reacquired');
  assert.ok(attemptedAfterPartial.includes(rows[5].creatorRecordId), 'a partial target does not block another target in the same bounded turn');
});

test('instruction-only variants cannot change a host turn-ended signal in the continuation contract', async () => {
  const instructions = [
    'Save one target, then report progress.',
    'Do not return a final answer until all targets are saved; continue after each target.',
  ];
  for (const instruction of instructions) {
    const run = await runProfileAcquisitionTurn({
      targets,
      progress: createProfileProgress(targets),
      // The fixture receives the text to make the compared condition explicit,
      // but the host boundary is outside the Skill and remains authoritative.
      acquire: async () => ({ status: 'turn_ended', reason: `synthetic final answer under: ${instruction}` }),
    });
    assert.equal(run.status, 'continuation_required');
    assert.deepEqual(inspectProfileProgress(targets, run.progress).counts, { total: 20, completed: 0, partial: 0, blocked: 0, pending: 20 });
  }
});
