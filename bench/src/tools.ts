/** One adapter per packaging tool: how to run it, where its artifacts land, and how to clean up. */

import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Artifact,
  type Command,
  exists,
  measureDirectory,
  removePaths,
  runOnce
} from './measure.ts';

/** `app`: a real-application fixture, which has one configuration: the one its README shows. */
export type ConfigName = 'likeforlike' | 'defaults' | 'app';

export type Availability = { ok: true } | { ok: false; reason: string };

export type Prepared = Record<string, unknown>;

export type Collected = {
  artifacts: Artifact[];
  /** The duration the tool printed for its own packaging phase, when it prints one. */
  toolReportedMs: number | null;
  notes: string[];
};

export type ToolAdapter = {
  id: string;
  label: string;
  /** Which package manager installs this tool's fixture projects. */
  availability: () => Availability;
  /** State captured immediately before a run, so the run's own output can be identified. */
  prepare: (dir: string, config: ConfigName) => Prepared;
  command: (dir: string, config: ConfigName) => Command;
  collect: (dir: string, config: ConfigName, prepared: Prepared, stdout: string) => Collected;
  /** Removes what one run produced, so repeated runs do not fill the disk. */
  discardRunOutput: (dir: string, config: ConfigName, prepared: Prepared) => void;
  /** Removes every output and cache directory, producing a cold run. */
  cleanCaches: (dir: string, config: ConfigName) => void;
};

export type ToolContext = {
  stacktapeRepo: string;
  /** Path to the Stacktape CLI executable the measurements run. */
  stacktapeBinary: string;
  awsProfile: string;
  awsRegion: string;
  projectName: string;
  stage: string;
  serverlessAccessKey: string | null;
  allowSstAwsBootstrap: boolean;
};

// ---------------------------------------------------------------------------
// Stacktape
// ---------------------------------------------------------------------------

/** `package` leaves its artifacts in `.stacktape/<invocation>/build` inside the project directory. */
const stacktapeStateDir = (dir: string) => join(dir, '.stacktape');

const listInvocations = (dir: string) => {
  const stateDir = stacktapeStateDir(dir);
  if (!exists(stateDir)) return [];
  return readdirSync(stateDir).filter((name) => statSync(join(stateDir, name)).isDirectory());
};

const createStacktapeAdapter = (ctx: ToolContext): ToolAdapter => ({
  id: 'stacktape',
  label: 'Stacktape',
  availability: () =>
    existsSync(ctx.stacktapeBinary)
      ? { ok: true }
      : { ok: false, reason: `Stacktape CLI not found at ${ctx.stacktapeBinary}` },
  prepare: (dir) => ({ before: listInvocations(dir) }),
  command: (dir, config) => ({
    command: ctx.stacktapeBinary,
    args: [
      'package',
      '--configPath',
      join(dir, config === 'defaults' ? 'stacktape.defaults.yml' : 'stacktape.yml'),
      '--projectName',
      ctx.projectName,
      '--stage',
      ctx.stage,
      '--region',
      ctx.awsRegion,
      '--profile',
      ctx.awsProfile
    ],
    cwd: dir
  }),
  collect: (dir, _config, prepared, stdout) => {
    const invocation = newestInvocation(dir, prepared.before as string[]);
    if (!invocation) return { artifacts: [], toolReportedMs: null, notes: ['no invocation directory produced'] };
    const buildDir = join(stacktapeStateDir(dir), invocation, 'build');
    const artifacts: Artifact[] = [];
    const notes: string[] = [];

    const lambdasDir = join(buildDir, 'lambdas');
    if (exists(lambdasDir)) {
      const entries = readdirSync(lambdasDir, { withFileTypes: true });
      const zips = entries.filter((e) => e.isFile() && e.name.endsWith('.zip'));
      for (const entry of entries.filter((e) => e.isDirectory())) {
        const zip = zips.find((z) => z.name.startsWith(`${entry.name}-`));
        artifacts.push(
          measureDirectory({
            root: join(lambdasDir, entry.name),
            name: entry.name,
            kind: 'function',
            toolZipBytes: zip ? statSync(join(lambdasDir, zip.name)).size : null
          })
        );
      }
    }

    const layersDir = join(buildDir, 'layers');
    if (exists(layersDir)) {
      for (const entry of readdirSync(layersDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
        const layer = measureDirectory({
          root: join(layersDir, entry.name),
          name: entry.name,
          kind: 'layer'
        });
        // A function that uses a layer imports from `/opt/nodejs/<path>`; match those paths against
        // the files the layer actually carries.
        const layerPaths = new Set(
          collectRelativeFiles(join(layersDir, entry.name, 'nodejs')).map((p) => `/opt/nodejs/${p}`)
        );
        layer.attachedFunctions = artifacts
          .filter((fn) => fn.kind === 'function')
          .filter((fn) => referencesAnyPath(join(lambdasDir, fn.name), layerPaths))
          .map((fn) => fn.name);
        artifacts.push(layer);
      }
    }

    // The CLI writes colour escapes into its progress lines, so strip them before matching.
    const plain = stdout.replace(/\[[0-9;]*m/g, '');
    // The CLI prints its own packaging duration as either `(321ms)` or `(1.1s)`.
    const reported = plain.match(/Packaged compute resources[^(]*\(([0-9.]+)\s*(ms|s)\)/);
    return {
      artifacts,
      toolReportedMs: reported ? Math.round(Number(reported[1]) * (reported[2] === 'ms' ? 1 : 1000)) : null,
      notes
    };
  },
  discardRunOutput: (dir, _config, prepared) => {
    const invocation = newestInvocation(dir, prepared.before as string[]);
    if (invocation) removePaths([join(stacktapeStateDir(dir), invocation)]);
  },
  cleanCaches: (dir) => {
    removePaths([join(dir, '.stacktape'), join(dir, '.stacktape-stack-info')]);
  }
});

const newestInvocation = (dir: string, before: string[]) => {
  const added = listInvocations(dir).filter((name) => !before.includes(name));
  return added.sort().at(-1) ?? null;
};

const collectRelativeFiles = (root: string): string[] => {
  if (!exists(root)) return [];
  const out: string[] = [];
  const visit = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(dir, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  visit(root, '');
  return out;
};

const referencesAnyPath = (functionDir: string, paths: Set<string>) => {
  const check = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (check(full)) return true;
      } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
        const text = readFileSync(full, 'utf8');
        for (const path of paths) if (text.includes(path)) return true;
      }
    }
    return false;
  };
  return exists(functionDir) ? check(functionDir) : false;
};

// ---------------------------------------------------------------------------
// AWS CDK
// ---------------------------------------------------------------------------

const cdkOutDir = (dir: string, config: ConfigName) => join(dir, `cdk.out.${config}`);

const createCdkAdapter = (): ToolAdapter => ({
  id: 'cdk',
  label: 'AWS CDK',
  availability: () => ({ ok: true }),
  prepare: () => ({}),
  command: (dir, config) => ({
    command: join(dir, 'node_modules', '.bin', 'cdk'),
    args: ['synth', '--output', cdkOutDir(dir, config), '--quiet'],
    cwd: dir,
    env: { BENCH_CONFIG: config, JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION: '1' }
  }),
  collect: (dir, config) => {
    const out = cdkOutDir(dir, config);
    const artifacts: Artifact[] = [];
    const notes: string[] = [];
    if (!exists(out)) return { artifacts, toolReportedMs: null, notes: ['no cdk.out produced'] };

    // Every file a deployment uploads is listed in the stacks' `*.assets.json` manifests. The synthesized templates say
    // which function or layer uses each one; the rest (static files, custom-resource code) are other assets. The
    // templates themselves are uploaded too, and are left out here as they are for every tool.
    const usage = new Map<string, { name: string; kind: Artifact['kind'] }>();
    for (const file of readdirSync(out).filter((name) => name.endsWith('.template.json'))) {
      const template = JSON.parse(readFileSync(join(out, file), 'utf8')) as {
        Resources?: Record<string, { Type?: string; Metadata?: Record<string, string> }>;
      };
      for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
        const assetPath = resource.Metadata?.['aws:asset:path'];
        if (!assetPath) continue;
        const kind = resource.Type === 'AWS::Lambda::Function' ? 'function' : resource.Type === 'AWS::Lambda::LayerVersion' ? 'layer' : 'asset';
        if (!usage.has(assetPath) || kind === 'function') usage.set(assetPath, { name: logicalId, kind });
      }
    }
    const seen = new Set<string>();
    for (const file of readdirSync(out).filter((name) => name.endsWith('.assets.json'))) {
      const manifest = JSON.parse(readFileSync(join(out, file), 'utf8')) as {
        files?: Record<string, { source?: { path?: string; packaging?: string } }>;
        dockerImages?: Record<string, unknown>;
      };
      if (Object.keys(manifest.dockerImages ?? {}).length) notes.push(`${file} lists Docker image assets, not measured`);
      for (const [hash, entry] of Object.entries(manifest.files ?? {})) {
        const path = entry.source?.path;
        if (!path || path.endsWith('.template.json') || seen.has(path)) continue;
        seen.add(path);
        const { name, kind } = usage.get(path) ?? { name: `asset ${hash.slice(0, 12)}`, kind: 'asset' as const };
        const full = join(out, path);
        if (entry.source?.packaging === 'file') {
          if (path.endsWith('.zip')) {
            const target = mkdtempSync(join(tmpdir(), 'cdk-file-asset-'));
            try {
              runOnce({ command: 'unzip', args: ['-q', '-o', full, '-d', target], cwd: out });
              artifacts.push({ ...measureDirectory({ root: target, name, kind, toolZipBytes: statSync(full).size }) });
            } finally {
              removePaths([target]);
            }
          } else {
            const bytes = statSync(full).size;
            artifacts.push({ name, kind, unzippedBytes: bytes, zippedBytes: bytes, toolZipBytes: null, contentHash: hash, fileCount: 1 });
          }
        } else {
          artifacts.push(measureDirectory({ root: full, name, kind }));
        }
      }
    }
    if (artifacts.length === 0) notes.push('cdk.out listed no file assets');
    return { artifacts, toolReportedMs: null, notes };
  },
  discardRunOutput: () => {
    // CDK's output directory is also its warm-run cache, so a run's output is kept until cleanCaches.
  },
  cleanCaches: (dir, config) => {
    removePaths([cdkOutDir(dir, config), join(dir, 'cdk.out'), join(dir, '.cdk.staging')]);
  }
});

// ---------------------------------------------------------------------------
// SST
// ---------------------------------------------------------------------------

const createSstAdapter = (ctx: ToolContext): ToolAdapter => ({
  id: 'sst',
  label: 'SST',
  availability: () =>
    ctx.allowSstAwsBootstrap
      ? { ok: true }
      : {
          ok: false,
          reason:
            'SST v4 has no command that packages functions without contacting AWS. `sst diff` bootstraps the ' +
            'account (two S3 buckets, an ECR repository and an SSM parameter) before it previews, and on an ' +
            'empty state the preview does not build function bundles at all. Set ' +
            'BENCH_ALLOW_SST_AWS_BOOTSTRAP=1 only against a disposable account you own.'
        },
  prepare: () => ({}),
  command: (dir, config) => ({
    command: join(dir, 'node_modules', '.bin', 'sst'),
    args: ['diff', '--stage', ctx.stage],
    cwd: dir,
    env: { BENCH_CONFIG: config, AWS_PROFILE: ctx.awsProfile, AWS_REGION: ctx.awsRegion }
  }),
  collect: (dir) => {
    const artifacts: Artifact[] = [];
    const artifactsDir = join(dir, '.sst', 'artifacts');
    if (!exists(artifactsDir)) {
      return { artifacts, toolReportedMs: null, notes: ['.sst/artifacts was not produced'] };
    }
    for (const entry of readdirSync(artifactsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      artifacts.push(measureDirectory({ root: join(artifactsDir, entry.name), name: entry.name, kind: 'function' }));
    }
    return { artifacts, toolReportedMs: null, notes: [] };
  },
  discardRunOutput: () => {},
  cleanCaches: (dir) => {
    removePaths([join(dir, '.sst', 'artifacts'), join(dir, '.sst', 'outputs.json'), join(dir, '.sst', 'esbuild.json')]);
  }
});

// ---------------------------------------------------------------------------
// Serverless Framework v4
// ---------------------------------------------------------------------------

const createServerlessAdapter = (ctx: ToolContext): ToolAdapter => ({
  id: 'serverless',
  label: 'Serverless Framework',
  availability: () =>
    ctx.serverlessAccessKey
      ? { ok: true }
      : {
          ok: false,
          reason:
            'Serverless Framework v4 refuses to run without a licence: `serverless package` fails with ' +
            '"You must sign in or use a license key". Set SERVERLESS_ACCESS_KEY to include it.'
        },
  prepare: () => ({}),
  command: (dir, config) => ({
    command: join(dir, 'node_modules', '.bin', 'serverless'),
    args: [
      'package',
      '--config',
      config === 'defaults' ? 'serverless.defaults.yml' : 'serverless.yml',
      '--stage',
      ctx.stage,
      '--region',
      ctx.awsRegion
    ],
    cwd: dir,
    env: {
      ...(ctx.serverlessAccessKey ? { SERVERLESS_ACCESS_KEY: ctx.serverlessAccessKey } : {}),
      AWS_PROFILE: ctx.awsProfile,
      AWS_REGION: ctx.awsRegion,
      SLS_TELEMETRY_DISABLED: '1'
    }
  }),
  collect: (dir, config, _prepared, stdout) => {
    const out = join(dir, '.serverless');
    const artifacts: Artifact[] = [];
    const notes: string[] = [];
    if (!exists(out)) return { artifacts, toolReportedMs: null, notes: ['.serverless was not produced'] };

    // Serverless Framework's default is one package for the whole service: every function in the stack
    // is deployed from the same zip and therefore loads all of it. Count the functions the package
    // serves, so the size and footprint tables say what a function actually carries.
    const configFile = join(dir, config === 'defaults' ? 'serverless.defaults.yml' : 'serverless.yml');
    const servesFunctionCount = exists(configFile)
      ? (readFileSync(configFile, 'utf8').match(/^ {4}handler:/gm) ?? []).length
      : 1;

    for (const entry of readdirSync(out, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;
      // Serverless hands over zips only; the runner unpacks them into tmp/ before measuring.
      artifacts.push({
        name: entry.name.replace(/\.zip$/, ''),
        kind: 'function',
        unzippedBytes: 0,
        zippedBytes: 0,
        toolZipBytes: statSync(join(out, entry.name)).size,
        contentHash: '',
        fileCount: 0,
        servesFunctionCount
      });
    }
    if (artifacts.length === 1 && servesFunctionCount > 1) {
      notes.push(
        `one service package deployed to all ${servesFunctionCount} functions (Serverless Framework's default)`
      );
    }
    const reported = stdout.replace(/\[[0-9;]*m/g, '').match(/Service packaged \(([0-9.]+)\s*(ms|s)\)/);
    return {
      artifacts,
      toolReportedMs: reported ? Math.round(Number(reported[1]) * (reported[2] === 'ms' ? 1 : 1000)) : null,
      notes
    };
  },
  discardRunOutput: () => {},
  cleanCaches: (dir) => {
    removePaths([join(dir, '.serverless'), join(dir, '.esbuild')]);
  }
});

export const createAdapters = (ctx: ToolContext): Record<string, ToolAdapter> => ({
  stacktape: createStacktapeAdapter(ctx),
  cdk: createCdkAdapter(),
  sst: createSstAdapter(ctx),
  serverless: createServerlessAdapter(ctx)
});
