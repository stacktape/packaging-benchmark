# Stacktape packaging benchmark

How fast four deployment tools package real applications for AWS Lambda, and how much a first deployment uploads:
**Stacktape**, **AWS CDK**, **Serverless Framework** and **SST**. Plus the same API built as a container four ways.

The applications are Stacktape's own starter projects (an Express API with Prisma and PostgreSQL, a Hono API, an API
on DynamoDB, an event-driven pipeline, a Step Functions workflow, a pnpm monorepo, a Puppeteer scraper and a Next.js
site). Each is written for every tool the way that tool's users write it: its documented defaults and bundler, the
plugin its users use where one is needed, nothing tuned. Every fixture's README shows the four configurations side by
side: [`fixtures/apps/`](fixtures/apps/).

This benchmark is maintained by Stacktape, so treat it as an interested party's measurement and check it. The
applications come from Stacktape's starters; where a tool could not package one without extra work, the table says so
and the fixture README says why. Read [what this benchmark does not measure](#what-this-benchmark-does-not-measure)
and the [caveats](#caveats) before quoting anything.

Numbers, every sample and every artifact: [`results/RESULTS.md`](results/RESULTS.md) and
[`results/results.json`](results/results.json). Results of 27 September 2026; round one (26 September, synthetic
shapes) is in [`results/2026-09-26/`](results/2026-09-26/RESULTS.md).

---

## Headline results

Median of 5 runs, one machine (details in `results/RESULTS.md`).

### Package time, cold

The tool's build output and caches in the project deleted before each run.

| Application | Stacktape | AWS CDK | Serverless Framework | SST* |
| --- | --- | --- | --- | --- |
| Express API, Prisma, PostgreSQL | 0.58 s | 7.06 s | not packageable † | not measured |
| Hono API | 0.27 s | 2.38 s | 3.62 s | 4.26 s |
| API with DynamoDB | 0.28 s | 2.46 s | 3.77 s | 4.49 s ‡ |
| Event-driven pipeline, 3 functions | 0.27 s | 2.85 s | 3.66 s | 4.75 s ‡ |
| Step Functions workflow, 4 functions | 0.27 s | 3.13 s | 3.90 s | 10.53 s |
| pnpm monorepo | 0.26 s | 3.23 s | 4.28 s | 4.54 s |
| Puppeteer scraper (Chromium, 66 MB) | 2.09 s | 3.10 s | 11.60 s | 10.27 s ‡ |
| Next.js with Drizzle | 19.80 s | not packageable † | no Next.js support | not measured |

### Package time after changing one line of a handler

The line changed (and changed back) before each run, with the tool's caches warm, as in an edit-and-package loop.

| Application | Stacktape | AWS CDK | Serverless Framework | SST* |
| --- | --- | --- | --- | --- |
| Express API, Prisma, PostgreSQL | 0.59 s | 7.19 s | † | - |
| Hono API | 0.26 s | 2.35 s | 3.71 s | 4.37 s |
| API with DynamoDB | 0.28 s | 2.42 s | 4.06 s | 4.59 s ‡ |
| Event-driven pipeline | 0.28 s | 2.79 s | 3.77 s | 4.66 s ‡ |
| Step Functions workflow | 0.29 s | 2.98 s | 3.98 s | 10.63 s |
| pnpm monorepo | 0.25 s | 3.30 s | 3.92 s | 4.54 s |
| Puppeteer scraper | 2.10 s | 3.06 s | 13.72 s | 13.79 s ‡ |
| Next.js with Drizzle | 20.00 s | † | - | - |

### Bytes a first deployment uploads

The distinct packages (function code, layers, static files), each zipped the same way for every tool. Code a tool
deploys for its own custom resources is not counted (CDK's VPC custom resource adds 6 KB to the Express stack).

| Application | Stacktape | AWS CDK | Serverless Framework | SST* |
| --- | --- | --- | --- | --- |
| Express API, Prisma, PostgreSQL | 8.0 MB | 82.0 MB | † | - |
| Hono API | 21.4 KB | 17.5 KB | 47.5 KB | 48.3 KB |
| API with DynamoDB | 21.7 KB | 17.7 KB | 48.1 KB | ‡ |
| Event-driven pipeline | 3.5 KB | 2.6 KB | 5.6 KB | ‡ |
| Step Functions workflow | 24.5 KB | 19.8 KB | 51.8 KB | 52.6 KB |
| pnpm monorepo | 0.9 KB | 0.7 KB | 2.6 KB | 1.3 KB |
| Puppeteer scraper | 65.7 MB | 65.9 MB | 67.2 MB | ‡ |
| Next.js with Drizzle | 16.9 MB | † | - | - |

\* **SST has no packaging command.** Its numbers are `sst diff` against a deployed stage: a rebuild of every function
bundle plus a Pulumi preview against AWS. They are not comparable with the other three columns, which build locally.
Stages that needed RDS were not deployed; see [SST](#sst-was-measured-against-deployed-stages).
† Not packageable after one reasonable attempt with the setup the tool's users use: Serverless Framework's build runs
the project's `postinstall: prisma generate` in a directory without the schema; `cdk-nextjs-standalone` passes the
database URL to `next build` as unresolved CDK tokens. Details in the fixture READMEs.
‡ A runner bug lost these SST entries' samples and package sizes; the medians are the ones the runner logged.

### What the table shows

- **Stacktape packages six of the seven Lambda applications in 0.26–0.58 s**: 9–12× faster than CDK and 13–17×
  faster than Serverless Framework on the same application. For the Puppeteer scraper, where most of the work is
  copying Chromium, it takes 2.09 s: 1.5× faster than CDK and 5.5× faster than Serverless Framework. Where the other
  tools spend their time was not measured.
- **With Prisma, CDK uploads 82 MB where Stacktape uploads 8 MB.** CDK's documented recipe installs `@prisma/client`
  and the Prisma CLI into the function (227 MB unzipped, close to Lambda's 250 MB limit); Stacktape's package is
  18 MB unzipped in 5 files.
- **For small functions CDK uploads less than Stacktape** (17.5 KB against 21.4 KB for the Hono API): Stacktape's
  default package carries a source map, CDK's carries none. Serverless Framework and SST ship or upload a map too.
- **Chromium dominates the Puppeteer fixture**: every tool uploads 66–67 MB.

### Where Stacktape comes off worse

- **Stacktape's Puppeteer starter does not work as shipped.** Its configuration bundles `@sparticuz/chromium` into
  `index.js` and leaves out the browser files; the packaged handler fails with `The input directory ".../bin" does not
  exist`. This benchmark adds `dependenciesToExcludeFromBundle: ['@sparticuz/chromium']`, after which the handler
  returns 200. The first package with that option spent 36.9 s resolving the dependency; later runs 2.1 s.
- **A one-line change in a Next.js page re-uploads everything**: all 5 of Stacktape's Next.js packages (16.9 MB)
  change, not only the server function. Next.js writes a new build ID on every build, the likely cause; no other tool
  could be compared here.
- **Stacktape's container image pushes 8.3 MB after a one-statement source edit**, where the Node.js guide's
  Dockerfile pushes 19.8 KB. The layer that changes is about the size of Stacktape's Lambda package for the same
  application (bundle plus Prisma engine), so the dependencies apparently travel with every source edit; the
  Dockerfile keeps them in an earlier layer. After a dependency change Stacktape pushes 8.3 MB, the Dockerfile 199.1 MB.
- **Three starters have problems other tools' users hit**: the Next.js starter pins `next` 15.4.6, below what either
  OpenNext release accepts (15.4.11 and 15.5.15), so these fixtures use 15.5.26; the Puppeteer handler fails the
  strict type check CDK runs before every synth; the monorepo's `tsconfig.json` uses `moduleResolution: "node"`,
  which TypeScript 7 rejects.

### Containers

The Express starter as a long-running service, built four ways. One sample per cell. "Push" is what a registry that
already holds the previous image receives.

| Build | Runtime base | Image, compressed | Cold build | Rebuild, source edit | Rebuild, dependency change | Push, source edit | Push, dependency change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Stacktape image buildpack | Alpine 3.24 | 69.8 MB | 3.07 s | 1.72 s | 3.12 s | 8.3 MB | 8.3 MB |
| Dockerfile from the Node.js guide | Debian 12 (`node:24`) | 589.9 MB | 21.39 s | 0.88 s | 20.83 s | 19.8 KB | 199.1 MB |
| nixpacks, through Stacktape | Ubuntu 24.04 | 612.6 MB | 63.31 s | 28.31 s | 27.93 s | 353.3 MB | 354.5 MB |
| Paketo buildpacks, through Stacktape | Ubuntu 22.04 (Paketo Jammy) | 236.6 MB | 94.95 s | 83.12 s | 94.14 s | 18.4 KB | 121.5 MB |

The dependency change moves `express` from 5.2.1 to 5.2.0. The Dockerfile copies `prisma/` before `npm install`,
as Prisma's Docker guide does, because the install runs `prisma generate`. nixpacks 1.39.0 has no Node.js 24, so its
build uses 22. nixpacks and Paketo spend nearly all of their time in their own build, not in Stacktape. Stacktape's
image is smaller partly because its buildpack uses an Alpine base.

---

## What is measured

- **Cold package**: wall clock of the tool's own command (`stacktape package`, `cdk synth`, `serverless package`,
  `sst diff`), after deleting the tool's build output and caches in the project. Caches outside the project (npm's,
  Stacktape's AWS identity and tool cache in the home directory) are kept, as on a developer's machine.
- **After a one-line change**: the fixture's one-line edit (listed in each fixture README) applied and reverted in
  turn before each run.
- **First-deploy upload**: every distinct package a first deployment uploads, zipped deterministically (deflate level
  9, files only) so zip writers do not differ; each tool's own zip size is kept in `results.json`.
- **Re-upload after the change**: the packages whose content hash changed, in `results/RESULTS.md`.
- Median of 5 samples after one discarded run; tools run one at a time; the one-minute load average is recorded for
  every measurement, and the runner waits while it is above 2.
- The tools run without the environment variables that identify an AI coding agent (AWS CDK changes its output when
  it sees them), as in a developer's terminal.

## What this benchmark does not measure

- **Cold-start latency, run time and deploy time.** No measured package was deployed except SST's stages, and those
  only so SST would build.
- **Correctness of the packages**, beyond the Puppeteer handler above: every tool reported success; no handler ran in
  Lambda.
- **SST on equal terms**, and SST for the Express and Next.js applications: both need RDS (and Next.js CloudFront)
  deployed before `sst diff` builds anything.
- **Stacktape's artifact cache**, which reads digests from a deployed stack's bucket; this benchmark never deploys
  Stacktape, so every Stacktape run is a cold-cache run.
- **Stacktape's helper Lambdas** (about 1.2 MB), packaged beside the application and deployed where a stack uses them.

## Caveats

### SST was measured against deployed stages

Seven stages of six applications were deployed to a development AWS account in eu-west-1 after an explicit account check, each recorded in a
state file before creation, removed with `sst remove` and checked: nothing tagged with its app and stage left, and its
passphrase parameter deleted. SST bootstrapped the region (two buckets, an ECR repository, an SSM parameter); the run
removed the bootstrap too. One stage outlived its runner, which a time limit stopped before its cleanup; it was
deleted resource by resource from its tags and verified. `results/RESULTS.md` lists every stage.

SST 4.17.1's defaults differ from its docs in one place: `nodejs.minify` is documented to default to true and is not
applied, so SST bundles are unminified unless `minify: true` is set. SST also bundles the AWS SDK unless told not to;
these configurations mark `@aws-sdk/*` external where the application imports it.

### Serverless Framework contacts AWS and a licence server

`serverless package` needs a licence key and AWS credentials. It reads CloudFormation and an SSM parameter, and when
they are missing it creates a deployment bucket and that parameter; it did so in this account on 21 September. The
`serverless` npm package does not pin the framework: these runs used 4.43.0 from `~/.serverless/releases`.

### CDK type-checks before every synth

`cdk init` writes `"app": "npx tsc && npx tsx bin/<app>.ts"`, so every synth type-checks the project with TypeScript 7
first. The fixtures keep that, as a CDK user's project does. Two fixtures with their own `tsconfig.json` keep
TypeScript 5.9.3 instead.

### The Stacktape runs used an unpublished build

A Linux release build of the Stacktape monorepo at commit `571e8a06`, reporting `4.0.0-bench`, built with the
production release function from a clean tree. Its SHA-256 is in `results/RESULTS.md`.

### One machine, one run

An i7-13700K under WSL2. Every sample and each measurement's load average are in `results.json`. Transitive dependency
versions are those npm and pnpm resolved on 27 September; direct dependencies are pinned.

---

## Appendix: an API growing one function per route

Round one measured one generated application with 1, 5, 10, 25 and 50 functions, like-for-like configurations (the
same minification and source-map settings everywhere) and defaults. Stacktape was re-measured with this binary; the
other tools' numbers are from 26 September. Like-for-like, cold:

| Functions | Stacktape | AWS CDK | Serverless Framework | SST* (21 September) |
| --- | --- | --- | --- | --- |
| 1 | 0.28 s | 2.06 s | 3.48 s | 4.25 s |
| 10 | 0.32 s | 3.50 s | 3.96 s | 9.20 s |
| 50 | 0.44 s | 9.96 s | 4.69 s | 8.18 s |

The full tables, including the edit scenarios and the source-map finding in SST, are in the appendix of
`results/RESULTS.md`; the generator is `fixtures/generate.ts`.

## Reproducing it

```sh
pnpm install                                  # this repository's tooling
node fixtures/apps.ts                         # writes generated/apps/<fixture>/<tool>/
node bench/run.ts apps-install
SERVERLESS_ACCESS_KEY=... STACKTAPE_BINARY=<path to the stacktape executable> BENCH_SAMPLES=5 node bench/run.ts apps
node bench/run.ts app-containers              # needs Docker
# SST deploys to AWS: read bench/src/sst-apps.ts first.
BENCH_ALLOW_SST_AWS_BOOTSTRAP=1 BENCH_EXPECTED_ACCOUNT=<account id> node bench/run.ts sst-apps
node bench/run.ts sst-apps --cleanup-bootstrap
node bench/run.ts report
```

`BENCH_APPS` and `BENCH_TOOLS` restrict a run. `cdk-nextjs-standalone` needs a `zip` executable. The synthetic shapes
keep their round-one commands (`node fixtures/generate.ts`, `node bench/run.ts lambda`).

## Repository layout

- `fixtures/apps/<fixture>/`: the application (`app/`), each tool's files, the fixture's metadata and README.
- `fixtures/apps.ts`: writes one standalone project per tool into `generated/apps/`.
- `bench/run.ts`: the runner; `bench/src/apps.ts`, `sst-apps.ts`, `containers.ts`: the measurements.
- `results/`: this run; `results/2026-09-26/` and `results/2026-09-21/`: earlier runs.
- `fixtures/generate.ts`, `generated/n*/`, `generated/mono10/`: round one's synthetic shapes (the appendix).
