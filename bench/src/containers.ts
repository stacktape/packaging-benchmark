/**
 * Container comparison: Stacktape's image buildpack, an expert hand-written Dockerfile and a naive one.
 *
 * Measured per variant: image size, cold build time (build cache pruned first, `--no-cache`), and warm
 * rebuild time after a one-line source change with the cache on. Base images are pulled before any
 * timing so a registry download never lands inside a measurement.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exists, runOnce } from './measure.ts';
import type { ToolContext } from './tools.ts';

const BASE_IMAGES = ['node:24-slim', 'node:24'];

const dockerImageSize = (reference: string) => {
  const result = runOnce({
    command: 'docker',
    args: ['image', 'inspect', '--format', '{{.Size}}', reference],
    cwd: process.cwd()
  });
  if (result.exitCode !== 0) return null;
  return Number(result.stdout.trim().split('\n').pop());
};

const listImages = () => {
  const result = runOnce({
    command: 'docker',
    args: ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'],
    cwd: process.cwd()
  });
  return new Set(result.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
};

const prunePBuildCache = () =>
  runOnce({ command: 'docker', args: ['builder', 'prune', '-af'], cwd: process.cwd(), timeoutMs: 600000 });

const touchSource = (dir: string, marker: string) => {
  const file = join(dir, 'src', 'server.ts');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, `${original}\nexport const benchmarkTouch = '${marker}';\n`);
  return () => writeFileSync(file, original);
};

export const runContainerBenchmark = ({
  repoRoot,
  ctx,
  log
}: {
  repoRoot: string;
  ctx: ToolContext;
  log: (message: string) => void;
}) => {
  const base = join(repoRoot, 'generated', 'container');
  const out: unknown[] = [];

  if (runOnce({ command: 'docker', args: ['version'], cwd: repoRoot }).exitCode !== 0) {
    return [{ error: 'docker is not available' }];
  }
  for (const image of BASE_IMAGES) {
    runOnce({ command: 'docker', args: ['pull', '--quiet', image], cwd: repoRoot, timeoutMs: 900000 });
  }

  // --- Dockerfile variants -------------------------------------------------
  for (const variant of ['expert', 'naive'] as const) {
    const dir = join(base, variant);
    if (!exists(dir)) continue;
    const tag = `packaging-benchmark-${variant}:bench`;

    prunePBuildCache();
    const cold = runOnce({
      command: 'docker',
      args: ['build', '--no-cache', '--progress', 'plain', '-t', tag, '.'],
      cwd: dir,
      env: { DOCKER_BUILDKIT: '1' },
      timeoutMs: 1800000
    });
    const size = dockerImageSize(tag);

    const revert = touchSource(dir, `container-${variant}`);
    const warm = runOnce({
      command: 'docker',
      args: ['build', '--progress', 'plain', '-t', tag, '.'],
      cwd: dir,
      env: { DOCKER_BUILDKIT: '1' },
      timeoutMs: 1800000
    });
    revert();

    out.push({
      variant,
      label: variant === 'expert' ? 'Expert hand-written Dockerfile' : 'Naive Dockerfile',
      ok: cold.exitCode === 0 && warm.exitCode === 0,
      imageSizeBytes: size,
      coldBuildMs: Math.round(cold.wallMs),
      warmRebuildMs: Math.round(warm.wallMs),
      command: `docker builder prune -af && docker build --no-cache -t ${tag} .`,
      error: cold.exitCode === 0 ? null : (cold.stderr || cold.stdout).slice(-1500)
    });
    log(`container ${variant}: ${size} bytes, cold ${Math.round(cold.wallMs)}ms, warm ${Math.round(warm.wallMs)}ms`);
  }

  // --- Stacktape image buildpack -------------------------------------------
  const stacktapeDir = join(base, 'stacktape');
  if (exists(stacktapeDir) && exists(join(ctx.stacktapeRepo, 'apps', 'cli', 'scripts', 'dev.ts'))) {
    const cliDir = join(ctx.stacktapeRepo, 'apps', 'cli');
    const command = {
      command: 'bun',
      args: [
        'run',
        'scripts/dev.ts',
        'package',
        '--configPath',
        join(stacktapeDir, 'stacktape.yml'),
        '--projectName',
        ctx.projectName,
        '--stage',
        ctx.stage,
        '--region',
        ctx.awsRegion,
        '--profile',
        ctx.awsProfile
      ],
      cwd: cliDir,
      env: { SKIP_LOADING_ENV: '1' },
      timeoutMs: 1800000
    };

    // A first, discarded build so Stacktape's own base images are pulled before anything is timed.
    const warmup = runOnce(command);
    const before = listImages();

    prunePBuildCache();
    const cold = runOnce(command);
    const after = listImages();
    const newImages = [...after].filter((image) => !before.has(image) && !image.startsWith('<none>'));
    const candidate =
      newImages.find((image) => image.includes(ctx.projectName)) ??
      newImages[0] ??
      [...after].find((image) => image.includes(ctx.projectName)) ??
      null;
    const size = candidate ? dockerImageSize(candidate) : null;

    const revert = touchSource(stacktapeDir, 'container-stacktape');
    const warm = runOnce(command);
    revert();

    out.push({
      variant: 'stacktape',
      label: 'Stacktape image buildpack (web-service)',
      ok: cold.exitCode === 0 && warm.exitCode === 0,
      imageReference: candidate,
      imageSizeBytes: size,
      coldBuildMs: Math.round(cold.wallMs),
      warmRebuildMs: Math.round(warm.wallMs),
      warmupMs: Math.round(warmup.wallMs),
      command: `docker builder prune -af && stacktape package --configPath ${join(stacktapeDir, 'stacktape.yml')} ...`,
      error: cold.exitCode === 0 ? null : (cold.stderr || cold.stdout).slice(-2000)
    });
    log(`container stacktape: ${size} bytes, cold ${Math.round(cold.wallMs)}ms, warm ${Math.round(warm.wallMs)}ms`);
  }

  return out;
};
