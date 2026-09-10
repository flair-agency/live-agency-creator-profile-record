#!/usr/bin/env node
import path from 'node:path';
import { isMainModule } from '@flair-agency/cli-utils/is-main';
import { readPrivateJson, writePrivateJson } from '@flair-agency/private-files';
import { prepareEnvironmentTargets, requestEnvironmentObservations,
  acceptEnvironmentObservations, prepareEnvironmentProfilePlan } from '../src/profile-environment.mjs';
import { prepareEnvironmentProfileWrite, applyEnvironmentProfileWrite,
  verifyEnvironmentProfileWrite } from '../src/profile-execution.mjs';
import { openProfileJournal } from '../src/profile-journal.mjs';

export function parseArgs(argv) {
  const [operation, ...rest] = argv;
  const allowed = {
    targets: ['environment', 'generation', 'platform', 'output', 'mode', 'account', 'limit'],
    source: ['environment', 'generation', 'platform', 'output', 'targets'],
    plan: ['environment', 'generation', 'platform', 'output', 'targets', 'observations', 'handoff', 'source-result'],
    'prepare-write': ['environment', 'generation', 'platform', 'output', 'plan'],
    apply: ['environment', 'generation', 'platform', 'output', 'review', 'expect-sha256',
      'confirm-profile-create', 'confirm-profile-attach', 'approval-ref', 'journal-directory'],
    verify: ['environment', 'generation', 'platform', 'output', 'review'],
  };
  if (!allowed[operation]) throw new TypeError('choose targets, source, plan, prepare-write, apply or verify');
  const args = { operation, accounts: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || !allowed[operation].includes(name) || !rest[i + 1] || rest[i + 1].startsWith('--')) {
      throw new TypeError(`invalid option: ${rest[i]}`);
    }
    if (name === 'account') args.accounts.push(rest[i + 1]);
    else {
      if (Object.hasOwn(args, name)) throw new TypeError(`duplicate option: ${name}`);
      args[name] = rest[i + 1];
    }
  }
  const required = { targets: [], source: ['targets'], plan: ['targets'], 'prepare-write': ['plan'],
    apply: ['review', 'expect-sha256', 'confirm-profile-create', 'confirm-profile-attach', 'approval-ref', 'journal-directory'],
    verify: ['review'] };
  for (const key of ['environment', 'generation', 'output', ...required[operation]]) {
    if (!args[key]) throw new TypeError(`${key} is required`);
  }
  if (!path.isAbsolute(args.environment) || !/^[a-f0-9]{64}$/.test(args.generation)) throw new TypeError('explicit environment and generation are required');
  if (operation === 'plan' && !((args.observations && !args.handoff && !args['source-result'])
    || (!args.observations && args.handoff && args['source-result']))) {
    throw new TypeError('provide normalized observations, or a handoff and its source-result');
  }
  if (operation === 'apply') {
    if (!/^[a-f0-9]{64}$/.test(args['expect-sha256']) || !args['approval-ref'].trim()
      || !path.isAbsolute(args['journal-directory'])) throw new TypeError('exact plan hash, actual approval reference and absolute journal directory required');
    for (const key of ['confirm-profile-create', 'confirm-profile-attach']) {
      if (!/^(0|[1-9][0-9]*)$/.test(args[key]) || !Number.isSafeInteger(Number(args[key]))) throw new TypeError(`${key} must be a nonnegative integer`);
    }
  }
  return args;
}

export async function run(args, { createAccess } = {}) {
  // Resolve the generic Runtime API only. It verifies that its installation matches
  // the saved environment; the Skill never loads a concrete Provider package.
  if (!createAccess) ({ createEnvironmentAccess: createAccess } = await import('@flair-agency/live-agency-runtime/environment'));
  const access = await createAccess(args.environment, { platform: args.platform, expectedGeneration: args.generation });
  let result;
  if (args.operation === 'targets') result = await prepareEnvironmentTargets({ access,
    mode: args.mode ?? 'due', selectedAccounts: args.accounts, limit: args.limit === undefined ? 20 : Number(args.limit) });
  else if (args.operation === 'prepare-write') result = await prepareEnvironmentProfileWrite({ access,
    planningReceipt: await readPrivateJson(args.plan) });
  else if (args.operation === 'verify') result = await verifyEnvironmentProfileWrite({ access,
    review: await readPrivateJson(args.review) });
  else if (args.operation === 'apply') {
    const review = await readPrivateJson(args.review);
    const approval = { planSha256: args['expect-sha256'], createCount: Number(args['confirm-profile-create']),
      attachCount: Number(args['confirm-profile-attach']), reference: args['approval-ref'] };
    const journal = await openProfileJournal(args['journal-directory'], review.reviewSha256);
    let stopped;
    try {
      // This operator command asserts a previously obtained owner approval.
      // Neither the argument values nor the journal authenticate that approval.
      result = await applyEnvironmentProfileWrite({ access, review, approval,
        authorize: async (candidate, record) => candidate.reviewSha256 === review.reviewSha256
          && record.reference === approval.reference,
        onEvent: journal.append });
      result = { ...result, journal: journal.file };
    } catch (error) {
      stopped = error;
      // A failed sink must not replace the original write-outcome classification.
      try { await journal.append({ stage: 'stopped', code: error.code ?? 'PROFILE_EXECUTION_STOPPED', uncertainWrite: error.uncertainWrite === true }); }
      catch { /* Preserve the incomplete journal and the original error. */ }
      throw error;
    } finally {
      try { await journal.close(); }
      catch (error) {
        if (!stopped) throw Object.assign(new Error('journal finalization failed; verify without resending'),
          { code: 'PROFILE_JOURNAL_INCOMPLETE', uncertainWrite: true, cause: error });
      }
    }
  }
  else {
    const targets = await readPrivateJson(args.targets);
    if (args.operation === 'source') result = await requestEnvironmentObservations({ access, targets });
    else {
      const observations = args.observations ? await readPrivateJson(args.observations)
        : await acceptEnvironmentObservations({ access, targets, handoff: await readPrivateJson(args.handoff),
          result: await readPrivateJson(args['source-result']) });
      result = await prepareEnvironmentProfilePlan({ access, targets, observations });
    }
  }
  await writePrivateJson(args.output, result);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const result = await run(args);
    const plan = result.plan ?? result.planningReceipt?.plan;
    console.log(JSON.stringify({ status: result.status ?? result.result?.status ?? 'prepared',
      output: path.resolve(args.output), targetCount: result.manifest?.rowCount,
      planSha256: result.planSha256 ?? plan?.planSha256, summary: plan?.summary,
      reviewSha256: result.reviewSha256, journal: result.journal, businessWorkflowVerified: result.businessWorkflowVerified === true }));
    return result.result?.status === 'failed' || ['blocked', 'unresolved'].includes(result.status) ? 2 : 0;
  } catch (error) {
    console.error(JSON.stringify({ status: 'stopped', code: error.code ?? 'PROFILE_ENVIRONMENT_FAILED',
      message: error.message, uncertainWrite: error.uncertainWrite === true,
      ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode, details: error.details }) }));
    return 2;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
