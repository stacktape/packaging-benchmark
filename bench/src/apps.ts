/**
 * Real-application measurements, for every fixture in `fixtures/apps/` and every tool that packages locally
 * (Stacktape, AWS CDK, Serverless Framework; SST needs a deployed stage, see `sst-apps.ts`):
 *
 * - **Cold package.** One discarded run, then BENCH_SAMPLES runs, each after the tool's build output and caches in
 *   the project were deleted.
 * - **Package after a one-line change.** One untimed package, then BENCH_SAMPLES timed packages. Before each one the
 *   fixture's one-line edit is applied or reverted in turn, so every timed package follows exactly one changed line
 *   with the tool's caches warm, as in a developer's edit-package loop. The artifacts are compared with the previous
 *   package's by content hash, which gives the bytes a redeploy would upload again.
 * - **First-deploy upload bytes.** The distinct artifacts of the last cold package, each zipped deterministically.
 *
 * Before each fixture and tool, the runner waits while the one-minute load average is above BENCH_MAX_LOAD.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppFixture } from '../../fixtures/apps.ts';
import { type Artifact, exists, median, printableCommand, runOnce } from './measure.ts';
import type { ToolAdapter } from './tools.ts';

export type AppMeasurement = {
  fixture: string;
  tool: string;
  ok: boolean;
  error: string | null;
  command: string;
  cold: { samples: number[]; medianMs: number | null } | null;
  edit: {
    samples: number[];
    medianMs: number | null;
    /** Per timed package: how many artifacts changed and the zipped bytes a redeploy would upload again. */
    changes: { changedCount: number; totalCount: number; changedZippedBytes: number; changedNames: string[] }[];
  } | null;
  artifacts: Artifact[];
  totals: ReturnType<typeof summarizeArtifacts> | null;
  toolReportedMs: number | null;
  notes: string[];
  load1m: { before: number; after: number | null; waitedMs: number };
  measuredAt: string;
};

export const summarizeArtifacts = (artifacts: Artifact[]) => {
  const functions = artifacts.filter((a) => a.kind === 'function');
  const layers = artifacts.filter((a) => a.kind === 'layer');
  const others = artifacts.filter((a) => a.kind === 'asset');
  const distinct = new Map<string, Artifact>();
  for (const artifact of artifacts) if (!distinct.has(artifact.contentHash)) distinct.set(artifact.contentHash, artifact);
  return {
    functionArtifacts: functions.length,
    layerArtifacts: layers.length,
    otherAssets: others.length,
    functionZippedBytes: functions.reduce((s, a) => s + a.zippedBytes, 0),
    functionUnzippedBytes: functions.reduce((s, a) => s + a.unzippedBytes, 0),
    layerZippedBytes: layers.reduce((s, a) => s + a.zippedBytes, 0),
    otherAssetZippedBytes: others.reduce((s, a) => s + a.zippedBytes, 0),
    largestFunctionUnzippedBytes: Math.max(0, ...functions.map((a) => a.unzippedBytes)),
    firstDeployUploadZippedBytes: [...distinct.values()].reduce((s, a) => s + a.zippedBytes, 0)
  };
};

export const diffArtifacts = (before: Artifact[], after: Artifact[]) => {
  const beforeByName = new Map(before.map((a) => [a.name, a]));
  const changed = after.filter((a) => beforeByName.get(a.name)?.contentHash !== a.contentHash);
  return {
    changedCount: changed.length,
    totalCount: after.length,
    changedZippedBytes: changed.reduce((s, a) => s + a.zippedBytes, 0),
    changedNames: changed.map((a) => `${a.name}${a.kind === 'layer' ? ' (layer)' : ''}`)
  };
};

export const measureApp = ({
  fixture,
  dir,
  adapter,
  samples,
  load1m,
  waitForQuiet,
  materialize
}: {
  fixture: AppFixture;
  dir: string;
  adapter: ToolAdapter;
  samples: number;
  load1m: () => number;
  waitForQuiet: () => number;
  /** Turns a tool's own zips into measured artifacts (Serverless hands over zips only). */
  materialize: (dir: string, artifacts: Artifact[]) => Artifact[];
}): AppMeasurement => {
  const waitedMs = waitForQuiet();
  const config = 'app' as const;
  const base: AppMeasurement = {
    fixture: fixture.id,
    tool: adapter.id,
    ok: false,
    error: null,
    command: printableCommand(adapter.command(dir, config)),
    cold: null,
    edit: null,
    artifacts: [],
    totals: null,
    toolReportedMs: null,
    notes: [],
    load1m: { before: load1m(), after: null, waitedMs },
    measuredAt: new Date().toISOString()
  };
  const availability = adapter.availability();
  if (!availability.ok) return { ...base, error: availability.reason };
  if (!exists(join(dir, 'node_modules'))) return { ...base, error: 'fixture is not installed' };

  const packageOnce = () => {
    const prepared = adapter.prepare(dir, config);
    const result = runOnce({ ...adapter.command(dir, config), timeoutMs: 20 * 60 * 1000 });
    const output = `${result.stdout}\n${result.stderr}`;
    const collected = result.exitCode === 0 ? adapter.collect(dir, config, prepared, output) : null;
    const artifacts = collected ? materialize(dir, collected.artifacts) : [];
    adapter.discardRunOutput(dir, config, prepared);
    return { result, collected, artifacts };
  };
  const failure = (run: ReturnType<typeof packageOnce>) =>
    `exit ${run.result.exitCode}: ${(run.result.stderr || run.result.stdout).slice(-2500)}`;

  // Cold.
  adapter.cleanCaches(dir, config);
  const warmup = packageOnce();
  if (warmup.result.exitCode !== 0) return { ...base, error: failure(warmup) };
  const cold: number[] = [];
  let last = warmup;
  for (let index = 0; index < samples; index += 1) {
    adapter.cleanCaches(dir, config);
    const run = packageOnce();
    if (run.result.exitCode !== 0) return { ...base, cold: { samples: cold, medianMs: null }, error: failure(run) };
    cold.push(Math.round(run.result.wallMs));
    last = run;
  }

  // One-line change, alternately applied and reverted.
  const file = join(dir, fixture.edit.file);
  const original = readFileSync(file, 'utf8');
  const edited = original.replace(fixture.edit.from, fixture.edit.to);
  if (edited === original) return { ...base, error: `the edit found nothing to change in ${fixture.edit.file}` };
  const editSamples: number[] = [];
  const changes: NonNullable<AppMeasurement['edit']>['changes'] = [];
  try {
    writeFileSync(file, original);
    let previous = packageOnce();
    if (previous.result.exitCode !== 0) return { ...base, error: failure(previous) };
    for (let index = 0; index < samples; index += 1) {
      writeFileSync(file, index % 2 === 0 ? edited : original);
      const run = packageOnce();
      if (run.result.exitCode !== 0) return { ...base, error: failure(run) };
      editSamples.push(Math.round(run.result.wallMs));
      changes.push(diffArtifacts(previous.artifacts, run.artifacts));
      previous = run;
    }
  } finally {
    writeFileSync(file, original);
  }
  adapter.cleanCaches(dir, config);

  return {
    ...base,
    ok: true,
    cold: { samples: cold, medianMs: Math.round(median(cold)) },
    edit: { samples: editSamples, medianMs: Math.round(median(editSamples)), changes },
    artifacts: last.artifacts,
    totals: summarizeArtifacts(last.artifacts),
    toolReportedMs: last.collected?.toolReportedMs ?? null,
    notes: last.collected?.notes ?? [],
    load1m: { ...base.load1m, after: load1m() }
  };
};
