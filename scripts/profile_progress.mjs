#!/usr/bin/env node
import path from 'node:path';
import { constants } from 'node:fs';
import { open, lstat, unlink } from 'node:fs/promises';
import { isMainModule } from '@flair-agency/cli-utils/is-main';
import { readPrivateJson, writePrivateJson } from '@flair-agency/private-files';
import { createProfileProgress, inspectProfileProgress, recordProfileProgress, assembleProfileObservations } from '../src/profile-progress.mjs';

// Local preparation only: no Runtime resolution, source access or destination writes.
export async function runProgress(argv) {
  const [operation, targetsFile, progressFile, resultFile] = argv;
  if (argv.length > 4) throw new TypeError('too many arguments');
  if (!['init', 'record', 'status', 'assemble'].includes(operation) || !targetsFile || !progressFile
    || (['record', 'assemble'].includes(operation) !== Boolean(resultFile))) throw new TypeError('usage: init|status TARGETS PROGRESS; record TARGETS PROGRESS RESULT; assemble TARGETS PROGRESS OUTPUT');
  const targets = await readPrivateJson(targetsFile);
  const directory = path.dirname(path.resolve(progressFile));
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new TypeError('progress directory must be private and owner-controlled');
  const lockFile = `${progressFile}.lock`;
  const lock = await open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let progress;
    if (operation === 'init') {
      try { await lstat(progressFile); throw new TypeError('progress already exists; use status'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      progress = createProfileProgress(targets);
    } else progress = await readPrivateJson(progressFile);
    if (operation === 'record') progress = recordProfileProgress(targets, progress, await readPrivateJson(resultFile));
    let summary = inspectProfileProgress(targets, progress);
    if (operation === 'init' || operation === 'record') {
      await writePrivateJson(progressFile, progress);
      const parent = await open(directory, constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
      summary = inspectProfileProgress(targets, await readPrivateJson(progressFile));
    }
    if (operation === 'assemble') {
      if ([targetsFile, progressFile, lockFile].some(file => path.resolve(file) === path.resolve(resultFile))) throw new TypeError('output must not overwrite inputs');
      await writePrivateJson(resultFile, assembleProfileObservations(targets, progress));
    }
    return summary;
  } finally { await lock.close(); await unlink(lockFile); }
}

if (isMainModule(import.meta.url)) {
  try { console.log(JSON.stringify(await runProgress(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ status: 'stopped', message: error.message })); process.exitCode = 2; }
}
