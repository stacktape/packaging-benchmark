/**
 * SST measurements of the real-application fixtures. They deploy to AWS: run only with
 * BENCH_ALLOW_SST_AWS_BOOTSTRAP=1 and BENCH_EXPECTED_ACCOUNT set to the account the credentials must resolve to.
 *
 * SST has no packaging command, and `sst diff` builds function bundles only for a stage that exists. Per fixture:
 *
 *   state file entry -> sst deploy (untimed) -> sst diff: 1 discarded, 5 cold (.sst/artifacts deleted first),
 *   5 after a one-line change (edit applied and reverted in turn) -> finally: sst remove, the stage's passphrase
 *   parameter deleted, and AWS queried until nothing tagged with the app and stage remains.
 *
 * A Next.js site is built by `sst diff` even for a stage that was never deployed, so that fixture is measured without
 * deploying anything. On first use SST bootstraps the region (two buckets, an ECR repository, an SSM parameter); when
 * this runner created that bootstrap, `--cleanup-bootstrap` removes it and checks it is gone. Every creation and removal
 * is recorded in `tmp/sst-apps-state.json` before and after it happens; `--cleanup-only` removes whatever the state
 * file still lists.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppFixture } from '../../fixtures/apps.ts';
import { diffArtifacts, summarizeArtifacts } from './apps.ts';
import { type Artifact, exists, measureDirectory, median, removePaths, runOnce } from './measure.ts';
import { newStageName } from './sst.ts';

const REGION = 'eu-west-1';
const PROFILE = process.env.BENCH_AWS_PROFILE ?? 'default';

type StageEntry = {
  fixture: string;
  app: string;
  stage: string;
  status: 'deploying' | 'deployed' | 'diff-only' | 'removing' | 'removed' | 'remove-failed';
  verifiedGone?: boolean;
  events: { at: string; what: string }[];
};
type State = { region: string; bootstrapExistedBefore: boolean | null; bootstrapRemoved?: boolean; stages: StageEntry[] };

const aws = (args: string[]) =>
  runOnce({ command: 'aws', args: [...args, '--profile', PROFILE, '--region', REGION, '--output', 'json'], cwd: process.cwd(), timeoutMs: 300000 });

export const checkAccount = () => {
  const expected = process.env.BENCH_EXPECTED_ACCOUNT;
  if (!expected) throw new Error('Set BENCH_EXPECTED_ACCOUNT to the account these credentials must resolve to.');
  const identity = aws(['sts', 'get-caller-identity']);
  const account = identity.exitCode === 0 ? JSON.parse(identity.stdout).Account : null;
  if (account !== expected) throw new Error('The AWS credentials resolve to another account than BENCH_EXPECTED_ACCOUNT; nothing was created.');
};

export const loadState = (path: string): State =>
  exists(path) ? JSON.parse(readFileSync(path, 'utf8')) : { region: REGION, bootstrapExistedBefore: null, stages: [] };
const saveState = (path: string, state: State) => writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);

const sstApp = (dir: string) => readFileSync(join(dir, 'sst.config.ts'), 'utf8').match(/name: '([^']+)'/)?.[1] ?? '';

const sst = (dir: string, args: string[], timeoutMs = 15 * 60 * 1000) =>
  runOnce({
    command: join(dir, 'node_modules', '.bin', 'sst'),
    args,
    cwd: dir,
    env: { AWS_PROFILE: PROFILE, AWS_REGION: REGION },
    timeoutMs
  });

/** Nothing tagged with this app and stage is left, and the stage's passphrase parameter is gone. */
const verifyGone = (app: string, stage: string) => {
  const tagged = aws([
    'resourcegroupstaggingapi', 'get-resources',
    '--tag-filters', `Key=sst:app,Values=${app}`, `Key=sst:stage,Values=${stage}`
  ]);
  const left = tagged.exitCode === 0 ? JSON.parse(tagged.stdout).ResourceTagMappingList.length : null;
  const passphrase = aws(['ssm', 'get-parameter', '--name', `/sst/passphrase/${app}/${stage}`]);
  return { taggedResourcesLeft: left, passphraseLeft: passphrase.exitCode === 0 };
};

const removeStage = (dir: string, entry: StageEntry, state: State, statePath: string) => {
  const event = (what: string) => {
    entry.events.push({ at: new Date().toISOString(), what });
    saveState(statePath, state);
  };
  if (entry.status === 'deployed' || entry.status === 'deploying' || entry.status === 'remove-failed') {
    entry.status = 'removing';
    event('sst remove started');
    const removed = sst(dir, ['remove', '--stage', entry.stage]);
    event(`sst remove exit ${removed.exitCode} in ${Math.round(removed.wallMs)} ms`);
    if (removed.exitCode !== 0) {
      entry.status = 'remove-failed';
      event((removed.stderr || removed.stdout).slice(-800));
      return false;
    }
  }
  aws(['ssm', 'delete-parameter', '--name', `/sst/passphrase/${entry.app}/${entry.stage}`]);
  let check = verifyGone(entry.app, entry.stage);
  for (let attempt = 0; attempt < 6 && (check.taggedResourcesLeft ?? 1) > 0; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
    check = verifyGone(entry.app, entry.stage);
  }
  entry.status = 'removed';
  entry.verifiedGone = check.taggedResourcesLeft === 0 && !check.passphraseLeft;
  event(`verified: ${check.taggedResourcesLeft} tagged resources left, passphrase parameter ${check.passphraseLeft ? 'left' : 'gone'}`);
  return entry.verifiedGone;
};

/** Every function SST built: the contents of `code.zip`, and the source map SST uploads to its own bucket. */
const collectFunctions = (dir: string, tmpDir: string): Artifact[] => {
  const root = join(dir, '.sst', 'artifacts');
  if (!exists(root)) return [];
  const out: Artifact[] = [];
  for (const name of (JSON.parse(JSON.stringify(require_('fs').readdirSync(root))) as string[]).filter((n) => !n.endsWith('-src'))) {
    const zip = join(root, name, 'code.zip');
    if (!exists(zip)) continue;
    const target = join(tmpDir, 'sst-unzip', `${Date.now()}-${name}`);
    runOnce({ command: 'mkdir', args: ['-p', target], cwd: dir });
    runOnce({ command: 'unzip', args: ['-q', '-o', zip, '-d', target], cwd: dir });
    const measured = measureDirectory({ root: target, name, kind: 'function', toolZipBytes: require_('fs').statSync(zip).size });
    const shipsMap = require_('fs').readdirSync(target, { recursive: true }).some((f: string) => String(f).endsWith('.map'));
    removePaths([target]);
    out.push(measured);
    const map = join(root, `${name}-src`, 'bundle.mjs.map');
    if (!shipsMap && exists(map)) {
      const bytes = require_('fs').statSync(map).size;
      out.push({ ...measureDirectory({ root: join(root, `${name}-src`), name: `${name} source map`, kind: 'asset', exclude: require_('fs').readdirSync(join(root, `${name}-src`)).filter((f: string) => !f.endsWith('.map')) }), toolZipBytes: bytes });
    }
  }
  return out;
};

/** A Next.js site: what `.open-next/` holds for the functions and the bucket. */
const collectOpenNext = (dir: string): Artifact[] => {
  const root = join(dir, '.open-next');
  if (!exists(root)) return [];
  const out: Artifact[] = [];
  const fs = require_('fs');
  for (const fn of fs.readdirSync(join(root, 'server-functions'))) out.push(measureDirectory({ root: join(root, 'server-functions', fn), name: `server-functions/${fn}`, kind: 'function' }));
  for (const fn of ['image-optimization-function', 'revalidation-function']) {
    if (exists(join(root, fn))) out.push(measureDirectory({ root: join(root, fn), name: fn, kind: 'function' }));
  }
  for (const bucket of ['assets', 'cache']) if (exists(join(root, bucket))) out.push(measureDirectory({ root: join(root, bucket), name: bucket, kind: 'asset' }));
  return out;
};

import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

export const runSstApp = ({
  fixture,
  dir,
  samples,
  tmpDir,
  statePath,
  log,
  load1m
}: {
  fixture: AppFixture;
  dir: string;
  samples: number;
  tmpDir: string;
  statePath: string;
  log: (message: string) => void;
  load1m: () => number;
}) => {
  const state = loadState(statePath);
  if (state.bootstrapExistedBefore === null) {
    state.bootstrapExistedBefore = aws(['ssm', 'get-parameter', '--name', '/sst/bootstrap']).exitCode === 0;
    saveState(statePath, state);
  }
  const nextjs = exists(join(dir, 'next.config.ts'));
  const entry: StageEntry = { fixture: fixture.id, app: sstApp(dir), stage: newStageName(), status: nextjs ? 'diff-only' : 'deploying', events: [] };
  state.stages.push(entry);
  entry.events.push({ at: new Date().toISOString(), what: nextjs ? 'diff only, nothing deployed' : 'sst deploy started' });
  saveState(statePath, state);
  const started = performance.now();
  const result: Record<string, unknown> = { fixture: fixture.id, tool: 'sst', app: entry.app, stage: entry.stage, deployed: !nextjs, load1mBefore: load1m() };
  const collect = () => (nextjs ? collectOpenNext(dir) : collectFunctions(dir, tmpDir));
  const clean = () => removePaths([join(dir, '.sst', 'artifacts'), join(dir, '.open-next')]);
  try {
    if (!nextjs) {
      const deploy = sst(dir, ['deploy', '--stage', entry.stage]);
      entry.events.push({ at: new Date().toISOString(), what: `sst deploy exit ${deploy.exitCode} in ${Math.round(deploy.wallMs)} ms` });
      entry.status = 'deployed';
      saveState(statePath, state);
      result.deployMs = Math.round(deploy.wallMs);
      if (deploy.exitCode !== 0) throw new Error(`sst deploy failed: ${(deploy.stderr || deploy.stdout).slice(-1500)}`);
    }
    const diff = () => sst(dir, ['diff', '--stage', entry.stage], 20 * 60 * 1000);
    clean();
    diff();
    const cold: number[] = [];
    let artifacts: Artifact[] = [];
    for (let index = 0; index < samples; index += 1) {
      clean();
      const run = diff();
      if (run.exitCode !== 0) throw new Error(`sst diff failed: ${(run.stderr || run.stdout).slice(-1500)}`);
      cold.push(Math.round(run.wallMs));
      artifacts = collect();
    }
    const file = join(dir, fixture.edit.file);
    const original = readFileSync(file, 'utf8');
    const edited = original.replace(fixture.edit.from, fixture.edit.to);
    const editSamples: number[] = [];
    const changes: ReturnType<typeof diffArtifacts>[] = [];
    let previous = artifacts;
    try {
      for (let index = 0; index < samples; index += 1) {
        writeFileSync(file, index % 2 === 0 ? edited : original);
        const run = diff();
        if (run.exitCode !== 0) throw new Error(`sst diff failed: ${(run.stderr || run.stdout).slice(-1500)}`);
        editSamples.push(Math.round(run.wallMs));
        const now = collect();
        changes.push(diffArtifacts(previous, now));
        previous = now;
      }
    } finally {
      writeFileSync(file, original);
    }
    Object.assign(result, {
      ok: true,
      cold: { samples: cold, medianMs: Math.round(median(cold)) },
      edit: { samples: editSamples, medianMs: Math.round(median(editSamples)), changes },
      artifacts,
      totals: summarizeArtifacts(artifacts)
    });
  } catch (error) {
    result.ok = false;
    result.error = String(error instanceof Error ? error.message : error).slice(-2000);
  } finally {
    const gone = removeStage(dir, entry, state, statePath);
    result.cleanup = { status: entry.status, verifiedGone: gone, events: entry.events };
    result.awsMs = Math.round(performance.now() - started);
    result.load1mAfter = load1m();
    log(`sst ${fixture.id}: stage ${entry.stage} ${entry.status}, verified gone: ${gone}`);
  }
  return result;
};

/** Removes the region's SST bootstrap when this runner created it, and checks that it is gone. */
export const removeBootstrap = (statePath: string, log: (message: string) => void) => {
  const state = loadState(statePath);
  if (state.bootstrapExistedBefore !== false) return { removed: false, reason: 'the bootstrap existed before, or was never checked' };
  const parameter = aws(['ssm', 'get-parameter', '--name', '/sst/bootstrap']);
  if (parameter.exitCode !== 0) return { removed: true, reason: 'no bootstrap parameter' };
  const value = JSON.parse(JSON.parse(parameter.stdout).Parameter.Value) as Record<string, unknown>;
  const buckets = Object.values(value).filter((v): v is string => typeof v === 'string' && /^sst-(asset|state)-/.test(v));
  for (const bucket of buckets) {
    // Versioned buckets keep deleted objects, so every version and delete marker goes first.
    for (let page = 0; page < 50; page += 1) {
      const listing = runOnce({ command: 'aws', args: ['s3api', 'list-object-versions', '--bucket', bucket, '--profile', PROFILE, '--region', REGION, '--output', 'json', '--max-items', '500'], cwd: process.cwd() });
      const parsed = listing.exitCode === 0 && listing.stdout.trim() ? JSON.parse(listing.stdout) : {};
      const objects = [...(parsed.Versions ?? []), ...(parsed.DeleteMarkers ?? [])].map((o: { Key: string; VersionId: string }) => ({ Key: o.Key, VersionId: o.VersionId }));
      if (!objects.length) break;
      runOnce({ command: 'aws', args: ['s3api', 'delete-objects', '--bucket', bucket, '--delete', JSON.stringify({ Objects: objects, Quiet: true }), '--profile', PROFILE, '--region', REGION], cwd: process.cwd() });
    }
    aws(['s3api', 'delete-bucket', '--bucket', bucket]);
  }
  aws(['ecr', 'delete-repository', '--repository-name', 'sst-asset', '--force']);
  aws(['ssm', 'delete-parameter', '--name', '/sst/bootstrap']);
  const bucketsLeft = buckets.filter((bucket) => aws(['s3api', 'head-bucket', '--bucket', bucket]).exitCode === 0);
  const repoLeft = aws(['ecr', 'describe-repositories', '--repository-names', 'sst-asset']).exitCode === 0;
  const parameterLeft = aws(['ssm', 'get-parameter', '--name', '/sst/bootstrap']).exitCode === 0;
  state.bootstrapRemoved = !bucketsLeft.length && !repoLeft && !parameterLeft;
  saveState(statePath, state);
  log(`sst bootstrap: ${buckets.length} buckets, removed: ${state.bootstrapRemoved}`);
  return { removed: state.bootstrapRemoved, buckets: buckets.length, bucketsLeft: bucketsLeft.length, repoLeft, parameterLeft };
};

/** Removes every stage the state file still lists as not removed. */
export const cleanupOnly = (statePath: string, dirFor: (fixture: string) => string, log: (message: string) => void) => {
  const state = loadState(statePath);
  for (const entry of state.stages.filter((s) => s.status !== 'removed')) removeStage(dirFor(entry.fixture), entry, state, statePath);
  log(`cleanup-only: ${state.stages.filter((s) => s.status !== 'removed').length} stages still not removed`);
};
