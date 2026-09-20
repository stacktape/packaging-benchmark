/** Captures the machine and tool versions the numbers were produced on. */

import { execSync } from 'node:child_process';
import { cpus, totalmem, release, type as osType } from 'node:os';
import { readFileSync } from 'node:fs';

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

export const captureEnvironment = ({
  stacktapeRepo,
  toolVersions
}: {
  stacktapeRepo: string | null;
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
        source: 'source-built CLI from the Stacktape monorepo',
        repoPath: stacktapeRepo,
        commit: tryExec('git rev-parse HEAD', stacktapeRepo),
        dirtyFiles: Number(tryExec('git status --porcelain | wc -l', stacktapeRepo) ?? '0') || 0
      }
    : null
});
