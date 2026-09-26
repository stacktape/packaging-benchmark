/** Captures the machine and tool versions the numbers were produced on. */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, totalmem, release, type as osType } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const tryExec = (cmd: string, cwd?: string) => {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const readFirstMatch = (path: string, pattern: RegExp) => {
  try {
    const match = readFileSync(path, 'utf8').match(pattern);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
};

export type Environment = ReturnType<typeof captureEnvironment>;

/** The measured executable itself: its SHA-256, size and the version its release data reports. */
const describeBinary = (path: string) => ({
  path,
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  bytes: statSync(path).size,
  version: readFirstMatch(join(dirname(path), 'release-data.json'), /"version"\s*:\s*"([^"]+)"/)
});

export const captureEnvironment = ({
  stacktapeRepo,
  stacktapeBinary,
  stacktapeBinaryCommit,
  toolVersions
}: {
  stacktapeRepo: string | null;
  stacktapeBinary: string | null;
  /** The commit the binary was built from, as the person building it recorded it. */
  stacktapeBinaryCommit: string | null;
  toolVersions: Record<string, string | null>;
}) => ({
  capturedAt: new Date().toISOString(),
  cpu: {
    model: cpus()[0]?.model ?? 'unknown',
    logicalCores: cpus().length,
    physicalCores: Number(tryExec("lscpu | awk -F: '/^Core\\(s\\) per socket/ {print $2}'")) || null,
    sockets: Number(tryExec("lscpu | awk -F: '/^Socket\\(s\\)/ {print $2}'")) || null
  },
  memoryBytes: totalmem(),
  os: {
    type: osType(),
    release: release(),
    distribution: readFirstMatch('/etc/os-release', /PRETTY_NAME="([^"]+)"/),
    wsl: release().toLowerCase().includes('microsoft')
  },
  runtimes: {
    node: process.version,
    bun: tryExec('bun --version'),
    pnpm: tryExec('pnpm --version'),
    npm: tryExec('npm --version'),
    docker: tryExec('docker --version')
  },
  toolVersions,
  stacktape: stacktapeRepo
    ? {
        source: 'Linux release build from the Stacktape monorepo, made by its production release functions',
        repoPath: stacktapeRepo.replaceAll(homedir(), '~'),
        builtFromCommit: stacktapeBinaryCommit,
        repoHeadWhenReported: tryExec('git rev-parse HEAD', stacktapeRepo),
        // The private Console submodule is not part of the CLI build.
        dirtyFiles:
          Number(tryExec('git status --porcelain --ignore-submodules=all | wc -l', stacktapeRepo) ?? '0') || 0,
        binary: stacktapeBinary ? describeBinary(stacktapeBinary) : null
      }
    : null
});
