/** Timing, sizing, hashing and deterministic-zip helpers shared by every tool adapter. */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

export type Sample = { wallMs: number; exitCode: number };

export type RunResult = {
  samples: Sample[];
  medianMs: number;
  minMs: number;
  maxMs: number;
  ok: boolean;
  stdout: string;
  stderr: string;
};

export type FileEntry = { path: string; bytes: number; sha256: string };

export type Artifact = {
  name: string;
  /** `asset`: anything else a first deployment uploads, such as static files served from a bucket. */
  kind: 'function' | 'layer' | 'asset';
  /** Sum of the bytes of every file in the artifact. */
  unzippedBytes: number;
  /** Deterministic zip size computed by this benchmark (see README, "How size is measured"). */
  zippedBytes: number;
  /** Size of the zip the tool itself produced, when it produced one. */
  toolZipBytes: number | null;
  /** Hash of the artifact's contents - file paths and file bytes, never the zip container. */
  contentHash: string;
  fileCount: number;
  /** For layers: the functions whose code references this layer. */
  attachedFunctions?: string[];
  /**
   * How many Lambda functions are deployed from this one artifact. Serverless Framework's default is
   * one package for the whole service, so a single artifact serves every function in the stack.
   */
  servesFunctionCount?: number;
  /** Code the tool itself deploys for its own custom resources, not the application's; reported apart. */
  toolPlumbing?: boolean;
};

export const walkFiles = (root: string): FileEntry[] => {
  const out: FileEntry[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const bytes = readFileSync(full);
        out.push({
          path: relative(root, full).split(sep).join('/'),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex')
        });
      }
    }
  };
  visit(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
};

/**
 * Exact size of a zip archive holding these files, computed without shelling out.
 *
 * Every tool's artifacts are sized this way so the numbers are comparable: some tools hand over a
 * directory (CDK assets, Stacktape layers) and some hand over their own zip, and zip implementations
 * differ in compression level and in whether they store directory entries. Files only, deflate level 9,
 * store when deflate does not help - which is what every deployment zip does.
 */
export const deterministicZipBytes = (root: string, files: FileEntry[]) => {
  let total = 0;
  for (const file of files) {
    const raw = readFileSync(join(root, ...file.path.split('/')));
    const deflated = deflateRawSync(raw, { level: 9 });
    const payload = deflated.length < raw.length ? deflated.length : raw.length;
    const nameLength = Buffer.byteLength(file.path, 'utf8');
    total += 30 + nameLength + payload; // local file header + name + data
    total += 46 + nameLength; // central directory header + name
  }
  total += 22; // end of central directory record
  return total;
};

export const hashArtifact = (files: FileEntry[]) => {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.sha256}\0`);
  return hash.digest('hex');
};

export const measureDirectory = ({
  root,
  name,
  kind,
  toolZipBytes = null,
  exclude = []
}: {
  root: string;
  name: string;
  kind: Artifact['kind'];
  toolZipBytes?: number | null;
  /** Relative paths to leave out, for tools that drop their own zip beside the bundle it holds. */
  exclude?: string[];
}): Artifact => {
  const files = walkFiles(root).filter((f) => !exclude.includes(f.path));
  return {
    name,
    kind,
    unzippedBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    zippedBytes: deterministicZipBytes(root, files),
    toolZipBytes,
    contentHash: hashArtifact(files),
    fileCount: files.length
  };
};

export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

export type Command = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

/**
 * Variables that tell a tool an AI coding agent runs it (the list the AWS CDK CLI checks, plus the agent's own session
 * variables). The tools run as in a developer's terminal, without them.
 */
const AGENT_VARIABLES = /^(AI_AGENT|AGENT|CLAUDECODE|CLAUDE_.*|CODEX_.*|CURSOR_AGENT|VSCODE_AGENT|CLINE_ACTIVE|GEMINI_CLI|OPENCODE|COPILOT_CLI|AUGMENT_AGENT|QWEN_CODE)$/;

export const toolEnvironment = (extra: Record<string, string> = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !AGENT_VARIABLES.test(name))),
  ...extra
});

export const runOnce = (cmd: Command): Sample & { stdout: string; stderr: string } => {
  const startedAt = performance.now();
  const result = spawnSync(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    env: toolEnvironment(cmd.env),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: cmd.timeoutMs ?? 30 * 60 * 1000
  });
  const wallMs = performance.now() - startedAt;
  return {
    wallMs,
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
};

export const printableCommand = (cmd: Command) =>
  `${Object.entries(cmd.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')}${cmd.env ? ' ' : ''}${cmd.command} ${cmd.args.join(' ')}`
    .trim()
    .replaceAll(homedir(), '~');

export const removePaths = (paths: string[]) => {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
};

export const exists = (path: string) => {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
};
