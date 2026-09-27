/**
 * Benchmark runner.
 *
 *   node bench/run.ts install       install every generated fixture (warm dependency install)
 *   node bench/run.ts lambda        package-time and size for every shape, tool and configuration
 *   node bench/run.ts incremental   S5: package, change one handler, package again, package unchanged
 *   node bench/run.ts overhead      Stacktape CLI start-up, the floor under every Stacktape measurement
 *   node bench/run.ts containers    image size, cold build and warm rebuild for the three container paths
 *   node bench/run.ts sst           DEPLOYS TO AWS. See fixtures/sst/README.md before running it.
 *   node bench/run.ts apps-install  install every real-application fixture (after `node fixtures/apps.ts`)
 *   node bench/run.ts apps          cold package, package after a one-line change and upload bytes, per
 *                                   real-application fixture and local tool (Stacktape, CDK, Serverless)
 *   node bench/run.ts report        rewrite results/RESULTS.md from results/results.json
 *   node bench/run.ts all           everything except `sst`, in order
 *
 * Environment:
 *   STACKTAPE_REPO                 path to the Stacktape monorepo (default: ../stacktape)
 *   STACKTAPE_BINARY               the Stacktape CLI executable to measure
 *                                  (default: <repo>/apps/cli/__dist/linux/stacktape)
 *   BENCH_AWS_PROFILE              AWS profile for Stacktape's read-only identity lookup (default: default)
 *   BENCH_AWS_REGION               default: eu-west-1
 *   SERVERLESS_ACCESS_KEY          enables the Serverless Framework runs
 *   BENCH_ALLOW_SST_AWS_BOOTSTRAP  required by `run.ts sst`; it deploys real AWS resources
 *   BENCH_SAMPLES                  samples per measurement (default: 3)
 *   BENCH_SHAPES                   comma-separated shape ids to restrict the run to
 *   BENCH_TOOLS                    comma-separated tool ids to restrict the run to
 *   BENCH_CONTAINER_VARIANTS       comma-separated container variants to restrict `containers` to
 *   STACKTAPE_BINARY_COMMIT        the Stacktape commit the binary was built from, recorded in the report
 *   BENCH_APPS                     comma-separated real-application fixture ids to restrict `apps` to
 *   BENCH_MAX_LOAD                 wait before each measurement while the one-minute load is above this (default 2)
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTAINER_VARIANTS, SHAPES, TOOLS, handlerFileName } from '../fixtures/generate.ts';
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
import { renderAppsReport } from './src/report-apps.ts';
import { runContainerBenchmark } from './src/containers.ts';
import { runSstBenchmark } from './src/sst.ts';
import { appsOutRoot, CONTAINER_FIXTURE, CONTAINER_VARIANTS as APP_CONTAINER_VARIANTS, loadAppFixtures } from '../fixtures/apps.ts';
import { type AppMeasurement, measureApp } from './src/apps.ts';
import { checkAccount, cleanupOnly, removeBootstrap, runSstApp } from './src/sst-apps.ts';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedDir = join(repoRoot, 'generated');
const tmpDir = join(repoRoot, 'tmp');
const resultsDir = join(repoRoot, 'results');
const resultsFile = join(resultsDir, 'results.json');
const logFile = join(tmpDir, 'run.log');

const CONFIGS: ConfigName[] = ['likeforlike', 'defaults'];
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 3);

const stacktapeRepo = process.env.STACKTAPE_REPO ?? join(dirname(repoRoot), 'stacktape');

const ctx: ToolContext = {
  stacktapeRepo,
  stacktapeBinary:
    process.env.STACKTAPE_BINARY ?? join(stacktapeRepo, 'apps', 'cli', '__dist', 'linux', 'stacktape'),
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

/** The one-minute load average, recorded with every measurement: the machine must be quiet for a fair run. */
const load1m = () => Math.round(loadavg()[0] * 100) / 100;

const MAX_LOAD = Number(process.env.BENCH_MAX_LOAD ?? 2);
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Waits while the one-minute load is above BENCH_MAX_LOAD, at most 15 minutes; returns how long it waited. */
const waitForQuiet = () => {
  const started = performance.now();
  while (load1m() > MAX_LOAD) {
    if (performance.now() - started > 15 * 60 * 1000) {
      log(`load still ${load1m()} after 15 minutes; measuring anyway`);
      break;
    }
    log(`waiting: one-minute load ${load1m()} is above ${MAX_LOAD}`);
    sleepSync(30000);
  }
  return Math.round(performance.now() - started);
};

const selectedShapes = () => {
  const only = process.env.BENCH_SHAPES?.split(',').map((s) => s.trim()).filter(Boolean);
  return only?.length ? SHAPES.filter((s) => only.includes(s.id)) : SHAPES;
};

const selectedTools = () => {
  const only = process.env.BENCH_TOOLS?.split(',').map((s) => s.trim()).filter(Boolean);
  return only?.length ? TOOLS.filter((t) => only.includes(t)) : [...TOOLS];
};

const projectDir = (shapeId: string, toolId: string) => join(generatedDir, shapeId, toolId);

const selectedContainerVariants = (): string[] => {
  const only = process.env.BENCH_CONTAINER_VARIANTS?.split(',').map((s) => s.trim()).filter(Boolean);
  return only?.length ? CONTAINER_VARIANTS.filter((v) => only.includes(v)) : [...CONTAINER_VARIANTS];
};

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
    artifactCount: number;
    layerCount: number;
    functionUnzippedBytes: number;
    functionZippedBytes: number;
    layerUnzippedBytes: number;
    layerZippedBytes: number;
    firstDeployUploadZippedBytes: number;
  } | null;
  footprint: { perFunction: Record<string, number>; maxBytes: number; medianBytes: number } | null;
  notes: string[];
  measuredAt: string;
  /** One-minute load average when the measurement started and when it ended. */
  load1m: { before: number; after: number | null };
};

type Any = Record<string, any>;

type Results = {
  environment: unknown;
  blocked: { tool: string; reason: string }[];
  apps: AppMeasurement[];
  appsSst: unknown;
  appContainers: unknown[];
  lambda: Measurement[];
  incremental: unknown[];
  containers: unknown[];
  sst: unknown;
  overhead: unknown;
  caveats: string[];
};

const emptyResults = (): Results => ({
  environment: null,
  blocked: [],
  apps: [],
  appsSst: null,
  appContainers: [],
  lambda: [],
  incremental: [],
  containers: [],
  sst: null,
  overhead: null,
  caveats: []
});

const loadResults = (): Results =>
  exists(resultsFile) ? { ...emptyResults(), ...JSON.parse(readFileSync(resultsFile, 'utf8')) } : emptyResults();

/** Recorded output never carries this machine's home directory or the AWS account the SST runs used. */
const redact = (text: string) => {
  let out = text.replaceAll(homedir(), '~');
  const account = process.env.BENCH_EXPECTED_ACCOUNT;
  if (account) out = out.replaceAll(account, '<account>');
  return out;
};

const saveResults = (results: Results) => {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(resultsFile, redact(`${JSON.stringify(results, null, 2)}\n`));
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
  for (const variant of CONTAINER_VARIANTS) {
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
    // A tool that ships one package for the whole service contributes one artifact but many functions.
    functionCount: functions.reduce((count, a) => count + (a.servesFunctionCount ?? 1), 0),
    artifactCount: functions.length,
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
    const bytes = fn.unzippedBytes + attached.reduce((s, l) => s + l.unzippedBytes, 0);
    // One shared service package is loaded in full by every function it serves.
    const serves = fn.servesFunctionCount ?? 1;
    if (serves > 1) {
      for (let i = 1; i <= serves; i += 1) perFunction[fn.name + '#' + i] = bytes;
    } else {
      perFunction[fn.name] = bytes;
    }
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
    return { ...measured, servesFunctionCount: artifact.servesFunctionCount };
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
    notes: [],
    measuredAt: new Date().toISOString(),
    load1m: { before: load1m(), after: null }
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
    // Tools differ in which stream they print their progress to, so adapters see both.
    const collected = adapter.collect(dir, config, prepared, `${result.stdout}\n${result.stderr}`);
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
    notes,
    load1m: { before: base.load1m.before, after: load1m() }
  };
};

const lambda = () => {
  const results = loadResults();
  const tools = selectedTools();
  results.lambda = results.lambda.filter(
    (m) => !(selectedShapes().some((s) => s.id === m.shape) && tools.includes(m.tool as never))
  );

  // A tool that runs now must not keep a stale "blocked" note from an earlier session.
  results.blocked = results.blocked.filter((b) => !tools.includes(b.tool as never));

  for (const shape of selectedShapes()) {
    for (const toolId of tools) {
      log(`block ${shape.id}/${toolId}: one-minute load ${load1m()}`);
      const availability = adapters[toolId].availability();
      if (!availability.ok) {
        const measuredElsewhere =
          toolId === 'sst' && ((results.sst as Any)?.measurements?.length ?? 0) > 0;
        if (!measuredElsewhere && !results.blocked.some((b) => b.tool === toolId)) {
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

const INCREMENTAL_SCENARIOS = [
  {
    id: 'handler',
    label: 'one statement appended to one handler',
    file: (dir: string) => join(dir, 'src', 'handlers', handlerFileName(1)),
    edit: (source: string) =>
      `${source}\nexport const benchmarkTouch = 'S5 one-line change to ${handlerFileName(1)}';\n`
  },
  {
    // An appended unused export is tree-shaken out of a non-entry module, so the shared-code scenario
    // edits a string literal on a code path every handler actually runs.
    id: 'shared-lib',
    label: 'one line changed in lib/util.ts, which every handler imports',
    file: (dir: string) => join(dir, 'src', 'lib', 'util.ts'),
    edit: (source: string) => {
      const edited = source.replace(
        "'content-type': 'application/json'",
        "'content-type': 'application/json; charset=utf-8'"
      );
      if (edited === source) throw new Error('shared-lib scenario found nothing to change in lib/util.ts');
      return edited;
    }
  }
] as const;

const INCREMENTAL_REPEATS = Number(process.env.BENCH_INCREMENTAL_REPEATS ?? 3);

const incremental = () => {
  const results = loadResults();
  // Tools run now replace their own entries only, so the tools can be measured in separate sessions.
  results.incremental = (results.incremental as Any[]).filter((entry) => !selectedTools().includes(entry.tool));
  const shape = SHAPES.find((s) => s.id === 'n25')!;
  const config: ConfigName = 'likeforlike';

  for (const toolId of selectedTools()) {
    const adapter = adapters[toolId];
    const availability = adapter.availability();
    const dir = projectDir(shape.id, toolId);
    if (!availability.ok || !exists(join(dir, 'node_modules'))) {
      results.incremental.push({
        tool: toolId,
        shape: shape.id,
        config,
        ok: false,
        notMeasured: availability.ok ? 'fixture is not installed' : availability.reason
      });
      saveResults(results);
      continue;
    }
    log(`incremental ${toolId}: one-minute load ${load1m()}`);

    const packageOnce = () => {
      const prepared = adapter.prepare(dir, config);
      const result = runOnce(adapter.command(dir, config));
      const collected = adapter.collect(dir, config, prepared, `${result.stdout}\n${result.stderr}`);
      const artifacts = materializeZipArtifacts(dir, collected.artifacts);
      adapter.discardRunOutput(dir, config, prepared);
      return { ok: result.exitCode === 0, wallMs: Math.round(result.wallMs), artifacts };
    };

    for (const scenario of INCREMENTAL_SCENARIOS) {
      const path = scenario.file(dir);
      const original = readFileSync(path, 'utf8');
      const first: number[] = [];
      const changed: number[] = [];
      const unchanged: number[] = [];
      let lastDiffs: { byChange: unknown; byNoChange: unknown } | null = null;
      let ok = true;

      try {
        for (let repeat = 0; repeat < INCREMENTAL_REPEATS; repeat += 1) {
          writeFileSync(path, original);
          adapter.cleanCaches(dir, config);
          const run1 = packageOnce();
          writeFileSync(path, scenario.edit(original));
          const run2 = packageOnce();
          // Run 3 leaves the file exactly as run 2 left it: nothing changed since the previous package.
          const run3 = packageOnce();
          first.push(run1.wallMs);
          changed.push(run2.wallMs);
          unchanged.push(run3.wallMs);
          ok = ok && run1.ok && run2.ok && run3.ok;
          lastDiffs = {
            byChange: diffArtifacts(run1.artifacts, run2.artifacts),
            byNoChange: diffArtifacts(run2.artifacts, run3.artifacts)
          };
        }
      } finally {
        writeFileSync(path, original);
      }

      results.incremental.push({
        tool: toolId,
        shape: shape.id,
        config,
        scenario: scenario.id,
        scenarioLabel: scenario.label,
        repeats: INCREMENTAL_REPEATS,
        runs: {
          first: Math.round(median(first)),
          afterOneLineChange: Math.round(median(changed)),
          unchanged: Math.round(median(unchanged))
        },
        samples: { first, afterOneLineChange: changed, unchanged },
        changedByOneLineChange: lastDiffs?.byChange,
        changedByNoChange: lastDiffs?.byNoChange,
        ok,
        measuredAt: new Date().toISOString(),
        load1mAfter: load1m()
      });
      log(`incremental ${toolId} / ${scenario.id}: done`);
      saveResults(results);
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
  // One discarded launch: the binary is ~180 MB and the first launch pays a disk-cache cost.
  runOnce({ command: ctx.stacktapeBinary, args: ['version'], cwd: repoRoot });

  const samples: number[] = [];
  for (let i = 0; i < Math.max(SAMPLES, 5); i += 1) {
    samples.push(runOnce({ command: ctx.stacktapeBinary, args: ['version'], cwd: repoRoot }).wallMs);
  }
  results.overhead = {
    what:
      'Wall clock of `stacktape version`: the CLI binary starting up and printing its version. It is the ' +
      'floor under every Stacktape measurement here, and it excludes configuration loading, the AWS identity ' +
      'lookup and packaging itself.',
    binary: ctx.stacktapeBinary,
    samples: samples.map((s) => Math.round(s)),
    medianMs: Math.round(median(samples)),
    measuredAt: new Date().toISOString(),
    load1mAfter: load1m()
  };
  log(`stacktape binary start-up: ${Math.round(median(samples))}ms median`);
  saveResults(results);
};

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// real-application fixtures
// ---------------------------------------------------------------------------

const selectedApps = async () => {
  const only = process.env.BENCH_APPS?.split(',').map((s) => s.trim()).filter(Boolean);
  const fixtures = await loadAppFixtures();
  return only?.length ? fixtures.filter((f) => only.includes(f.id)) : fixtures;
};

const appsInstall = async () => {
  for (const fixture of await selectedApps()) {
    for (const tool of fixture.tools) {
      if (!selectedTools().includes(tool)) continue;
      const dir = join(appsOutRoot, fixture.id, tool);
      const result = runOnce({ ...installCommand(dir, fixture.packageManager === 'pnpm'), timeoutMs: 20 * 60 * 1000 });
      log(`install apps/${fixture.id}/${tool}: exit ${result.exitCode} in ${Math.round(result.wallMs)}ms`);
      if (result.exitCode !== 0) log((result.stderr || result.stdout).slice(-3000));
    }
  }
};

const apps = async () => {
  const results = loadResults();
  const tools = selectedTools().filter((tool) => tool !== 'sst');
  for (const fixture of await selectedApps()) {
    for (const tool of fixture.tools.filter((t) => tools.includes(t))) {
      log(`apps ${fixture.id}/${tool}: one-minute load ${load1m()}`);
      const measurement = measureApp({
        fixture,
        dir: join(appsOutRoot, fixture.id, tool),
        adapter: adapters[tool],
        samples: SAMPLES,
        load1m,
        waitForQuiet,
        materialize: materializeZipArtifacts
      });
      results.apps = [...results.apps.filter((m) => !(m.fixture === fixture.id && m.tool === tool)), measurement];
      saveResults(results);
      log(
        `apps ${fixture.id}/${tool}: ` +
          (measurement.ok
            ? `cold ${measurement.cold?.medianMs}ms, one-line change ${measurement.edit?.medianMs}ms, upload ` +
              `${measurement.totals?.firstDeployUploadZippedBytes} bytes`
            : `FAILED - ${measurement.error?.slice(0, 600)}`)
      );
    }
  }
};

const main = async (): Promise<void> => {
  const command = process.argv[2] ?? 'all';
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });

  if (command === 'apps-install') return appsInstall();
  if (command === 'sst-apps') {
    const statePath = join(tmpDir, 'sst-apps-state.json');
    const dirFor = (fixture: string) => join(appsOutRoot, fixture, 'sst');
    if (!ctx.allowSstAwsBootstrap) throw new Error('Refusing to run SST: it deploys to AWS. Set BENCH_ALLOW_SST_AWS_BOOTSTRAP=1.');
    checkAccount();
    if (process.argv.includes('--cleanup-only')) return cleanupOnly(statePath, dirFor, log);
    if (process.argv.includes('--cleanup-bootstrap')) {
      const results = loadResults();
      results.appsSst = { ...((results.appsSst as Any) ?? {}), bootstrapCleanup: removeBootstrap(statePath, log) };
      saveResults(results);
      return;
    }
    const results = loadResults();
    for (const fixture of await selectedApps()) {
      if (!fixture.tools.includes('sst') || fixture.sstNotDeployed) continue;
      log(`sst ${fixture.id}: one-minute load ${load1m()}`);
      waitForQuiet();
      const measurement = runSstApp({ fixture, dir: dirFor(fixture.id), samples: SAMPLES, tmpDir, statePath, log, load1m });
      results.appsSst = {
        ...((results.appsSst as Any) ?? {}),
        measurements: [...(((results.appsSst as Any)?.measurements ?? []) as Any[]).filter((m) => m.fixture !== fixture.id), measurement]
      };
      saveResults(results);
      log(`sst ${fixture.id}: ${measurement.ok ? `cold ${(measurement.cold as Any)?.medianMs} ms, edit ${(measurement.edit as Any)?.medianMs} ms` : `FAILED ${String(measurement.error).slice(0, 300)}`}, AWS ${measurement.awsMs} ms`);
    }
    return;
  }
  if (command === 'apps') return apps();
  if (command === 'app-containers') {
    const results = loadResults();
    const variants = (process.env.BENCH_CONTAINER_VARIANTS?.split(',').filter(Boolean) ?? []) as string[];
    const selected = variants.length ? variants : [...APP_CONTAINER_VARIANTS];
    results.appContainers = [
      ...(results.appContainers as Any[]).filter((entry) => !selected.includes(entry.variant)),
      ...runContainerBenchmark({
        repoRoot,
        ctx,
        log,
        variants: selected,
        load1m,
        base: join(appsOutRoot, CONTAINER_FIXTURE),
        sourceFile: join('src', 'index.ts'),
        dependencyChange: { name: 'express', from: '5.2.1', to: '5.2.0' }
      })
    ];
    saveResults(results);
    return;
  }

  if (command === 'install') return install();
  if (command === 'lambda') return lambda();
  if (command === 'incremental') return incremental();
  if (command === 'overhead') return overhead();
  if (command === 'sst') {
    if (!ctx.allowSstAwsBootstrap) {
      throw new Error(
        'Refusing to run SST: it deploys real AWS resources. Set BENCH_ALLOW_SST_AWS_BOOTSTRAP=1 and read ' +
          'fixtures/sst/README.md first.'
      );
    }
    const results = loadResults();
    const previous = (results.sst as Any) ?? { measurements: [], resourceLog: [] };
    const outcome = runSstBenchmark({
      generatedDir,
      shapes: selectedShapes(),
      ctx,
      samples: SAMPLES,
      tmpDir,
      log
    });
    const rerunShapes = new Set(selectedShapes().map((s) => s.id));
    results.sst = {
      // Measurements for the shapes just run replace the old ones; other shapes are kept, so the
      // seven shapes can be run in separate sessions. The resource log is append-only on purpose:
      // it is the record of what was created in AWS, and nothing should quietly drop out of it.
      measurements: [
        ...((previous.measurements ?? []) as Any[]).filter((m) => !rerunShapes.has(m.shape)),
        ...outcome.measurements
      ],
      resourceLog: [...(previous.resourceLog ?? []), ...outcome.resourceLog]
    };
    results.blocked = results.blocked.filter((b) => b.tool !== 'sst');
    saveResults(results);
    return;
  }
  if (command === 'containers') {
    const results = loadResults();
    const variants = selectedContainerVariants();
    results.containers = [
      ...(results.containers as Any[]).filter((entry) => !variants.includes(entry.variant)),
      ...runContainerBenchmark({ repoRoot, ctx, log, variants, load1m })
    ];
    saveResults(results);
    return;
  }
  if (command === 'report') {
    const results = loadResults();
    results.environment = captureEnvironment({
      stacktapeRepo: exists(ctx.stacktapeRepo) ? ctx.stacktapeRepo : null,
      stacktapeBinary: exists(ctx.stacktapeBinary) ? ctx.stacktapeBinary : null,
      stacktapeBinaryCommit: process.env.STACKTAPE_BINARY_COMMIT ?? null,
      toolVersions: readToolVersions()
    });
    saveResults(results);
    // The synthetic shapes become the appendix; their round-one container table lives in results/2026-09-26/.
    const appendixPath = join(tmpDir, 'appendix.md');
    writeReport({ ...results, containers: [] }, appendixPath);
    const appendix = readFileSync(appendixPath, 'utf8')
      .replace(/^# Results\n\n[^\n]*\n\n/, '')
      .replace(/\n## Containers\n[\s\S]*?(?=\n## )/, '\n')
      .replace(/^## /gm, '### ');
    const fixtures = await loadAppFixtures();
    const markdown = [
      '# Results',
      '',
      'Generated by `node bench/run.ts report` from `results/results.json`. One machine; see the README\'s caveats ' +
        'before quoting anything. Round one (26 September) is in `results/2026-09-26/`, the first run in ' +
        '`results/2026-09-21/`.',
      '',
      renderAppsReport(results, fixtures),
      '## Appendix: an API growing one function per route',
      '',
      'Synthetic shapes from round one: the same generated application with 1 to 50 functions. Stacktape rows are ' +
        're-measured with this binary; AWS CDK and Serverless Framework rows are from 26 September (same versions), ' +
        'SST rows from 21 September.',
      '',
      appendix
    ].join('\n');
    writeFileSync(join(resultsDir, 'RESULTS.md'), redact(markdown));
    log(`wrote ${join(resultsDir, 'RESULTS.md')}`);
    return;
  }
  if (command === 'all') {
    install();
    overhead();
    lambda();
    incremental();
    const results = loadResults();
    results.containers = runContainerBenchmark({ repoRoot, ctx, log, variants: selectedContainerVariants(), load1m });
    saveResults(results);
    process.argv[2] = 'report';
    return await main();
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

// Only when run as a script: importing this module must never start a benchmark.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
