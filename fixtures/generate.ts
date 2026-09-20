/**
 * Materializes every benchmark fixture from one template so that all four tools package byte-identical
 * application source.
 *
 * Run with:  node fixtures/generate.ts        (or `bun fixtures/generate.ts`)
 *
 * Output goes to `generated/<shape>/<tool>/`. Nothing here is tool-specific except the tool's own
 * configuration files and its devDependencies; `src/lib` and `src/handlers` are generated once per shape
 * and copied verbatim into every tool project for that shape.
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const templateDir = join(here, 'template');
const outRoot = join(repoRoot, 'generated');

// ---------------------------------------------------------------------------
// Pinned versions. Everything the benchmark installs is pinned exactly.
// ---------------------------------------------------------------------------

export const APP_DEPENDENCIES: Record<string, string> = {
  '@aws-sdk/client-dynamodb': '3.1136.0',
  '@aws-sdk/lib-dynamodb': '3.1136.0',
  '@aws-sdk/client-s3': '3.1136.0',
  'date-fns': '4.4.0',
  jose: '6.2.12',
  nanoid: '6.0.1',
  pino: '10.3.1',
  zod: '4.6.5'
};

export const APP_DEV_DEPENDENCIES: Record<string, string> = {
  '@types/node': '24.9.2',
  typescript: '5.9.3'
};

export const TOOL_DEV_DEPENDENCIES: Record<string, Record<string, string>> = {
  // The Stacktape CLI is not a project dependency; it is a standalone binary (or, for these runs,
  // the source-built CLI from the monorepo). See fixtures/stacktape/README.md.
  stacktape: {},
  cdk: {
    'aws-cdk': '2.1142.0',
    'aws-cdk-lib': '2.270.0',
    constructs: '10.8.1',
    esbuild: '0.28.2',
    tsx: '4.23.15'
  },
  sst: { sst: '4.17.1' },
  serverless: { serverless: '4.42.0' }
};

export const LAMBDA_RUNTIME = 'nodejs24.x';
export const NODE_MAJOR = 24;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ShapeKind = 'shared' | 'standalone' | 'monorepo';

export type Shape = {
  id: string;
  functions: number;
  kind: ShapeKind;
  description: string;
};

export const SHAPES: Shape[] = [
  { id: 'n1', functions: 1, kind: 'shared', description: 'S1/S2: one function' },
  { id: 'n5', functions: 5, kind: 'shared', description: 'S2: five functions sharing lib/' },
  { id: 'n10', functions: 10, kind: 'shared', description: 'S2: ten functions sharing lib/' },
  { id: 'n25', functions: 25, kind: 'shared', description: 'S2/S5/S6: 25 functions sharing lib/' },
  { id: 'n50', functions: 50, kind: 'shared', description: 'S2/S6: 50 functions sharing lib/' },
  {
    id: 'noshare25',
    functions: 25,
    kind: 'standalone',
    description: 'S3 control: 25 functions that share nothing'
  },
  {
    id: 'mono10',
    functions: 10,
    kind: 'monorepo',
    description: 'S4: pnpm workspace, packages/lib + apps/api, 10 functions'
  }
];

export const TOOLS = ['stacktape', 'cdk', 'sst', 'serverless'] as const;
export type ToolId = (typeof TOOLS)[number];

/** Dependency subsets for the "shares nothing" control shape. */
const STANDALONE_SUBSETS: string[][] = [
  ['ddb', 'zod', 'datefns'],
  ['s3', 'pino', 'nanoid'],
  ['jose', 'zod', 'nanoid'],
  ['ddb', 's3', 'pino', 'datefns'],
  ['s3', 'zod', 'jose', 'pino']
];

const SUBSET_PACKAGES: Record<string, string[]> = {
  ddb: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'],
  s3: ['@aws-sdk/client-s3'],
  zod: ['zod'],
  pino: ['pino'],
  jose: ['jose'],
  datefns: ['date-fns'],
  nanoid: ['nanoid']
};

const LIB_FILES = ['auth.ts', 'aws-clients.ts', 'logger.ts', 'schema.ts', 'util.ts'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
export const handlerFileName = (i: number) => `handler-${pad(i)}.ts`;
export const handlerResourceName = (i: number) => `handler${pad(i)}`;

/** Strips /*#IF:feature*\/ ... /*#END*\/ blocks whose feature is not in `features`. */
const applyFeatureBlocks = (source: string, features: string[]) => {
  const lines = source.split('\n');
  const out: string[] = [];
  const stack: boolean[] = [];
  for (const line of lines) {
    const open = line.match(/^\s*\/\*#IF:([a-z0-9]+)\*\/\s*$/);
    if (open) {
      stack.push(features.includes(open[1]));
      continue;
    }
    if (/^\s*\/\*#END\*\/\s*$/.test(line)) {
      stack.pop();
      continue;
    }
    if (stack.every(Boolean)) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
};

const substitute = (source: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (acc, [key, value]) => acc.replaceAll(`__${key}__`, value),
    source
  );

const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const writeText = async (path: string, value: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value.endsWith('\n') ? value : `${value}\n`);
};

// ---------------------------------------------------------------------------
// Application source
// ---------------------------------------------------------------------------

type AppSource = {
  /** relative path inside the project -> file contents */
  files: Record<string, string>;
  /** npm packages the generated source actually imports */
  dependencies: Record<string, string>;
  /** entry file path of each function, relative to the project root */
  entries: { name: string; entry: string }[];
};

const buildSharedApp = async (
  functions: number,
  layout: 'flat' | 'monorepo'
): Promise<AppSource> => {
  const handlerTemplate = await readFile(join(templateDir, 'handlers', 'shared-handler.ts.tpl'), 'utf8');
  const libSources = Object.fromEntries(
    await Promise.all(
      LIB_FILES.map(async (f) => [f, await readFile(join(templateDir, 'lib', f), 'utf8')] as const)
    )
  );

  const files: Record<string, string> = {};
  const entries: { name: string; entry: string }[] = [];
  const libImport = layout === 'monorepo' ? '@bench/lib' : '../lib';
  const handlerDir = layout === 'monorepo' ? 'apps/api/src/handlers' : 'src/handlers';
  const libDir = layout === 'monorepo' ? 'packages/lib/src' : 'src/lib';

  for (const [name, source] of Object.entries(libSources)) files[`${libDir}/${name}`] = source;

  for (let i = 1; i <= functions; i += 1) {
    const file = `${handlerDir}/${handlerFileName(i)}`;
    files[file] = substitute(handlerTemplate, {
      LIB: libImport,
      INDEX: String(i),
      NAME: handlerResourceName(i),
      ROUTE: `orders-${pad(i)}`
    });
    entries.push({ name: handlerResourceName(i), entry: file });
  }

  return { files, dependencies: { ...APP_DEPENDENCIES }, entries };
};

const buildStandaloneApp = async (functions: number): Promise<AppSource> => {
  const template = await readFile(join(templateDir, 'handlers', 'standalone-handler.ts.tpl'), 'utf8');
  const files: Record<string, string> = {};
  const entries: { name: string; entry: string }[] = [];
  const used = new Set<string>();

  for (let i = 1; i <= functions; i += 1) {
    const features = STANDALONE_SUBSETS[(i - 1) % STANDALONE_SUBSETS.length];
    for (const feature of features) for (const pkg of SUBSET_PACKAGES[feature]) used.add(pkg);
    const body = substitute(applyFeatureBlocks(template, features), {
      INDEX: String(i),
      NAME: handlerResourceName(i),
      ROUTE: `orders-${pad(i)}`
    });
    const file = `src/handlers/${handlerFileName(i)}`;
    files[file] = body;
    entries.push({ name: handlerResourceName(i), entry: file });
  }

  const dependencies = Object.fromEntries(
    Object.entries(APP_DEPENDENCIES).filter(([name]) => used.has(name))
  );
  return { files, dependencies, entries };
};

const buildContainerApp = async (): Promise<AppSource> => {
  const shared = await buildSharedApp(10, 'flat');
  const server = await readFile(join(templateDir, 'server.ts'), 'utf8');
  const routes = [
    '// Generated: maps a URL path to the same handler the Lambda shapes package.',
    ...shared.entries.map(
      (e, i) => `import { handler as ${e.name} } from './handlers/${handlerFileName(i + 1).replace(/\.ts$/, '')}';`
    ),
    '',
    'type RouteHandler = (event: {',
    '  body?: string | null;',
    '  headers?: Record<string, string | undefined>;',
    '  requestContext?: { requestId?: string };',
    '}) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>;',
    '',
    'export const routes: Record<string, RouteHandler> = {',
    ...shared.entries.map((e, i) => `  'orders-${pad(i + 1)}': ${e.name},`),
    '};',
    ''
  ].join('\n');

  return {
    files: { ...shared.files, 'src/server.ts': server, 'src/routes.ts': routes },
    dependencies: { ...APP_DEPENDENCIES },
    entries: [{ name: 'api', entry: 'src/server.ts' }]
  };
};

// ---------------------------------------------------------------------------
// Tool configuration files
// ---------------------------------------------------------------------------

const yamlList = (items: string[], indent: string) =>
  items.map((item) => `${indent}- ${item}`).join('\n');

const stacktapeConfig = (entries: { name: string; entry: string }[], mode: 'likeforlike' | 'defaults') => {
  const lines = ['# Generated by fixtures/generate.ts - do not edit by hand.', 'resources:'];
  for (const { name, entry } of entries) {
    lines.push(`  ${name}:`);
    lines.push('    type: function');
    lines.push('    properties:');
    lines.push('      packaging:');
    lines.push('        type: stacktape-lambda-buildpack');
    lines.push('        properties:');
    lines.push(`          entryfilePath: ${entry}`);
    if (mode === 'likeforlike') {
      lines.push('          languageSpecificConfig:');
      lines.push(`            nodeVersion: ${NODE_MAJOR}`);
      lines.push('            outputModuleFormat: esm');
      lines.push('            minify: true');
      lines.push('            disableSourceMaps: true');
      lines.push('      memory: 512');
      lines.push('      timeout: 15');
    }
  }
  return lines.join('\n');
};

const stacktapeContainerConfig = () =>
  [
    '# Generated by fixtures/generate.ts - do not edit by hand.',
    'resources:',
    '  api:',
    '    type: web-service',
    '    properties:',
    '      packaging:',
    '        type: stacktape-image-buildpack',
    '        properties:',
    '          entryfilePath: src/server.ts',
    '          languageSpecificConfig:',
    `            nodeVersion: ${NODE_MAJOR}`,
    '            outputModuleFormat: esm',
    '            minify: true',
    '            disableSourceMaps: true',
    '      resources:',
    '        cpu: 0.25',
    '        memory: 512'
  ].join('\n');

const cdkApp = (entries: { name: string; entry: string }[]) =>
  `// Generated by fixtures/generate.ts - do not edit by hand.
//
// BENCH_CONFIG=likeforlike -> minify on, no source maps, @aws-sdk/* external, ESM, target node${NODE_MAJOR}
// BENCH_CONFIG=defaults    -> NodejsFunction with only \`entry\`
import { App, Stack } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';

const mode = process.env.BENCH_CONFIG === 'defaults' ? 'defaults' : 'likeforlike';

// aws-cdk-lib may not expose NODEJS_${NODE_MAJOR}_X yet; fall back and let the runner record which one ran.
const runtime =
  (Runtime as unknown as Record<string, Runtime>).NODEJS_${NODE_MAJOR}_X ?? Runtime.NODEJS_22_X;

const app = new App();
// Environment-agnostic on purpose: \`cdk synth\` then needs no AWS credentials and no account lookups.
const stack = new Stack(app, 'PackagingBenchmark');

const entries: [string, string][] = [
${entries.map(({ name, entry }) => `  ['${name}', '${entry}']`).join(',\n')}
];

for (const [name, entry] of entries) {
  if (mode === 'defaults') {
    new NodejsFunction(stack, name, { entry, runtime });
  } else {
    new NodejsFunction(stack, name, {
      entry,
      runtime,
      bundling: {
        minify: true,
        sourceMap: false,
        externalModules: ['@aws-sdk/*'],
        format: OutputFormat.ESM,
        target: 'node${NODE_MAJOR}'
      }
    });
  }
}

app.synth();
`;

const sstConfig = (entries: { name: string; entry: string }[]) =>
  `/// <reference path="./.sst/platform/config.d.ts" />
// Generated by fixtures/generate.ts - do not edit by hand.
//
// BENCH_CONFIG=likeforlike -> nodejs.minify + nodejs.sourcemap:false + @aws-sdk/* external
// BENCH_CONFIG=defaults    -> sst.aws.Function with only \`handler\`
//
// SST v4 has no command that packages functions without contacting and bootstrapping AWS.
// See fixtures/sst/README.md: the benchmark records SST as blocked rather than bootstrapping an
// account in order to measure it.
export default $config({
  app() {
    return { name: 'packaging-benchmark', removal: 'remove', home: 'aws' };
  },
  async run() {
    const mode = process.env.BENCH_CONFIG === 'defaults' ? 'defaults' : 'likeforlike';
    const entries: [string, string][] = [
${entries.map(({ name, entry }) => `      ['${name}', '${entry.replace(/\.ts$/, '')}.handler']`).join(',\n')}
    ];
    for (const [name, handler] of entries) {
      if (mode === 'defaults') {
        new sst.aws.Function(name, { handler });
      } else {
        new sst.aws.Function(name, {
          handler,
          runtime: '${LAMBDA_RUNTIME}',
          nodejs: {
            minify: true,
            sourcemap: false,
            install: [],
            esbuild: { external: ['@aws-sdk/*'], format: 'esm', target: 'node${NODE_MAJOR}' }
          }
        });
      }
    }
  }
});
`;

const serverlessConfig = (entries: { name: string; entry: string }[], mode: 'likeforlike' | 'defaults') => {
  const lines = [
    '# Generated by fixtures/generate.ts - do not edit by hand.',
    'service: packaging-benchmark',
    'provider:',
    '  name: aws',
    `  runtime: ${LAMBDA_RUNTIME}`,
    '  region: eu-west-1'
  ];
  if (mode === 'likeforlike') {
    lines.push('build:', '  esbuild:', '    minify: true', '    sourcemap: false', '    external:');
    lines.push(yamlList(["'@aws-sdk/*'"], '      '));
  }
  lines.push('functions:');
  for (const { name, entry } of entries) {
    lines.push(`  ${name}:`);
    lines.push(`    handler: ${entry.replace(/\.ts$/, '')}.handler`);
  }
  return lines.join('\n');
};

const tsconfig = (extra: Record<string, unknown> = {}) => ({
  compilerOptions: {
    target: `ES2023`,
    module: 'ESNext',
    moduleResolution: 'bundler',
    lib: ['ES2023'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    noEmit: true,
    types: ['node'],
    ...extra
  },
  include: ['src', 'bin', 'apps', 'packages']
});

// ---------------------------------------------------------------------------
// Project writing
// ---------------------------------------------------------------------------

const writeProject = async ({
  dir,
  name,
  app,
  tool,
  layout
}: {
  dir: string;
  name: string;
  app: AppSource;
  tool: ToolId;
  layout: 'flat' | 'monorepo';
}) => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  for (const [file, contents] of Object.entries(app.files)) {
    await writeText(join(dir, file), contents);
  }

  const toolDeps = TOOL_DEV_DEPENDENCIES[tool];

  if (layout === 'monorepo') {
    // S4 is a pnpm workspace on purpose, so it installs with pnpm.
    // `minimumReleaseAge: 0` stops pnpm rewriting this file during install; `allowBuilds` lets
    // esbuild's postinstall place its native binary, which CDK's local bundling needs.
    await writeText(
      join(dir, 'pnpm-workspace.yaml'),
      [
        'packages:',
        '  - apps/*',
        '  - packages/*',
        'minimumReleaseAge: 0',
        'allowBuilds:',
        '  esbuild: true',
        '  sst: true',
        '  serverless: true',
        '  protobufjs: true',
        '  "@parcel/watcher": true'
      ].join('\n')
    );
    await writeJson(join(dir, 'package.json'), {
      name,
      private: true,
      type: 'module',
      devDependencies: { ...APP_DEV_DEPENDENCIES, ...toolDeps }
    });
    await writeJson(join(dir, 'packages/lib/package.json'), {
      name: '@bench/lib',
      version: '1.0.0',
      private: true,
      type: 'module',
      exports: Object.fromEntries(
        LIB_FILES.map((f) => [`./${f.replace(/\.ts$/, '')}`, `./src/${f}`])
      ),
      dependencies: app.dependencies
    });
    await writeJson(join(dir, 'apps/api/package.json'), {
      name: '@bench/api',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: { '@bench/lib': 'workspace:*', ...app.dependencies }
    });
    await writeJson(join(dir, 'tsconfig.json'), tsconfig({ paths: { '@bench/lib/*': ['./packages/lib/src/*'] } }));
  } else {
    // Flat shapes install with npm: a plain, hoisted node_modules that every tool here resolves the
    // same way, with no build-approval gate in front of esbuild's native binary.
    await writeJson(join(dir, 'package.json'), {
      name,
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: app.dependencies,
      devDependencies: { ...APP_DEV_DEPENDENCIES, ...toolDeps }
    });
    await writeJson(join(dir, 'tsconfig.json'), tsconfig());
  }

  switch (tool) {
    case 'stacktape':
      await writeText(join(dir, 'stacktape.yml'), stacktapeConfig(app.entries, 'likeforlike'));
      await writeText(join(dir, 'stacktape.defaults.yml'), stacktapeConfig(app.entries, 'defaults'));
      break;
    case 'cdk':
      await writeText(join(dir, 'bin/app.ts'), cdkApp(app.entries));
      await writeJson(join(dir, 'cdk.json'), {
        app: 'node_modules/.bin/tsx bin/app.ts',
        versionReporting: false,
        context: { '@aws-cdk/core:newStyleStackSynthesis': true }
      });
      break;
    case 'sst':
      await writeText(join(dir, 'sst.config.ts'), sstConfig(app.entries));
      break;
    case 'serverless':
      await writeText(join(dir, 'serverless.yml'), serverlessConfig(app.entries, 'likeforlike'));
      await writeText(join(dir, 'serverless.defaults.yml'), serverlessConfig(app.entries, 'defaults'));
      break;
  }
};

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

const writeContainerProjects = async () => {
  const app = await buildContainerApp();
  const base = join(outRoot, 'container');

  for (const variant of ['stacktape', 'expert', 'naive'] as const) {
    const dir = join(base, variant);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const [file, contents] of Object.entries(app.files)) await writeText(join(dir, file), contents);
    await writeJson(join(dir, 'package.json'), {
      name: `packaging-benchmark-container-${variant}`,
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: { start: 'node dist/server.js' },
      dependencies: app.dependencies,
      devDependencies: { ...APP_DEV_DEPENDENCIES, esbuild: TOOL_DEV_DEPENDENCIES.cdk.esbuild }
    });
    await writeJson(join(dir, 'tsconfig.json'), tsconfig());
    if (variant === 'stacktape') {
      await writeText(join(dir, 'stacktape.yml'), stacktapeContainerConfig());
    } else {
      await cp(
        join(here, 'containers', variant === 'expert' ? 'Dockerfile.expert' : 'Dockerfile.naive'),
        join(dir, 'Dockerfile')
      );
      await cp(join(here, 'containers', '.dockerignore'), join(dir, '.dockerignore'));
      if (variant === 'expert') {
        await cp(join(here, 'containers', 'build.mjs'), join(dir, 'build.mjs'));
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const main = async () => {
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });

  for (const shape of SHAPES) {
    const layout = shape.kind === 'monorepo' ? 'monorepo' : 'flat';
    const app =
      shape.kind === 'standalone'
        ? await buildStandaloneApp(shape.functions)
        : await buildSharedApp(shape.functions, layout);

    for (const tool of TOOLS) {
      await writeProject({
        dir: join(outRoot, shape.id, tool),
        name: `packaging-benchmark-${shape.id}-${tool}`,
        app,
        tool,
        layout
      });
    }
    process.stdout.write(`generated ${shape.id} (${shape.functions} functions, ${shape.kind})\n`);
  }

  await writeContainerProjects();
  process.stdout.write('generated container projects (stacktape, expert, naive)\n');
};

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  await main();
}

export { main };
