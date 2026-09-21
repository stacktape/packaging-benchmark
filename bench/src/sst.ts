/**
 * SST needs a deployed stage before it will build function bundles at all, so it cannot be measured
 * the way the other tools are. This module runs the only sequence that produces numbers:
 *
 *   deploy a throwaway stage -> time the rebuild command 5x -> read the artifacts -> remove the stage
 *
 * It creates real AWS resources. It runs only when BENCH_ALLOW_SST_AWS_BOOTSTRAP=1 is set, one shape
 * at a time, and it removes each stage before starting the next. Every resource it creates and every
 * removal it performs is recorded in the result so the list can be checked against the account.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Artifact, exists, measureDirectory, median, removePaths, runOnce, walkFiles } from './measure.ts';
import type { ConfigName, ToolContext } from './tools.ts';

const DEPLOY_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Which command is timed as SST's closest analogue of "package".
 *
 * `diff` rebuilds the bundles and runs a Pulumi preview. `deploy` rebuilds them and runs a no-op
 * update. Neither is a pure package step; `diff` is the closer of the two, so it is the default.
 */
const TIMED_COMMAND = process.env.BENCH_SST_COMMAND === 'deploy' ? 'deploy' : 'diff';

export const newStageName = () => `bench-${randomBytes(4).toString('hex').slice(0, 6)}`;

const sstCommand = (dir: string, ctx: ToolContext, args: string[], config: ConfigName) => ({
  command: join(dir, 'node_modules', '.bin', 'sst'),
  args,
  cwd: dir,
  env: { BENCH_CONFIG: config, AWS_PROFILE: ctx.awsProfile, AWS_REGION: ctx.awsRegion },
  timeoutMs: DEPLOY_TIMEOUT_MS
});

/**
 * SST writes two directories per function: `<name>/code.zip`, which is what it deploys, and
 * `<name>-src/`, which holds the raw bundle and, whatever `sourcemap` is set to, a source map. Only
 * the zip reaches Lambda, so the zip's contents are what gets measured - unpacked first, so SST is
 * treated exactly like every other tool. The `-src` file list is recorded alongside as build output,
 * not as an artifact.
 */
const collectArtifacts = (dir: string, tmpDir: string): Artifact[] => {
  const artifactsDir = join(dir, '.sst', 'artifacts');
  if (!exists(artifactsDir)) return [];
  const out: Artifact[] = [];
  const entries = readdirSync(artifactsDir, { withFileTypes: true }).filter((e) => e.isDirectory());

  for (const entry of entries) {
    const root = join(artifactsDir, entry.name);
    const zipPath = join(root, 'code.zip');
    if (!exists(zipPath)) continue;

    const target = join(tmpDir, 'sst-unzip', `${Date.now()}-${entry.name}`);
    mkdirSync(target, { recursive: true });
    const unzip = runOnce({ command: 'unzip', args: ['-q', '-o', zipPath, '-d', target], cwd: dir });
    if (unzip.exitCode !== 0) continue;

    const srcDir = join(artifactsDir, `${entry.name}-src`);
    out.push({
      ...measureDirectory({
        root: target,
        name: entry.name,
        kind: 'function',
        toolZipBytes: statSync(zipPath).size
      }),
      deployedFiles: walkFiles(target).map((f) => ({ path: f.path, bytes: f.bytes })),
      buildOutputFiles: exists(srcDir) ? walkFiles(srcDir).map((f) => ({ path: f.path, bytes: f.bytes })) : []
    } as Artifact);
    removePaths([target]);
  }
  return out;
};

export const runSstBenchmark = ({
  generatedDir,
  shapes,
  ctx,
  samples,
  tmpDir,
  log
}: {
  generatedDir: string;
  shapes: { id: string; functions: number; kind: string }[];
  ctx: ToolContext;
  samples: number;
  tmpDir: string;
  log: (message: string) => void;
}) => {
  const measurements: Record<string, unknown>[] = [];
  const resourceLog: { action: 'created' | 'removed' | 'failed'; what: string; detail?: string }[] = [];

  for (const shape of shapes) {
    const dir = join(generatedDir, shape.id, 'sst');
    if (!exists(join(dir, 'node_modules'))) {
      log(`sst ${shape.id}: not installed, skipped`);
      continue;
    }

    const stage = newStageName();
    log(`sst ${shape.id}: stage ${stage}`);
    let stageDeployed = false;

    try {
      for (const config of ['likeforlike', 'defaults'] as ConfigName[]) {
        removePaths([join(dir, '.sst', 'artifacts')]);

        const deploy = runOnce(sstCommand(dir, ctx, ['deploy', '--stage', stage], config));
        if (deploy.exitCode !== 0) {
          measurements.push({
            shape: shape.id,
            functions: shape.functions,
            tool: 'sst',
            config,
            stage,
            ok: false,
            error: (deploy.stderr || deploy.stdout).slice(-2000)
          });
          log(`sst ${shape.id} ${config}: deploy FAILED`);
          if (!stageDeployed) break;
          continue;
        }
        stageDeployed = true;
        resourceLog.push({
          action: 'created',
          what: `SST stage ${stage} of app pkgbench, shape ${shape.id}, configuration ${config}`,
          detail: `${shape.functions} Lambda functions with their IAM roles and log groups`
        });

        // What is timed: `sst diff` against a stage that already exists. It rebuilds every function
        // bundle and then runs a Pulumi preview over the deployed state. It is therefore NOT a pure
        // package step - it includes a preview that talks to AWS - and the README says so.
        const timings: number[] = [];
        let lastArtifacts: Artifact[] = [];
        runOnce(sstCommand(dir, ctx, [TIMED_COMMAND, '--stage', stage], config)); // discarded warm-up
        for (let i = 0; i < samples; i += 1) {
          removePaths([join(dir, '.sst', 'artifacts')]);
          const run = runOnce(sstCommand(dir, ctx, [TIMED_COMMAND, '--stage', stage], config));
          if (run.exitCode !== 0) {
            log(`sst ${shape.id} ${config}: diff FAILED on sample ${i + 1}`);
            break;
          }
          timings.push(run.wallMs);
          if (i === samples - 1) lastArtifacts = collectArtifacts(dir, tmpDir);
        }

        measurements.push({
          shape: shape.id,
          functions: shape.functions,
          shapeKind: shape.kind,
          tool: 'sst',
          config,
          stage,
          ok: timings.length > 0,
          command: `sst ${TIMED_COMMAND} --stage ${stage}  (BENCH_CONFIG=${config})`,
          whatIsTimed:
            TIMED_COMMAND === 'diff'
              ? 'A rebuild of every function bundle followed by a Pulumi preview against the deployed ' +
                'stage. Not a pure package step: the preview contacts AWS.'
              : 'A rebuild of every function bundle followed by a no-op Pulumi update against the ' +
                'deployed stage. Not a pure package step: it contacts AWS.',
          deployMs: Math.round(deploy.wallMs),
          samples: timings.map((t) => Math.round(t)),
          medianMs: timings.length ? Math.round(median(timings)) : null,
          artifacts: lastArtifacts,
          artifactsFound: lastArtifacts.length
        });
        log(
          `sst ${shape.id} ${config}: deploy ${Math.round(deploy.wallMs)}ms, diff median ` +
            `${timings.length ? Math.round(median(timings)) : '-'}ms, ${lastArtifacts.length} artifacts`
        );
      }
    } finally {
      if (stageDeployed) {
        const remove = runOnce(sstCommand(dir, ctx, ['remove', '--stage', stage], 'likeforlike'));
        resourceLog.push({
          action: remove.exitCode === 0 ? 'removed' : 'failed',
          what: `SST stage ${stage} of app pkgbench, shape ${shape.id}`,
          detail: remove.exitCode === 0 ? 'sst remove reported success' : (remove.stderr || remove.stdout).slice(-2000)
        });
        log(`sst ${shape.id}: remove exit ${remove.exitCode}`);
        if (remove.exitCode !== 0) {
          log('sst remove FAILED - stopping so the leftover resources can be reported rather than guessed at');
          break;
        }
      }
    }
  }

  return { measurements, resourceLog };
};
