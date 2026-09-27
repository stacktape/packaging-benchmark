/** The real-application sections of results/RESULTS.md: one table per fixture, SST, containers. */

import type { AppFixture } from '../../fixtures/apps.ts';

type Any = Record<string, any>;

const secs = (ms: number | null | undefined) => (ms == null ? '-' : `${(ms / 1000).toFixed(2)} s`);
const size = (bytes: number | null | undefined) =>
  bytes == null ? '-' : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : null;
};
const table = (headers: string[], rows: string[][]) =>
  [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

const LABELS: Record<string, string> = { stacktape: 'Stacktape', cdk: 'AWS CDK', serverless: 'Serverless Framework', sst: 'SST*' };

const ships = (m: Any) => {
  const t = m.totals as Any | undefined;
  if (!t) return '-';
  const parts = [`${t.functionArtifacts} function package${t.functionArtifacts === 1 ? '' : 's'}`];
  if (t.layerArtifacts) parts.push(`${t.layerArtifacts} layer`);
  if (t.otherAssets) parts.push(`${t.otherAssets} other upload${t.otherAssets === 1 ? '' : 's'}`);
  return parts.join(' + ');
};

const reupload = (m: Any) => {
  const changes = (m.edit?.changes ?? []) as Any[];
  if (!changes.length) return '-';
  const bytes = median(changes.map((c) => c.changedZippedBytes));
  const changed = median(changes.map((c) => c.changedCount));
  return `${size(bytes)} (${changed} of ${changes[0].totalCount})`;
};

/** The cold package time of one fixture and tool, or why there is none. */
export const coldCell = (results: Any, fixture: AppFixture, tool: string) => {
  if (tool === 'sst') {
    const m = ((results.appsSst?.measurements ?? []) as Any[]).find((x) => x.fixture === fixture.id);
    return m?.ok ? `${secs(m.cold.medianMs)}*` : 'not measured';
  }
  if (fixture.notPackageable?.[tool as keyof AppFixture['notPackageable']]) return 'not packageable †';
  const m = ((results.apps ?? []) as Any[]).find((x) => x.fixture === fixture.id && x.tool === tool);
  return m?.ok ? secs(m.cold.medianMs) : '-';
};

export const uploadCell = (results: Any, fixture: AppFixture, tool: string) => {
  const m =
    tool === 'sst'
      ? ((results.appsSst?.measurements ?? []) as Any[]).find((x) => x.fixture === fixture.id)
      : ((results.apps ?? []) as Any[]).find((x) => x.fixture === fixture.id && x.tool === tool);
  return m?.ok && m.totals ? `${size(m.totals.firstDeployUploadZippedBytes)}${tool === 'sst' ? '*' : ''}` : '-';
};

export const renderAppsReport = (results: Any, fixtures: AppFixture[]) => {
  const lines: string[] = ['## Real applications', ''];
  lines.push(
    'Each fixture is one of Stacktape\'s starter projects, configured for each tool the way its users write it ' +
      '(`fixtures/apps/<fixture>/README.md` shows the four configurations side by side). Median of 5 runs after one ' +
      'discarded run. **Cold**: the tool\'s build output and caches in the project deleted before each run. **After a ' +
      'one-line change**: one line of a handler changed (and changed back) before each run, the tool\'s caches warm. ' +
      '**First-deploy upload**: the distinct packages a first deployment uploads, each zipped deterministically; code ' +
      'a tool deploys for its own custom resources is left out (CDK\'s is listed below). **Re-upload**: the zipped ' +
      'bytes of the packages whose content changed with the one-line change, and how many of how many changed.',
    '',
    '\\* SST has no packaging command. Its numbers are `sst diff` against a deployed stage: a rebuild of every ' +
      'function bundle plus a Pulumi preview against AWS. † Not packageable after one reasonable attempt; the ' +
      'fixture README says why.',
    ''
  );
  for (const fixture of fixtures) {
    lines.push(`### ${fixture.title}`, '', `[\`${fixture.id}\`](../fixtures/apps/${fixture.id}/README.md). ${fixture.about}`, '');
    const rows: string[][] = [];
    for (const tool of fixture.tools) {
      const reason = fixture.notPackageable?.[tool as keyof AppFixture['notPackageable']];
      if (reason) {
        rows.push([LABELS[tool], 'not packageable †', '-', '-', '-', '-']);
        continue;
      }
      const m =
        tool === 'sst'
          ? ((results.appsSst?.measurements ?? []) as Any[]).find((x) => x.fixture === fixture.id)
          : ((results.apps ?? []) as Any[]).find((x) => x.fixture === fixture.id && x.tool === tool);
      if (!m?.ok) {
        rows.push([LABELS[tool], tool === 'sst' ? 'not measured' : `failed`, '-', '-', '-', '-']);
        continue;
      }
      rows.push([LABELS[tool], secs(m.cold.medianMs), secs(m.edit.medianMs), m.totals ? size(m.totals.firstDeployUploadZippedBytes) : 'not kept ‡', reupload(m), ships(m)]);
    }
    lines.push(table(['Tool', 'Cold package', 'After a one-line change', 'First-deploy upload', 'Re-upload after the change', 'What a deploy uploads'], rows), '');
    const plumbing = ((results.apps ?? []) as Any[]).find((x) => x.fixture === fixture.id && x.tool === 'cdk' && x.totals?.toolPlumbingZippedBytes);
    if (plumbing) lines.push(`CDK also uploads ${size(plumbing.totals.toolPlumbingZippedBytes)} of its own custom-resource code for this stack.`, '');
    if (fixture.sstNotDeployed) lines.push(`SST: ${fixture.sstNotDeployed}`, '');
    if (((results.appsSst?.measurements ?? []) as Any[]).some((x) => x.fixture === fixture.id && x.recoveredFromRunLog)) {
      lines.push("‡ A runner bug dropped SST's entry for this fixture from `results.json`. Its medians are the ones the runner logged; the individual samples and the package sizes were not kept, and measuring them again needs another deployed stage.", '');
    }
  }

  const sst = (results.appsSst?.measurements ?? []) as Any[];
  if (sst.length) {
    lines.push('## SST deployments', '');
    lines.push(
      'Every SST stage was deployed to the shared development account in eu-west-1 after an explicit account check, ' +
        'recorded in a state file before creation, removed with `sst remove` and checked afterwards: nothing tagged ' +
        'with its app and stage, and its passphrase parameter deleted. The region\'s SST bootstrap (two buckets, an ' +
        'ECR repository, an SSM parameter) did not exist before; this run created it and removed it.',
      ''
    );
    lines.push(table(['Fixture', 'Stage', 'Deploy', 'AWS time', 'Removed and verified'], sst.map((m) => [m.fixture, m.stage, secs(m.deployMs), secs(m.awsMs), m.cleanup?.verifiedGone ? 'yes' : 'no'])), '');
    if (results.appsSst?.interruptedStage) {
      const s = results.appsSst.interruptedStage;
      lines.push(`A first attempt at \`${s.fixture}\` (stage \`${s.stage}\`) was stopped after its deploy by the runner's own time limit, before its cleanup ran; it was ${s.removal}. Deployed ${s.deployedFor}.`, '');
    }
    if (results.appsSst?.finalVerification) lines.push(`Final check: ${results.appsSst.finalVerification.stages.length} stages, 0 tagged resources, 0 IAM roles, 0 SST parameters or buckets in the region, no \`sst-asset\` repository.`, '');
  }

  const containers = (results.appContainers ?? []) as Any[];
  if (containers.length) {
    lines.push('## Containers', '');
    lines.push(
      'The Express starter as a long-running service (Stacktape `web-service`), built four ways; one sample per cell. ' +
        'Image sizes come from `docker save` (compressed: what a push sends). A cold build clears every cache the path ' +
        'could use. The source edit appends a statement to `src/index.ts`; the dependency change moves `express` from ' +
        '5.2.1 to 5.2.0 in `package.json` and the lockfile. Push: the compressed layers a registry holding the previous ' +
        'image receives.',
      ''
    );
    const order = ['stacktape', 'typical', 'nixpacks', 'paketo'];
    lines.push(
      table(
        ['Build', 'Runtime base', 'Image, compressed', 'Cold build', 'Rebuild after a source edit', 'Rebuild after a dependency change', 'Push after the source edit', 'Push after the dependency change', 'Load at start'],
        containers
          .sort((a, b) => order.indexOf(a.variant) - order.indexOf(b.variant))
          .map((c) => [c.label, c.baseImage ?? '-', size(c.imageCompressedBytes), secs(c.coldBuildMs), secs(c.sourceEditRebuildMs), secs(c.dependencyChangeRebuildMs), size(c.registryBytes?.sourceEdit?.bytes), size(c.registryBytes?.dependencyChange?.bytes), String(c.load1m?.before ?? '-')])
      ),
      ''
    );
  }
  return lines.join('\n');
};
