import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runHostComparison } from './support/profile-host-comparison.mjs';

test('fixed four-batch harness preserves the 20-row fixture and rejects repeated batches', async () => {
  const directory = await mkdtemp(`${tmpdir()}/profile-host-comparison-`);
  try {
    let state = await runHostComparison(['init', directory]);
    assert.deepEqual({ saved: state.savedCount, pending: state.pendingCount, terminal: state.terminal }, { saved: 0, pending: 20, terminal: 'continuation_required' });
    for (const batch of [0, 1, 2, 3]) state = await runHostComparison(['batch', directory, String(batch)]);
    assert.deepEqual({ saved: state.savedCount, pending: state.pendingCount, terminal: state.terminal }, { saved: 20, pending: 0, terminal: 'complete' });
    assert.equal(new Set(state.completedIds).size, 20);
    await assert.rejects(() => runHostComparison(['batch', directory, '3']));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
