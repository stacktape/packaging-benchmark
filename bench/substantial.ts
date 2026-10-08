import { createAdapters } from './src/tools.ts';
import { runOnce, measureDirectory } from './src/measure.ts';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, loadavg, cpus } from 'node:os';
import { createHash } from 'node:crypto';

const count = Number(process.argv[2] || 1);
const samples = Number(process.argv[3] || 5);
const format = process.argv[4] || 'cjs';
const fixture = resolve('generated', `reports-${count}${format === 'esm' ? '-esm' : ''}`);
const binary = process.env.BENCH_STACKTAPE_BINARY!;
if (!binary) throw new Error('BENCH_STACKTAPE_BINARY is required.');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('tmp', `substantial-${count}-${format}-${runId}`);
mkdirSync(resolve('tmp'), { recursive: true });
mkdirSync(output, { recursive: false });
const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
const source = join(fixture, 'src', 'report-0.ts');
const baseline = readFileSync(source, 'utf8');
const adapters = createAdapters({ stacktapeBinary: binary, stacktapeRepo: process.env.BENCH_STACKTAPE_REPO || '', awsProfile: 'stacktape-e2e', awsRegion: 'eu-west-1', projectName: `benchreports${count}`, stage: 'dev', serverlessAccessKey: process.env.SERVERLESS_ACCESS_KEY || null, allowSstAwsBootstrap: false });
const tools = ['stacktape', 'cdk', 'serverless'];
const result: Record<string, unknown> = {
  kind: 'native-command-packaging-pilot', count, samples, format, fixture,
  timing: 'Complete package command / CDK synth wall time. CDK directory-asset and Stacktape shared-layer ZIP creation are deferred; no claim of identical archive-complete work.',
  cache: 'Project build caches cleared for cold; dependencies and credential/bootstrap caches retained. OS caches not controlled.',
  sizes: 'Native ZIP bytes where available; normalized ZIP bytes are estimates only.',
  runtimeQualification: 'pending', sourceMapPolicy: 'disabled', minification: 'syntax and whitespace; identifiers retained',
  configs: { serverlessIndividually: true, cdkApp: 'plain JavaScript, no infrastructure typecheck', sst: 'separate guarded live-stage pilot' },
  versions: manifest.devDependencies, node: process.version, host: cpus()[0].model,
  stacktapeSha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
  fixtureLockSha256: createHash('sha256').update(readFileSync(join(fixture, 'pnpm-lock.yaml'))).digest('hex'),
  samplesRaw: []
};
const save = () => writeFileSync(join(output, 'results.json'), JSON.stringify(result, null, 2));
const rows = result.samplesRaw as Record<string, unknown>[];

const materializeServerless = (artifacts: ReturnType<typeof measureDirectory>[]) => artifacts.map(a => {
  const zip = join(fixture, '.serverless', a.name + '.zip');
  const target = mkdtempSync(join(tmpdir(), 'report-bench-'));
  try {
    const extraction = runOnce({ command: 'unzip', args: ['-q', zip, '-d', target], cwd: fixture });
    if (extraction.exitCode !== 0) throw new Error('Cannot inspect Serverless ZIP.');
    return measureDirectory({ root: target, name: a.name, kind: 'function', toolZipBytes: statSync(zip).size });
  } finally { rmSync(target, { recursive: true, force: true }); }
});

try {
  for (let index = 0; index < samples; index++) {
    for (const state of ['cold', 'edit', 'unchanged']) {
      writeFileSync(source, state === 'cold' ? baseline : baseline.replace("const revision = 'base';", `const revision = 'edit-${runId}-${index}';`));
      // Rotate the order per block, including in raw failure records.
      for (let offset = 0; offset < tools.length; offset++) {
        const tool = tools[(index + offset) % tools.length];
        const adapter = adapters[tool];
        const cooldownStart = Date.now();
        while (loadavg()[0] > 2 && Date.now() - cooldownStart < 120_000) {
          console.log(`Cooling down host: load ${loadavg()[0].toFixed(2)}`);
          await new Promise(resolve => setTimeout(resolve, 10_000));
        }
        const cooldownMs = Date.now() - cooldownStart;
        const loadBefore = loadavg()[0];
        if (loadBefore > 2) throw new Error(`Host load ${loadBefore.toFixed(2)} exceeds predeclared maximum 2; aborting without excluding prior samples.`);
        if (state === 'cold') adapter.cleanCaches(fixture, 'app');
        const prepared = adapter.prepare(fixture, 'app');
        const command = adapter.command(fixture, 'app');
        command.env = { ...command.env, AWS_PROFILE: 'stacktape-e2e', AWS_REGION: 'eu-west-1', CDK_DEFAULT_ACCOUNT: '597581086285', CDK_DEFAULT_REGION: 'eu-west-1', CI: 'true', NO_COLOR: '1' };
        const measured = runOnce({ ...command, timeoutMs: 120_000 });
        const log = `${index}-${state}-${tool}.log`;
        writeFileSync(join(output, log), measured.stdout + '\n' + measured.stderr);
        const collected = measured.exitCode === 0 ? adapter.collect(fixture, 'app', prepared, measured.stdout + measured.stderr) : null;
        const artifacts = tool === 'serverless' && collected ? materializeServerless(collected.artifacts) : collected?.artifacts;
        rows.push({ index, state, tool, command: [command.command, ...command.args], wallMs: measured.wallMs, exitCode: measured.exitCode, loadBefore, cooldownMs, loadAfter: loadavg()[0], log, artifacts, notes: collected?.notes });
        save();
        console.log(JSON.stringify({ index, state, tool, wallMs: Math.round(measured.wallMs), exitCode: measured.exitCode, unzippedBytes: artifacts?.reduce((sum, a) => sum + a.unzippedBytes, 0) }));
        if (measured.exitCode !== 0) throw new Error(`${tool} failed; see ${join(output, log)}`);
      }
    }
  }
} finally {
  writeFileSync(source, baseline);
  save();
  console.log(output);
}
