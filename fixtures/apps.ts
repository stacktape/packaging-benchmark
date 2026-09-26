/**
 * Materializes the real-application fixtures.
 *
 * Run with:  node fixtures/apps.ts
 *
 * Every fixture in `fixtures/apps/<id>/` holds one application from Stacktape's starter projects (`app/`) and that
 * application's configuration for each tool (`stacktape/`, `cdk/`, `serverless/`, `sst/`). For each tool the generator
 * writes a standalone project to `generated/apps/<id>/<tool>/`: the application, the tool's own files, and a
 * package.json that adds the tool's `package.json` fragment to the application's. Every tool therefore packages
 * byte-identical application source. It also writes `fixtures/apps/<id>/README.md`, with the four configurations side
 * by side, from the same files.
 */

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appsRoot = join(here, 'apps');
const outRoot = join(here, '..', 'generated', 'apps');

export const APP_TOOLS = ['stacktape', 'cdk', 'serverless', 'sst'] as const;
export type AppTool = (typeof APP_TOOLS)[number];

export const TOOL_LABELS: Record<AppTool, string> = {
  stacktape: 'Stacktape',
  cdk: 'AWS CDK',
  serverless: 'Serverless Framework',
  sst: 'SST'
};

export type AppFixture = {
  id: string;
  title: string;
  /** The starter project in the Stacktape repository, `apps/cli/starter-projects/<starter>`. */
  starter: string;
  about: string;
  tools: AppTool[];
  packageManager: 'npm' | 'pnpm';
  /** The one-line change the incremental measurement applies to a handler, and reverts. */
  edit: { file: string; from: string; to: string };
  changesFromStarter: string[];
  /** The file each tool's configuration lives in, shown in the README. */
  configFiles: Partial<Record<AppTool, string[]>>;
  notes: Partial<Record<AppTool, string[]>>;
  /** Why SST was not deployed for this fixture, when it was not. */
  sstNotDeployed?: string;
};

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  );

export const loadAppFixtures = async (): Promise<AppFixture[]> => {
  const ids = (await readdir(appsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('container-'))
    .map((entry) => entry.name)
    .sort();
  const fixtures: AppFixture[] = [];
  for (const id of ids) {
    const path = join(appsRoot, id, 'fixture.json');
    if (!(await exists(path))) continue;
    fixtures.push({ id, ...(await readJson<Omit<AppFixture, 'id'>>(path)) });
  }
  return fixtures;
};

type PackageFragment = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
};

const sortKeys = (value: Record<string, string> | undefined) =>
  value ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) : undefined;

/** The application's package.json with the tool's fragment added; a tool's version of a package wins. */
const mergePackage = (app: PackageFragment, tool: PackageFragment): PackageFragment => {
  const merged: PackageFragment = { ...app, ...tool };
  for (const key of ['scripts', 'dependencies', 'devDependencies'] as const) {
    const combined = { ...(app[key] ?? {}), ...(tool[key] ?? {}) };
    if (Object.keys(combined).length) merged[key] = key === 'scripts' ? combined : sortKeys(combined);
    else delete merged[key];
  }
  // A package listed as a runtime dependency by the application stays one, whatever the tool fragment says.
  for (const name of Object.keys(merged.dependencies ?? {})) delete merged.devDependencies?.[name];
  return merged;
};

const copyTree = async (from: string, to: string, skip: (name: string) => boolean) => {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true });
      await copyTree(source, target, () => false);
    } else {
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }
  }
};

const writeProject = async (fixture: AppFixture, tool: AppTool) => {
  const dir = join(outRoot, fixture.id, tool);
  const fixtureDir = join(appsRoot, fixture.id);
  // Keep an installed node_modules and lockfile, so regenerating does not force a reinstall.
  const keep = new Set(['node_modules', 'package-lock.json', 'pnpm-lock.yaml']);
  if (await exists(dir)) {
    for (const entry of await readdir(dir)) if (!keep.has(entry)) await rm(join(dir, entry), { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });
  await copyTree(join(fixtureDir, 'app'), dir, (name) => name === 'package.json');
  await copyTree(join(fixtureDir, tool), dir, (name) => name === 'package.json');
  const appPackage = await readJson<PackageFragment>(join(fixtureDir, 'app', 'package.json'));
  const toolPackagePath = join(fixtureDir, tool, 'package.json');
  const toolPackage = (await exists(toolPackagePath)) ? await readJson<PackageFragment>(toolPackagePath) : {};
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(mergePackage(appPackage, toolPackage), null, 2)}\n`);
};

const fence = (path: string) => (path.endsWith('.ts') ? 'ts' : path.endsWith('.json') ? 'json' : 'yaml');

const lineCount = (text: string) => text.trimEnd().split('\n').length;

/** One table cell: each configuration file of one tool, with its line count. */
const configCell = async (fixture: AppFixture, tool: AppTool) => {
  const files = fixture.configFiles[tool] ?? [];
  const parts: string[] = [];
  for (const file of files) {
    const text = (await readFile(join(appsRoot, fixture.id, tool, file), 'utf8')).trimEnd();
    parts.push(`\`${file}\`, ${lineCount(text)} lines`, '', `\`\`\`${fence(file)}`, text, '```', '');
  }
  return parts.join('\n');
};

const renderReadme = async (fixture: AppFixture) => {
  const tools = fixture.tools;
  const rows: AppTool[][] = [];
  for (let index = 0; index < tools.length; index += 2) rows.push(tools.slice(index, index + 2));
  const lines = [
    `# ${fixture.title}`,
    '',
    '<!-- Generated by fixtures/apps.ts from the files in this directory. Edit those, then regenerate. -->',
    '',
    fixture.about,
    '',
    `The application is Stacktape's starter project \`${fixture.starter}\` ` +
      '(`apps/cli/starter-projects/` in the Stacktape repository), in `app/`.' +
      (fixture.changesFromStarter.length ? ' Changes from the starter:' : ' It is unchanged.'),
    '',
    ...fixture.changesFromStarter.map((change) => `- ${change}`),
    ...(fixture.changesFromStarter.length ? [''] : []),
    `The incremental measurement changes one line of \`${fixture.edit.file}\`, from \`${fixture.edit.from}\` to ` +
      `\`${fixture.edit.to}\`, and packages again.`,
    '',
    '## The configurations',
    '',
    '<table>'
  ];
  for (const row of rows) {
    lines.push('<tr>', ...row.map((tool) => `<th>${TOOL_LABELS[tool]}</th>`), '</tr>', '<tr>');
    for (const tool of row) lines.push('<td valign="top">', '', await configCell(fixture, tool), '</td>');
    lines.push('</tr>');
  }
  lines.push('</table>', '');
  const noted = tools.filter((tool) => (fixture.notes[tool] ?? []).length);
  if (noted.length || fixture.sstNotDeployed) {
    lines.push('## Notes per tool', '');
    for (const tool of noted) {
      lines.push(`**${TOOL_LABELS[tool]}**`, '', ...(fixture.notes[tool] ?? []).map((note) => `- ${note}`), '');
    }
    if (fixture.sstNotDeployed) lines.push(`**SST was not measured for this fixture.** ${fixture.sstNotDeployed}`, '');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
};

const main = async () => {
  const only = process.argv.slice(2);
  const fixtures = (await loadAppFixtures()).filter((fixture) => !only.length || only.includes(fixture.id));
  for (const fixture of fixtures) {
    const readme = await renderReadme(fixture);
    // The edit must match exactly one place, or the incremental measurement would change nothing, or too much.
    const edited = await readFile(join(appsRoot, fixture.id, 'app', fixture.edit.file), 'utf8');
    if (edited.split(fixture.edit.from).length !== 2) {
      throw new Error(`${fixture.id}: the edit must match exactly one place in ${fixture.edit.file}`);
    }
    for (const tool of fixture.tools) await writeProject(fixture, tool);
    await writeFile(join(appsRoot, fixture.id, 'README.md'), readme);
    process.stdout.write(`generated ${fixture.id} (${fixture.tools.join(', ')})\n`);
  }
};

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) await main();

export { outRoot as appsOutRoot, relative };
