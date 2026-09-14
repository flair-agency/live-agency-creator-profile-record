import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runHostStage } from './support/profile-host-comparison.mjs';

for (const stage of ['S1', 'S2', 'S3', 'S4']) test(`${stage} staged harness completes with durable readback`, async () => {
  const directory = await mkdtemp(`${tmpdir()}/profile-host-stage-`);
  try {
    let result = await runHostStage(['stage-init', directory, stage]);
    assert.equal(result.savedCount, 0);
    while (result.terminal !== 'complete') result = await runHostStage(['stage-step', directory]);
    assert.equal(result.savedCount, 20);
    assert.equal(result.pendingCount, 0);
    assert.equal(result.partialCount, stage === 'S1' ? 0 : 1);
    assert.equal(result.stepCount, stage === 'S1' ? 20 : 21);
    assert.equal(new Set(result.completedIds).size, 20);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
