#!/usr/bin/env node
import path from 'node:path';
import { isMainModule } from '@flair-agency/cli-utils/is-main';
import { readPrivateJson, writePrivateJson } from '@flair-agency/private-files';
import { prepareEnvironmentTargets, requestEnvironmentObservations,
  acceptEnvironmentObservations, prepareEnvironmentProfilePlan } from '../src/profile-environment.mjs';

export function parseArgs(argv) {
  const [operation, ...rest] = argv;
  const allowed = {
    targets: ['environment', 'generation', 'platform', 'output', 'mode', 'account', 'limit'],
    source: ['environment', 'generation', 'platform', 'output', 'targets'],
    plan: ['environment', 'generation', 'platform', 'output', 'targets', 'observations', 'handoff', 'source-result'],
  };
  if (!allowed[operation]) throw new TypeError('choose targets, source or plan; this entry has no apply operation');
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
  for (const key of ['environment', 'generation', 'output', ...(operation === 'targets' ? [] : ['targets'])]) {
    if (!args[key]) throw new TypeError(`${key} is required`);
  }
  if (!path.isAbsolute(args.environment) || !/^[a-f0-9]{64}$/.test(args.generation)) throw new TypeError('explicit environment and generation are required');
  if (operation === 'plan' && !((args.observations && !args.handoff && !args['source-result'])
    || (!args.observations && args.handoff && args['source-result']))) {
    throw new TypeError('provide normalized observations, or a handoff and its source-result');
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
    console.log(JSON.stringify({ status: result.status ?? result.result?.status ?? 'prepared',
      output: path.resolve(args.output), targetCount: result.manifest?.rowCount,
      planSha256: result.plan?.planSha256, summary: result.plan?.summary, businessWorkflowVerified: false }));
    return result.result?.status === 'failed' || result.status === 'blocked' ? 2 : 0;
  } catch (error) {
    console.error(JSON.stringify({ status: 'stopped', code: error.code ?? 'PROFILE_ENVIRONMENT_FAILED', message: error.message }));
    return 2;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
