/**
 * Benchmark runner.
 *
 *   node bench/run.ts install       install every generated fixture (warm dependency install)
 *   node bench/run.ts lambda        package-time and size for every shape, tool and configuration
 *   node bench/run.ts incremental   S5: package, change one handler, package again, package unchanged
 *   node bench/run.ts overhead      the fixed cost of the source-built Stacktape CLI rebuilding itself
 *   node bench/run.ts containers    image size, cold build and warm rebuild for the three container paths
 *   node bench/run.ts report        rewrite results/RESULTS.md from results/results.json
 *   node bench/run.ts all           everything above, in order
 *
 * Environment:
 *   STACKTAPE_REPO                 path to the Stacktape monorepo (default: ../stacktape)
 *   BENCH_AWS_PROFILE              AWS profile for Stacktape's read-only identity lookup (default: default)
 *   BENCH_AWS_REGION               default: eu-west-1
 *   SERVERLESS_ACCESS_KEY          enables the Serverless Framework runs
 *   BENCH_ALLOW_SST_AWS_BOOTSTRAP  enables the SST runs; see fixtures/sst/README.md before setting it
 *   BENCH_SAMPLES                  samples per measurement (default: 3)
 *   BENCH_SHAPES                   comma-separated shape ids to restrict the run to
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHAPES, TOOLS, handlerFileName } from '../fixtures/generate.ts';
import { captureEnvironment } from './src/env.ts';
import {
  type Artifact,
  type Command,
  exists,
  measureDirectory,
  median,
  printableCommand,
  removePaths,
  runOnce
} from './src/measure.ts';
import { type ConfigName, createAdapters, type ToolContext } from './src/tools.ts';
import { writeReport } from './src/report.ts';
import { runContainerBenchmark } from './src/containers.ts';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedDir = join(repoRoot, 'generated');
const tmpDir = join(repoRoot, 'tmp');
const resultsDir = join(repoRoot, 'results');
const resultsFile = join(resultsDir, 'results.json');
const logFile = join(tmpDir, 'run.log');

const CONFIGS: ConfigName[] = ['likeforlike', 'defaults'];
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 3);

const ctx: ToolContext = {
  stacktapeRepo: process.env.STACKTAPE_REPO ?? join(dirname(repoRoot), 'stacktape'),
  awsProfile: process.env.BENCH_AWS_PROFILE ?? 'default',
  awsRegion: process.env.BENCH_AWS_REGION ?? 'eu-west-1',
  projectName: 'pkgbench',
  stage: 'dev',
  serverlessAccessKey: process.env.SERVERLESS_ACCESS_KEY || null,
  allowSstAwsBootstrap: process.env.BENCH_ALLOW_SST_AWS_BOOTSTRAP === '1'
};

const adapters = createAdapters(ctx);

const log = (message: string) => {
  const line = `[${new Date().toISOString()}] ${message}`;
  process.stdout.write(`${line}\n`);
  mkdirSync(tmpDir, { recursive: true });
  appendFileSync(logFile, `${line}\n`);
};

const selectedShapes = () => {
  const only = process.env.BENCH_SHAPES?.split(',').map((s) => s.trim()).filter(Boolean);
  return only?.length ? SHAPES.filter((s) => only.includes(s.id)) : SHAPES;
};

const projectDir = (shapeId: string, toolId: string) => join(generatedDir, shapeId, toolId);

// ---------------------------------------------------------------------------
// results.json
// ---------------------------------------------------------------------------

type Measurement = {
  shape: string;
  functions: number;
  shapeKind: string;
  tool: string;
  config: ConfigName;
  mode: 'cold' | 'warm';
  ok: boolean;
  samples: number[];
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  toolReportedMs: number | null;
  command: string;
  error: string | null;
  artifacts: Artifact[];
  totals: {
    functionCount: number;
    layerCount: number;
    functionUnzippedBytes: number;
    functionZippedBytes: number;
    layerUnzippedBytes: number;
    layerZippedBytes: number;
    firstDeployUploadZippedBytes: number;
  } | null;
  footprint: { perFunction: Record<string, number>; maxBytes: number; medianBytes: number } | null;
  notes: string[];
};

type Results = {
  environment: unknown;
  blocked: { tool: string; reason: string }[];
  lambda: Measurement[];
  incremental: unknown[];
  containers: unknown[];
  overhead: unknown;
  caveats: string[];
};

const emptyResults = (): Results => ({
  environment: null,
  blocked: [],
  lambda: [],
  incremental: [],
  containers: [],
  overhead: null,
  caveats: []
});

const loadResults = (): Results =>
  exists(resultsFile) ? { ...emptyResults(), ...JSON.parse(readFileSync(resultsFile, 'utf8')) } : emptyResults();

const saveResults = (results: Results) => {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
};

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

const installCommand = (dir: string, monorepo: boolean): Command =>
  monorepo
    ? { command: 'pnpm', args: ['install', '--no-frozen-lockfile'], cwd: dir }
    : { command: 'npm', args: ['install', '--no-audit', '--no-fund'], cwd: dir };

const install = () => {
  for (const shape of selectedShapes()) {
    for (const tool of TOOLS) {
      const dir = projectDir(shape.id, tool);
      if (!exists(dir)) continue;
      const result = runOnce(installCommand(dir, shape.kind === 'monorepo'));
      log(`install ${shape.id}/${tool}: exit ${result.exitCode} in ${Math.round(result.wallMs)}ms`);
      if (result.exitCode !== 0) log(result.stderr.slice(-2000));
    }
  }
  for (const variant of ['stacktape', 'expert', 'naive']) {
    const dir = join(generatedDir, 'container', variant);
    if (!exists(dir)) continue;
    const result = runOnce(installCommand(dir, false));
    log(`install container/${variant}: exit ${result.exitCode} in ${Math.round(result.wallMs)}ms`);
  }
};

// ---------------------------------------------------------------------------
// measuring one (shape, tool, config)
// ---------------------------------------------------------------------------

const summarize = (artifacts: Artifact[]) => {
  const functions = artifacts.filter((a) => a.kind === 'function');
  const layers = artifacts.filter((a) => a.kind === 'layer');
  const distinct = new Map<string, Artifact>();
  for (const artifact of artifacts) if (!distinct.has(artifact.contentHash)) distinct.set(artifact.contentHash, artifact);
  return {
    functionCount: functions.length,
    layerCount: layers.length,
    functionUnzippedBytes: functions.reduce((s, a) => s + a.unzippedBytes, 0),
    functionZippedBytes: functions.reduce((s, a) => s + a.zippedBytes, 0),
    layerUnzippedBytes: layers.reduce((s, a) => s + a.unzippedBytes, 0),
    layerZippedBytes: layers.reduce((s, a) => s + a.zippedBytes, 0),
    firstDeployUploadZippedBytes: [...distinct.values()].reduce((s, a) => s + a.zippedBytes, 0)
  };
};

/**
 * S6: the unzipped bytes Lambda loads at cold start for one function - its own artifact plus every
 * layer attached to it. A proxy for cold start, not a measurement of it.
 */
const footprint = (artifacts: Artifact[]) => {
  const layers = artifacts.filter((a) => a.kind === 'layer');
  const perFunction: Record<string, number> = {};
  for (const fn of artifacts.filter((a) => a.kind === 'function')) {
    const attached = layers.filter((l) => (l.attachedFunctions ?? []).includes(fn.name));
    perFunction[fn.name] = fn.unzippedBytes + attached.reduce((s, l) => s + l.unzippedBytes, 0);
  }
  const values = Object.values(perFunction);
  if (values.length === 0) return null;
  return { perFunction, maxBytes: Math.max(...values), medianBytes: median(values) };
};

/** Serverless hands over zips only; unpack them so every tool is measured the same way. */
const materializeZipArtifacts = (dir: string, artifacts: Artifact[]) =>
  artifacts.map((artifact) => {
    if (artifact.contentHash !== '' || artifact.toolZipBytes === null) return artifact;
    const target = join(tmpDir, 'unzipped', `${Date.now()}-${artifact.name}`);
    mkdirSync(target, { recursive: true });
    const zipPath = join(dir, '.serverless', `${artifact.name}.zip`);
    const result = runOnce({ command: 'unzip', args: ['-q', '-o', zipPath, '-d', target], cwd: dir });
    if (result.exitCode !== 0) return artifact;
    const measured = measureDirectory({
      root: target,
      name: artifact.name,
      kind: 'function',
      toolZipBytes: artifact.toolZipBytes
    });
    removePaths([target]);
    return measured;
  });

const measureOne = ({
  shape,
  toolId,
  config,
  mode
}: {
  shape: (typeof SHAPES)[number];
  toolId: string;
  config: ConfigName;
  mode: 'cold' | 'warm';
}): Measurement => {
  const adapter = adapters[toolId];
  const dir = projectDir(shape.id, toolId);
  const base: Measurement = {
    shape: shape.id,
    functions: shape.functions,
    shapeKind: shape.kind,
    tool: toolId,
    config,
    mode,
    ok: false,
    samples: [],
    medianMs: null,
    minMs: null,
    maxMs: null,
    toolReportedMs: null,
    command: printableCommand(adapter.command(dir, config)),
    error: null,
    artifacts: [],
    totals: null,
    footprint: null,
    notes: []
  };

  const availability = adapter.availability();
  if (!availability.ok) return { ...base, error: availability.reason };
  if (!exists(join(dir, 'node_modules'))) return { ...base, error: 'fixture is not installed' };

  const samples: number[] = [];
  let lastArtifacts: Artifact[] = [];
  let toolReportedMs: number | null = null;
  const notes: string[] = [];

  // One discarded run first: the first invocation of any of these tools in a fresh shell pays for
  // module caches and page cache that the later samples do not, and it would otherwise land in
  // whichever measurement happened to run first.
  {
    adapter.cleanCaches(dir, config);
    const prepared = adapter.prepare(dir, config);
    runOnce(adapter.command(dir, config));
    adapter.discardRunOutput(dir, config, prepared);
  }

  for (let i = 0; i < SAMPLES; i += 1) {
    if (mode === 'cold') adapter.cleanCaches(dir, config);
    const prepared = adapter.prepare(dir, config);
    const result = runOnce(adapter.command(dir, config));
    if (result.exitCode !== 0) {
      adapter.discardRunOutput(dir, config, prepared);
      return {
        ...base,
        samples,
        error: `exit ${result.exitCode}: ${(result.stderr || result.stdout).slice(-1500)}`
      };
    }
    samples.push(result.wallMs);
    const collected = adapter.collect(dir, config, prepared, result.stdout);
    if (i === SAMPLES - 1) {
      lastArtifacts = materializeZipArtifacts(dir, collected.artifacts);
      toolReportedMs = collected.toolReportedMs;
      notes.push(...collected.notes);
    }
    adapter.discardRunOutput(dir, config, prepared);
  }

  return {
    ...base,
    ok: true,
    samples: samples.map((s) => Math.round(s)),
    medianMs: Math.round(median(samples)),
    minMs: Math.round(Math.min(...samples)),
    maxMs: Math.round(Math.max(...samples)),
    toolReportedMs,
    artifacts: lastArtifacts,
    totals: summarize(lastArtifacts),
    footprint: footprint(lastArtifacts),
    notes
  };
};

const lambda = () => {
  const results = loadResults();
  results.lambda = results.lambda.filter(
    (m) => !selectedShapes().some((s) => s.id === m.shape)
  );

  for (const shape of selectedShapes()) {
    for (const toolId of TOOLS) {
      const availability = adapters[toolId].availability();
      if (!availability.ok) {
        if (!results.blocked.some((b) => b.tool === toolId)) {
          results.blocked.push({ tool: toolId, reason: availability.reason });
        }
        log(`skip ${shape.id}/${toolId}: ${availability.reason.slice(0, 90)}...`);
        continue;
      }
      for (const config of CONFIGS) {
        for (const mode of ['cold', 'warm'] as const) {
          const measurement = measureOne({ shape, toolId, config, mode });
          results.lambda.push(measurement);
          saveResults(results);
          log(
            `${shape.id} ${toolId} ${config} ${mode}: ` +
              (measurement.ok
                ? `${measurement.medianMs}ms median, ${measurement.totals?.functionCount} functions, ` +
                  `${measurement.totals?.layerCount} layers, ` +
                  `${measurement.totals?.firstDeployUploadZippedBytes} upload bytes`
                : `FAILED - ${measurement.error?.slice(0, 200)}`)
          );
        }
      }
    }
  }
  saveResults(results);
};

// ---------------------------------------------------------------------------
// S5 incremental
// ---------------------------------------------------------------------------

const incremental = () => {
  const results = loadResults();
  results.incremental = [];
  const shape = SHAPES.find((s) => s.id === 'n25')!;

  for (const toolId of TOOLS) {
    const adapter = adapters[toolId];
    if (!adapter.availability().ok) continue;
    const dir = projectDir(shape.id, toolId);
    if (!exists(join(dir, 'node_modules'))) continue;

    const handlerPath = join(dir, 'src', 'handlers', handlerFileName(1));
    const original = readFileSync(handlerPath, 'utf8');
    const config: ConfigName = 'likeforlike';

    const packageOnce = () => {
      const prepared = adapter.prepare(dir, config);
      const result = runOnce(adapter.command(dir, config));
      const collected = adapter.collect(dir, config, prepared, result.stdout);
      const artifacts = materializeZipArtifacts(dir, collected.artifacts);
      adapter.discardRunOutput(dir, config, prepared);
      return { ok: result.exitCode === 0, wallMs: Math.round(result.wallMs), artifacts };
    };

    try {
      adapter.cleanCaches(dir, config);
      const run1 = packageOnce();
      writeFileSync(
        handlerPath,
        `${original}\nexport const benchmarkTouch = 'S5 one-line change to ${handlerFileName(1)}';\n`
      );
      const run2 = packageOnce();
      const run3 = packageOnce();
      writeFileSync(handlerPath, original);

      results.incremental.push({
        tool: toolId,
        shape: shape.id,
        config,
        runs: { first: run1.wallMs, afterOneLineChange: run2.wallMs, unchanged: run3.wallMs },
        changedByOneLineChange: diffArtifacts(run1.artifacts, run2.artifacts),
        changedByNoChange: diffArtifacts(run1.artifacts, run3.artifacts),
        ok: run1.ok && run2.ok && run3.ok
      });
      log(`incremental ${toolId}: done`);
    } finally {
      writeFileSync(handlerPath, original);
    }
  }
  saveResults(results);
};

const diffArtifacts = (before: Artifact[], after: Artifact[]) => {
  const beforeByName = new Map(before.map((a) => [a.name, a]));
  const changed = after.filter((a) => beforeByName.get(a.name)?.contentHash !== a.contentHash);
  return {
    changedCount: changed.length,
    totalCount: after.length,
    changedZippedBytes: changed.reduce((s, a) => s + a.zippedBytes, 0),
    changedUnzippedBytes: changed.reduce((s, a) => s + a.unzippedBytes, 0),
    changedNames: changed.map((a) => `${a.name}${a.kind === 'layer' ? ' (layer)' : ''}`)
  };
};

// ---------------------------------------------------------------------------
// Stacktape CLI self-build overhead
// ---------------------------------------------------------------------------

const overhead = () => {
  const results = loadResults();
  if (!adapters.stacktape.availability().ok) {
    results.overhead = { note: 'source-built CLI unavailable' };
    saveResults(results);
    return;
  }
  const samples: number[] = [];
  for (let i = 0; i < Math.max(SAMPLES, 5); i += 1) {
    const result = runOnce({
      command: 'bun',
      args: ['run', 'scripts/dev.ts', 'this-command-does-not-exist'],
      cwd: join(ctx.stacktapeRepo, 'apps', 'cli'),
      env: { SKIP_LOADING_ENV: '1' }
    });
    samples.push(result.wallMs);
  }
  results.overhead = {
    what:
      'Wall clock of `bun run scripts/dev.ts <unknown command>` in apps/cli. The dev wrapper rebuilds the ' +
      'whole CLI with Bun.build on every invocation and then rejects the command, so this is the fixed cost ' +
      'of running Stacktape from source that a published binary does not pay. It excludes config loading, ' +
      'the STS call and packaging itself.',
    samples: samples.map((s) => Math.round(s)),
    medianMs: Math.round(median(samples))
  };
  log(`stacktape source-CLI overhead: ${Math.round(median(samples))}ms median`);
  saveResults(results);
};

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

const main = () => {
  const command = process.argv[2] ?? 'all';
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });

  if (command === 'install') return install();
  if (command === 'lambda') return lambda();
  if (command === 'incremental') return incremental();
  if (command === 'overhead') return overhead();
  if (command === 'containers') {
    const results = loadResults();
    results.containers = runContainerBenchmark({ repoRoot, ctx, log });
    saveResults(results);
    return;
  }
  if (command === 'report') {
    const results = loadResults();
    results.environment = captureEnvironment({
      stacktapeRepo: exists(ctx.stacktapeRepo) ? ctx.stacktapeRepo : null,
      toolVersions: readToolVersions()
    });
    saveResults(results);
    writeReport(results, join(resultsDir, 'RESULTS.md'));
    log(`wrote ${join(resultsDir, 'RESULTS.md')}`);
    return;
  }
  if (command === 'all') {
    install();
    overhead();
    lambda();
    incremental();
    const results = loadResults();
    results.containers = runContainerBenchmark({ repoRoot, ctx, log });
    saveResults(results);
    process.argv[2] = 'report';
    return main();
  }
  throw new Error(`unknown command: ${command}`);
};

const readToolVersions = (): Record<string, string | null> => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    benchmarkedVersions?: Record<string, string>;
  };
  const { comment: _comment, ...versions } = manifest.benchmarkedVersions ?? {};
  return versions;
};

main();
