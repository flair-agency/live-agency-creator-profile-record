import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openProfileJournal } from '../src/profile-journal.mjs';

test('private attempt evidence survives close and cannot be overwritten by a replay', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'profile-journal-'));
  try {
    const journal = await openProfileJournal(directory, 'a'.repeat(64));
    await Promise.all([journal.append({ stage: 'approval-confirmed', reference: 'synthetic-only' }),
      journal.append({ stage: 'unresolved' })]);
    await journal.close();
    const bytes = await readFile(journal.file, 'utf8');
    const entries = bytes.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(entries.map(entry => [entry.sequence, entry.event.stage]), [[1, 'approval-confirmed'], [2, 'unresolved']]);
    assert.equal((await stat(journal.file)).mode & 0o777, 0o600);
    await assert.rejects(openProfileJournal(directory, 'a'.repeat(64)), { code: 'EEXIST' });
    assert.equal(await readFile(journal.file, 'utf8'), bytes);
    await chmod(directory, 0o755);
    await assert.rejects(openProfileJournal(directory, 'b'.repeat(64)), /private and owner-controlled/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
