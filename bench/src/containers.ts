/**
 * Container comparison: five ways to ship the same application as a long-running HTTP service.
 *
 * - `stacktape`, `nixpacks`, `paketo`: built by `stacktape package`, with the packaging types
 *   `stacktape-image-buildpack`, `nixpacks` and `external-buildpack` (Paketo's builder).
 * - `expert`, `typical`: `docker build` of a hand-written Dockerfile.
 *
 * Per variant, one after another:
 *
 * 1. A discarded build, so no registry download (base images, builders, run images, lifecycle) lands in a
 *    measurement. Base images of the Dockerfile variants are pulled before any variant runs.
 * 2. Cold build. Every build cache the variant could use is cleared first: the BuildKit cache
 *    (`docker builder prune -af`), the variant's previous image, Stacktape's build output in the project, and pack's
 *    cache volumes. Dockerfiles also build with `--no-cache`.
 * 3. Rebuild after a source-only edit: one statement appended to `src/server.ts`, cache on.
 * 4. Rebuild after a dependency change: `jose` moved to its previous patch release in `package.json` and the
 *    lockfile (every dependency is already at its newest release), cache on, the source edit still in place.
 *
 * For every build, the image's layers are read from `docker save`: each layer blob's digest and its compressed size,
 * which is what a push sends. A rebuild's registry bytes are the compressed sizes of the layers whose digest the
 * image before it did not have. Every edit is reverted afterwards.
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exists, removePaths, runOnce } from './measure.ts';
import type { ToolContext } from './tools.ts';

const BASE_IMAGES = ['node:24-slim', 'node:24'];

let DEPENDENCY_CHANGE = { name: 'jose', from: '6.2.12', to: '6.2.11' };
let SOURCE_FILE = join('src', 'server.ts');

const VARIANTS: Record<string, { label: string; builtBy: 'docker' | 'stacktape' }> = {
  stacktape: { label: 'Stacktape image buildpack', builtBy: 'stacktape' },
  nixpacks: { label: 'nixpacks, through Stacktape', builtBy: 'stacktape' },
  paketo: { label: 'Paketo buildpacks, through Stacktape', builtBy: 'stacktape' },
  expert: { label: 'Expert hand-written Dockerfile', builtBy: 'docker' },
  typical: { label: 'Typical Dockerfile (Node.js guide)', builtBy: 'docker' }
};

const docker = (args: string[], timeoutMs = 600000) =>
  runOnce({ command: 'docker', args, cwd: process.cwd(), timeoutMs });

const dockerImageSize = (reference: string) => {
  const result = docker(['image', 'inspect', '--format', '{{.Size}}', reference]);
  if (result.exitCode !== 0) return null;
  return Number(result.stdout.trim().split('\n').pop());
};

/** Reads /etc/os-release out of an image, so the report can say which base each variant ships on. */
const imageBase = (reference: string) => {
  const result = docker(['run', '--rm', '--entrypoint', '/bin/sh', reference, '-c', 'cat /etc/os-release'], 120000);
  if (result.exitCode !== 0) return null;
  return result.stdout.match(/PRETTY_NAME="([^"]+)"/)?.[1] ?? null;
};

/** repository:tag -> image id. A rebuild keeps the tag and changes the id. */
const listImages = () => {
  const result = docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}\t{{.ID}}']);
  const map = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const [reference, id] = line.split('\t');
    if (reference && id && !reference.startsWith('<none>')) map.set(reference.trim(), id.trim());
  }
  return map;
};

const touchedImages = (before: Map<string, string>, after: Map<string, string>) =>
  [...after.entries()].filter(([reference, id]) => before.get(reference) !== id).map(([reference]) => reference);

type Layer = {
  digest: string;
  /** What a push sends for this layer. */
  bytes: number;
  uncompressedBytes: number;
  /** How the blob is stored locally: `gzip`, or `none` (then `bytes` is its gzip size at the default level, as a push compresses it). */
  storedAs: 'gzip' | 'none';
};

/**
 * The image's layers as a push sends them: blob digest and compressed size, from `docker save`, plus each layer's
 * uncompressed size. (With Docker 29's containerd image store, `docker image inspect --format '{{.Size}}'` is the
 * compressed size, not the uncompressed one.)
 */
const imageLayers = (reference: string): Layer[] | null => {
  const directory = mkdtempSync(join(tmpdir(), 'container-layers-'));
  const archive = join(directory, 'image.tar');
  try {
    if (docker(['save', reference, '-o', archive]).exitCode !== 0) return null;
    const manifest = runOnce({ command: 'tar', args: ['-xOf', archive, 'manifest.json'], cwd: directory });
    const listing = runOnce({ command: 'tar', args: ['-tvf', archive], cwd: directory });
    if (manifest.exitCode !== 0 || listing.exitCode !== 0) return null;
    const sizes = new Map<string, number>();
    for (const line of listing.stdout.split('\n')) {
      const match = line.match(/^\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(\S+)$/);
      if (match) sizes.set(match[2], Number(match[1]));
    }
    const [entry] = JSON.parse(manifest.stdout) as { Layers: string[] }[];
    // BuildKit stores layers gzip-compressed; pack hands the daemon plain tar layers, which a push compresses.
    const script =
      'magic=$(tar -xOf "$0" "$1" | head -c 2 | od -An -tx1 | tr -d " \\n"); ' +
      'if [ "$magic" = "1f8b" ]; then echo "gzip $(tar -xOf "$0" "$1" | gzip -dc | wc -c)"; ' +
      'else echo "none $(tar -xOf "$0" "$1" | gzip -c | wc -c)"; fi';
    return entry.Layers.map((path) => {
      const blobBytes = sizes.get(path) ?? 0;
      const probe = runOnce({ command: 'sh', args: ['-c', script, archive, path], cwd: directory, timeoutMs: 600000 });
      const [storedAs, other] = probe.stdout.trim().split(' ');
      return storedAs === 'gzip'
        ? { digest: path.split('/').pop()!, bytes: blobBytes, uncompressedBytes: Number(other) || 0, storedAs: 'gzip' as const }
        : { digest: path.split('/').pop()!, bytes: Number(other) || 0, uncompressedBytes: blobBytes, storedAs: 'none' as const };
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** What a registry holding `before` would receive for `after`: the layers whose digest it does not have. */
const registryDelta = (before: Layer[] | null, after: Layer[] | null) => {
  if (!before || !after) return null;
  const known = new Set(before.map((layer) => layer.digest));
  const added = after.filter((layer) => !known.has(layer.digest));
  return {
    changedLayers: added.length,
    totalLayers: after.length,
    bytes: added.reduce((sum, layer) => sum + layer.bytes, 0)
  };
};

const totalBytes = (layers: Layer[] | null) => (layers ? layers.reduce((sum, layer) => sum + layer.bytes, 0) : null);
const totalUncompressedBytes = (layers: Layer[] | null) =>
  layers ? layers.reduce((sum, layer) => sum + layer.uncompressedBytes, 0) : null;

const pruneBuildCache = () => docker(['builder', 'prune', '-af'], 600000);

const removePackCacheVolumes = () => {
  const volumes = docker(['volume', 'ls', '--quiet', '--filter', 'name=pack-cache-']).stdout.split('\n').filter(Boolean);
  if (volumes.length) docker(['volume', 'rm', '--force', ...volumes]);
  return volumes;
};

const appendToSource = (dir: string, marker: string) => {
  const file = join(dir, SOURCE_FILE);
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, `${original}\nexport const benchmarkTouch = '${marker}';\n`);
  return () => writeFileSync(file, original);
};

/**
 * Moves one dependency to another exact version in package.json and the lockfile, as a teammate's commit would
 * bring it: both files change and the local node_modules does not. The new lockfile is resolved in a scratch copy,
 * because `npm install --package-lock-only` in the project also rewrites `node_modules/.package-lock.json` (npm
 * 11.12.1), after which a later `npm install` believes the old tree is current and installs nothing.
 */
const changeDependency = (dir: string) => {
  const manifestPath = join(dir, 'package.json');
  const lockfilePath = join(dir, 'package-lock.json');
  const manifest = readFileSync(manifestPath, 'utf8');
  const lockfile = readFileSync(lockfilePath, 'utf8');
  const parsed = JSON.parse(manifest);
  if (parsed.dependencies?.[DEPENDENCY_CHANGE.name] !== DEPENDENCY_CHANGE.from) {
    throw new Error(`${dir}: expected ${DEPENDENCY_CHANGE.name}@${DEPENDENCY_CHANGE.from} in package.json`);
  }
  parsed.dependencies[DEPENDENCY_CHANGE.name] = DEPENDENCY_CHANGE.to;
  const scratch = mkdtempSync(join(tmpdir(), 'container-dependency-'));
  try {
    writeFileSync(join(scratch, 'package.json'), `${JSON.stringify(parsed, null, 2)}\n`);
    writeFileSync(join(scratch, 'package-lock.json'), lockfile);
    const lock = runOnce({
      command: 'npm',
      args: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      cwd: scratch,
      timeoutMs: 300000
    });
    if (lock.exitCode !== 0) throw new Error(`${dir}: resolving the lockfile failed: ${lock.stderr.slice(-800)}`);
    copyFileSync(join(scratch, 'package.json'), manifestPath);
    copyFileSync(join(scratch, 'package-lock.json'), lockfilePath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return () => {
    writeFileSync(manifestPath, manifest);
    writeFileSync(lockfilePath, lockfile);
    // Stacktape installs the changed tree into node_modules; `npm ci` puts the original back exactly.
    runOnce({ command: 'npm', args: ['ci', '--no-audit', '--no-fund'], cwd: dir, timeoutMs: 600000 });
  };
};

const installedVersion = (dir: string, name: string) => {
  const path = join(dir, 'node_modules', name, 'package.json');
  return exists(path) ? (JSON.parse(readFileSync(path, 'utf8')).version as string) : null;
};

export const runContainerBenchmark = ({
  repoRoot,
  ctx,
  log,
  variants,
  load1m,
  base = join(repoRoot, 'generated', 'container'),
  sourceFile,
  dependencyChange
}: {
  repoRoot: string;
  ctx: ToolContext;
  log: (message: string) => void;
  variants: string[];
  load1m: () => number;
  /** Where the variants' projects are, the file the source edit appends to, and the dependency the rebuild moves. */
  base?: string;
  sourceFile?: string;
  dependencyChange?: { name: string; from: string; to: string };
}) => {
  if (sourceFile) SOURCE_FILE = sourceFile;
  if (dependencyChange) DEPENDENCY_CHANGE = dependencyChange;
  const out: Record<string, unknown>[] = [];

  if (docker(['version']).exitCode !== 0) return [{ error: 'docker is not available' }];
  for (const image of BASE_IMAGES) docker(['pull', '--quiet', image], 900000);

  for (const variant of variants) {
    const dir = join(base, variant);
    const { label, builtBy } = VARIANTS[variant];
    if (!exists(dir)) continue;
    const loadBefore = load1m();
    log(`container ${variant}: one-minute load ${loadBefore}`);
    const notes: string[] = [];
    const dockerTag = `packaging-benchmark-${variant}:bench`;

    const build = (mode: 'cold' | 'cached') => {
      if (builtBy === 'docker') {
        const before = listImages();
        const result = runOnce({
          command: 'docker',
          args: ['build', ...(mode === 'cold' ? ['--no-cache'] : []), '--progress', 'plain', '-t', dockerTag, '.'],
          cwd: dir,
          env: { DOCKER_BUILDKIT: '1' },
          timeoutMs: 1800000
        });
        return { result, reference: touchedImages(before, listImages()).includes(dockerTag) ? dockerTag : null };
      }
      const before = listImages();
      const result = runOnce({
        command: ctx.stacktapeBinary,
        args: [
          'package',
          '--configPath',
          join(dir, 'stacktape.yml'),
          '--projectName',
          ctx.projectName,
          '--stage',
          ctx.stage,
          '--region',
          ctx.awsRegion,
          '--profile',
          ctx.awsProfile
        ],
        cwd: dir,
        timeoutMs: 1800000
      });
      const touched = touchedImages(before, listImages());
      notes.push(`${mode} build touched: ${touched.join(', ') || 'no image'}`);
      return { result, reference: touched[0] ?? null };
    };

    const clearCaches = (reference: string | null) => {
      removePaths([join(dir, '.stacktape'), join(dir, '.stacktape-stack-info')]);
      if (reference) docker(['image', 'rm', '--force', reference]);
      if (variant === 'paketo') notes.push(`removed pack cache volumes: ${removePackCacheVolumes().join(', ') || 'none'}`);
      pruneBuildCache();
    };

    let warmupMs: number | null = null;
    let previousReference: string | null = builtBy === 'docker' ? dockerTag : null;
    if (builtBy === 'stacktape') {
      const warmup = build('cached');
      warmupMs = Math.round(warmup.result.wallMs);
      previousReference = warmup.reference;
      if (warmup.result.exitCode !== 0) notes.push(`warm-up failed: ${(warmup.result.stderr || warmup.result.stdout).slice(-600)}`);
    }

    clearCaches(previousReference);
    const cold = build('cold');
    const reference = cold.reference;
    const coldLayers = reference ? imageLayers(reference) : null;
    const size = reference ? dockerImageSize(reference) : null;

    const revertSource = appendToSource(dir, `container-${variant}`);
    let sourceEdit: ReturnType<typeof build> | null = null;
    let dependencyChange: ReturnType<typeof build> | null = null;
    let sourceLayers: Layer[] | null = null;
    let dependencyLayers: Layer[] | null = null;
    let revertDependency: (() => void) | null = null;
    try {
      sourceEdit = build('cached');
      sourceLayers = sourceEdit.reference ? imageLayers(sourceEdit.reference) : null;
      revertDependency = changeDependency(dir);
      dependencyChange = build('cached');
      dependencyLayers = dependencyChange.reference ? imageLayers(dependencyChange.reference) : null;
      if (variant === 'stacktape') {
        notes.push(`node_modules/${DEPENDENCY_CHANGE.name} after the dependency rebuild: ${installedVersion(dir, DEPENDENCY_CHANGE.name)}`);
      }
    } finally {
      revertSource();
      revertDependency?.();
    }

    const ok =
      cold.result.exitCode === 0 && sourceEdit?.result.exitCode === 0 && dependencyChange?.result.exitCode === 0;
    const failed = [cold, sourceEdit, dependencyChange].find((run) => run && run.result.exitCode !== 0);
    out.push({
      variant,
      label,
      builtBy,
      ok,
      imageReference: reference,
      // `docker image inspect` Size: with the containerd image store, the size of the stored blobs.
      inspectSizeBytes: size,
      imageCompressedBytes: totalBytes(coldLayers),
      imageUncompressedBytes: totalUncompressedBytes(coldLayers),
      layersStoredUncompressed: coldLayers ? coldLayers.filter((layer) => layer.storedAs === 'none').length : null,
      baseImage: reference ? imageBase(reference) : null,
      coldBuildMs: Math.round(cold.result.wallMs),
      sourceEditRebuildMs: sourceEdit ? Math.round(sourceEdit.result.wallMs) : null,
      dependencyChangeRebuildMs: dependencyChange ? Math.round(dependencyChange.result.wallMs) : null,
      registryBytes: {
        firstPush: totalBytes(coldLayers),
        sourceEdit: registryDelta(coldLayers, sourceLayers),
        dependencyChange: registryDelta(sourceLayers, dependencyLayers)
      },
      dependencyChange: `${DEPENDENCY_CHANGE.name} ${DEPENDENCY_CHANGE.from} -> ${DEPENDENCY_CHANGE.to}`,
      warmupMs,
      command:
        builtBy === 'docker'
          ? `docker builder prune -af && docker build --no-cache -t ${dockerTag} .`
          : `docker builder prune -af && stacktape package --configPath ${join(dir, 'stacktape.yml')} ...`,
      notes,
      error: failed ? (failed.result.stderr || failed.result.stdout).slice(-2000) : null,
      measuredAt: new Date().toISOString(),
      load1m: { before: loadBefore, after: load1m() }
    });
    log(
      `container ${variant}: ${size} bytes, cold ${Math.round(cold.result.wallMs)}ms, source edit ` +
        `${sourceEdit ? Math.round(sourceEdit.result.wallMs) : '-'}ms, dependency change ` +
        `${dependencyChange ? Math.round(dependencyChange.result.wallMs) : '-'}ms`
    );
  }

  return out;
};
