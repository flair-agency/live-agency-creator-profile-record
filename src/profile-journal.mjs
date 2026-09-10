import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';

// An append-only attempt journal records operator-supplied approval provenance.
// It is not itself an authenticated approval source or a global execution lock.
export async function openProfileJournal(directory, reviewSha256) {
  if (!path.isAbsolute(directory ?? '') || !/^[a-f0-9]{64}$/.test(reviewSha256 ?? '')) throw new TypeError('explicit private journal directory and review hash required');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new TypeError('journal directory must be private and owner-controlled');
  const file = path.join(directory, `${reviewSha256}.jsonl`);
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  // Persist the directory entry before any mutation can depend on this journal.
  try {
    const parent = await open(directory, constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) { await handle.close(); throw error; }
  let queue = Promise.resolve(), index = 0;
  return { file,
    append(event) {
      const record = { sequence: ++index, at: new Date().toISOString(), event: structuredClone(event) };
      queue = queue.then(async () => { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); });
      return queue;
    },
    async close() { try { await queue; } finally { await handle.close(); } },
  };
}
