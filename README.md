# Stacktape packaging benchmark

How fast, and how small, four deployment tools package the same Node.js/TypeScript application into AWS Lambda
artifacts — plus a three-way comparison of the same application as a container image.

The tools are **Stacktape**, **AWS CDK**, **SST** and **Serverless Framework**. Everything is generated from one
template, so all four package byte-identical source.

The numbers live in [`results/RESULTS.md`](results/RESULTS.md) and, in machine-readable form, in
[`results/results.json`](results/results.json). This file explains what was measured, how, and what the numbers
do not say.

This benchmark is maintained by Stacktape, so treat it as an interested party's measurement and check it. All
four tools were measured, but not on equal terms: SST has no packaging command at all, so its numbers come from a
different operation, were taken on 21 September and not again, and are marked as such everywhere they appear. The places where Stacktape comes off worse
are in the headline section, not buried. Read
[what this benchmark does not measure](#what-this-benchmark-does-not-measure) and the
[caveats](#caveats) before quoting anything from it.

---
## Headline results

Full tables, every sample and every artifact: [`results/RESULTS.md`](results/RESULTS.md). Machine, versions and the
measured binary are recorded there too. These are the results of 26 September 2026; the 21 September results are
kept in [`results/2026-09-21/`](results/2026-09-21/RESULTS.md).

### Package time, like-for-like, cold, median of 5

| Functions | Stacktape | AWS CDK | Serverless Framework | SST |
| --- | --- | --- | --- | --- |
| 1 | 0.38 s | 2.06 s | 3.48 s | 4.25 s* |
| 5 | 0.38 s | 2.63 s | 3.68 s | 4.70 s* |
| 10 | 0.40 s | 3.50 s | 3.96 s | 9.20 s* |
| 25 | 0.45 s | 6.13 s | 4.12 s | 6.36 s* |
| 50 | 0.52 s | 9.96 s | 4.69 s | 8.18 s* |

\* **SST's number is not comparable with the others, and it was not rerun.** SST has no packaging command. The only
way to make it build bundles is to deploy a stage first and then run `sst diff`, which rebuilds the bundles *and*
runs a Pulumi preview against AWS. The other three columns build locally and deploy nothing. The SST column is from
21 September, with the same SST version this run pins. See [fixtures/sst/README.md](fixtures/sst/README.md).

CDK's synth time grows roughly linearly with the number of functions, because it bundles each one separately.
Stacktape's stays nearly flat, because one Bun build with code splitting produces all of them.

### Where the Stacktape wall clock goes

On 21 September most of every Stacktape row was overhead: 1.70 s to start the binary, plus a 1.0–1.1 s STS call to
look up the AWS identity. Both are gone from the measured runs:

- **Start-up** (`stacktape version`): 0.20 s median, down from 1.70 s.
- **The AWS identity is cached.** The CLI keeps the identity STS returned for each access key for 24 hours, in the
  user's home directory. The first run on a machine pays one STS round trip; the measured runs follow a discarded
  warm-up run and pay none, cold or warm, because cold runs delete only the project's build output.
- **The packaging phase** the CLI reports takes 0.05–0.20 s like-for-like (0.07–0.31 s with defaults). It is the only
  part that grows with the number of functions.
- **Telemetry.** The CLI sends a telemetry report and waits for it before exiting: 69–117 ms per run, median 83 ms.
- **Tools.** pack, nixpacks and the Session Manager plugin are downloaded on first use. That happened once here
  (0.72 s, 0.42 s and 1.29 s), before any timed run.

| Shape | Stacktape, 21 September | Stacktape, 26 September |
| --- | --- | --- |
| 1 function | 2.31 s | 0.38 s |
| 5 functions | 2.37 s | 0.38 s |
| 10 functions | 2.39 s | 0.40 s |
| 25 functions | 2.46 s | 0.45 s |
| 50 functions | 2.60 s | 0.52 s |
| 25 functions, no shared code (S3) | 4.14 s | 0.44 s |
| pnpm monorepo, 10 functions (S4) | 2.40 s | 0.39 s |

Like-for-like, cold, median of 5. The other tools moved by at most 0.6 s between the two runs (CDK at 50 functions,
10.56 s to 9.96 s).

### Repackage after one edit (S5, 25 functions, like-for-like)

Package, change one file, package again. The time is the second package; "bytes to re-upload" are the zipped bytes of
every artifact whose content hash changed.

| Edit | Stacktape | AWS CDK | Serverless Framework |
| --- | --- | --- | --- |
| One statement appended to one handler | 0.44 s, 1 of 26 artifacts, 1.4 KB | 5.87 s, 1 of 25, 121.9 KB | 4.06 s, 1 of 1, 3048.3 KB |
| One line changed in `lib/util.ts`, which every handler imports | 0.46 s, 26 of 26, 99.2 KB | 6.00 s, 25 of 25, 3047.7 KB | 3.98 s, 1 of 1, 3048.5 KB |

SST was not measured: it needs a deployed stage for every package run.

### Bytes a first deployment uploads, like-for-like

Distinct artifacts, zipped: every function bundle plus every shared layer, counted once.

| Shape | Stacktape | AWS CDK | Serverless | SST |
| --- | --- | --- | --- | --- |
| 1 function | 65.7 KB | 121.9 KB | 122.4 KB | 475.0 KB |
| 10 functions | 78.7 KB | 1219.0 KB | 1219.5 KB | 4750.2 KB |
| 50 functions | 133.2 KB | 6095.0 KB | 6096.0 KB | 23751.0 KB |
| 25 functions, no shared application code (S3) | 103.0 KB | 1721.7 KB | 1722.4 KB | 6681.7 KB |
| pnpm monorepo, 10 functions (S4) | 78.7 KB | 1219.0 KB | 1220.5 KB | 4751.9 KB |

Stacktape promotes the shared code into one Lambda layer, so each function's own artifact is about 2.7 KB and the
layer is uploaded once. CDK gives every function a complete 532 KB bundle. Serverless ships one package for the
whole service, which comes out within a kilobyte of CDK's total. SST's packages carry a source map — see below. The
SST column is from 21 September.

### Cold-start footprint proxy, per function (S6)

Unzipped bytes a function loads: its own artifact plus any layer attached to it.

| Shape | Stacktape | AWS CDK | Serverless | SST |
| --- | --- | --- | --- | --- |
| 25 functions, like-for-like | 264.3 KB | 532.5 KB | 13312.5 KB | 2350.1 KB |
| 50 functions, like-for-like | 264.3 KB | 532.5 KB | 26624.7 KB | 2350.1 KB |
| 25 functions, defaults | 481.0 KB | 937.1 KB | 66984.8 KB | 2125.8 KB |
| 50 functions, defaults | 481.0 KB | 937.1 KB | 133969.2 KB | 2125.8 KB |

Serverless Framework's default is one package for the whole service, so every function loads every other
function's bundle, and the figure grows linearly with function count. `package: individually: true` avoids that,
at the cost of packaging each function separately; the benchmark measures the default. Stacktape's default package
still carries a source map, now without the embedded sources, so its defaults footprint went from 1089.1 KB on
21 September to 481.0 KB.

### Where Stacktape comes off worse

- **A one-line change to shared code re-hashes every artifact.** Changing one file that all 25 handlers import
  re-hashed all 26 Stacktape artifacts — the layer and every function — because each function's entry file embeds
  the content-hashed name of the shared chunk. A redeploy would re-upload 99.2 KB rather than just the layer. CDK
  re-hashed 25 of 25 for 3047.7 KB and Serverless re-hashed its single package for 3048.5 KB, so Stacktape still
  moves about 30× fewer bytes, but it does not get away with touching only the layer.
- **Stacktape's wall clock is not always steady.** One of the 140 reported Stacktape samples was far above its median:
  1.40 s against 0.38 s. A first run of the same measurements, taken while the machine was busier, had two such
  samples (5.03 s against 0.53 s, 1.44 s against 0.40 s); its medians were within 36 ms of the reported ones. No STS
  call remains; the one network call left in `stacktape package` is the telemetry report. The cause was not
  identified. Serverless showed the same more often (12 of 140 samples, up to 28.4 s against a 3.96 s median); CDK
  did not. Every sample is published.
- **Every Stacktape run waits for its telemetry report**, 69–117 ms, about a fifth of a one-function package. The
  Serverless Framework runs had telemetry disabled.
- **On a source-only edit, the typical Dockerfile rebuilt faster than Stacktape's image buildpack** (0.75 s against
  1.19 s, single samples): it only copies the source and re-runs one esbuild bundle, while Stacktape runs its whole
  packaging again. Its image is 419.3 MB compressed against Stacktape's 61.8 MB.

### Containers

Same application as a long-running HTTP service. One sample per cell.

| Variant | Runtime base | Image, compressed | Image, uncompressed | Cold build | Rebuild, source edit | Rebuild, dependency change | Push after the source edit | Push after the dependency change |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Stacktape image buildpack | Alpine Linux 3.24 | 61.8 MB | 172.4 MB | 2.62 s | 1.19 s | 1.38 s | 0.3 MB | 0.3 MB |
| Expert hand-written Dockerfile | Debian 12 (`node:24-slim`) | 77.4 MB | 225.6 MB | 7.34 s | 3.75 s | 6.51 s | 0.3 MB | 0.3 MB |
| Typical Dockerfile (Node.js guide) | Debian 12 (`node:24`) | 419.3 MB | 1197.6 MB | 6.31 s | 0.75 s | 6.03 s | 0.3 MB | 28.5 MB |
| nixpacks, through Stacktape | Ubuntu 24.04 | 271.9 MB | 668.5 MB | 43.78 s | 7.36 s | 6.76 s | 14.3 MB | 14.3 MB |
| Paketo buildpacks, through Stacktape | Ubuntu 22.04 (Paketo Base Jammy) | 141.8 MB | 446.8 MB | 80.94 s | 75.13 s | 78.04 s | 0.3 MB | 26.7 MB |

"Push" is what a registry that already holds the previous image receives: the compressed layers whose digest changed.
Read these carefully:

- Stacktape's image is the smallest partly because its buildpack uses an Alpine base, while the expert Dockerfile
  uses `node:24-slim` — a base-image difference, not only a packaging one.
- The dependency change moves `jose` one patch release. The typical build reinstalls every dependency into one layer
  and pushes all of it again (28.5 MB). The expert build and Stacktape bundle the application, so only the bundle
  layer changes (0.3 MB).
- nixpacks and Paketo spend nearly all their time in their own build: in a Paketo rebuild, `pack` took 77.3 of the
  77.9 s the command ran, and Stacktape's own part took 0.1 s. Their cold builds include downloads inside the build
  (Node.js from the Nix cache, Paketo's Node.js distribution). nixpacks 1.39.0 has no Node 24, so that variant runs
  Node 22.
- The 21 September table called its image sizes uncompressed. They were the compressed sizes; see
  [the containers README](fixtures/containers/README.md).


## What is measured

**Package time.** Wall clock of the tool's own package or synth command, from a warm dependency install.

- *Cold*: the tool's build output and build cache directories are deleted first (`.stacktape/`, `cdk.out/`,
  `.sst/`, `.serverless/`). Cold keeps what a machine keeps outside the project between builds. For Stacktape that is
  the AWS identity it caches for 24 hours per access key and the pack, nixpacks and Session Manager plugin
  executables it downloads on first use, all in the user's home directory; a first run on a new machine pays one STS
  round trip and those downloads on top.
- *Warm*: the same command again, immediately, with nothing changed.
- Median of 5 samples, preceded by one discarded warm-up run. Every sample is kept in `results.json`.
- Tools run sequentially, never in parallel.
- SST is the exception: it has no packaging command, so it is measured against a deployed stage. See the
  caveats.

**Artifact size.** Per artifact: unzipped bytes and zipped bytes. Shared layers are counted once, separately from
the functions that use them. "Upload on first deploy" is the sum of the distinct artifacts a first deployment has
to send.

**Repackage after one edit (S5).** Package once, change one file, package again, then package a third time with
nothing changed. Two edits: one statement appended to one handler, and one line changed in a file every handler
imports. Artifacts are compared by the hash of their *contents* — the file paths and the file
bytes inside the archive, never the archive bytes, which carry timestamps. The table reports how many artifacts
were re-hashed and how many bytes that is.

**Cold-start footprint proxy (S6).** Per function, the unzipped bytes Lambda would load at cold start: the
function's own artifact plus every layer attached to it. For a per-function bundler that is the bundle alone.
**This is a proxy.** Real cold-start latency depends on runtime initialisation, provisioned concurrency, VPC
attachment and much else; measuring it needs deployments and is out of scope here.

**Containers.** Five ways to build the same service: Stacktape's image buildpack, nixpacks and Paketo (both through
Stacktape's `nixpacks` and `external-buildpack` packaging), an expert Dockerfile, and the typical Dockerfile from the
Node.js guide. Image size, cold build, rebuild after a source-only edit, rebuild after a dependency change, and the
bytes a registry would receive for each. See [fixtures/containers/README.md](fixtures/containers/README.md).

**Load.** Every measurement records the one-minute load average when it started and ended.

Two configurations per tool:

- **like-for-like** (the headline): minification on, no source maps in the package, the AWS SDK left to the Lambda
  runtime, ESM, Node 24.
- **defaults** (secondary): only the entry point configured; whatever the tool does on its own.

Each tool's exact configuration, and the reasoning behind every switch, is in its own file:
[Stacktape](fixtures/stacktape/README.md) · [CDK](fixtures/cdk/README.md) · [SST](fixtures/sst/README.md) ·
[Serverless](fixtures/serverless/README.md) · [containers](fixtures/containers/README.md).

## The application

Realistic rather than minimal. One template generates every shape:

- `lib/` — `aws-clients.ts` (DynamoDB document client, S3), `logger.ts` (pino), `schema.ts` (zod), `auth.ts`
  (jose, remote JWKS), `util.ts` (date-fns, nanoid).
- handlers that authenticate a request, validate a body, read and write DynamoDB, write to S3, and log.
- dependencies: `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-s3`, `zod`, `date-fns`,
  `jose`, `pino`, `nanoid`. All pinned exactly; see `fixtures/generate.ts`.

### Shapes

| Id | Shape | Why it is here |
| --- | --- | --- |
| S1 | 1 function | The smallest realistic case. |
| S2 | 1, 5, 10, 25, 50 functions sharing `lib/` | How each tool scales with function count when there is shared code. |
| S3 | 25 functions that share no application code | The control. Each handler inlines its own copy of the helper code, with the handler index woven through the string literals so no two copies are byte-identical, and imports its own subset of the dependencies. Without this shape, a tool that deduplicates shared code would look good for reasons that would not survive contact with a codebase that does not share. **Read the limit of this control below.** |
| S4 | pnpm workspace monorepo, 10 functions | `packages/lib` and `apps/api`, handlers importing `@bench/lib`. |
| S5 | incremental, on the 25-function shape | See above. |
| S6 | footprint, on 25 and 50 functions | See above. |

Shapes that only demonstrate a capability — whether a framework supports something, whether an artifact fits
under a limit — are deliberately absent. This benchmark is about speed and size.

#### What S3 does and does not control for

S3 removes **shared application code**: no two handlers contain the same helper. It does not, and cannot, remove
**shared npm dependencies**. The 25 handlers draw from five rotating dependency subsets, so the five handlers in
each group still import the same third-party packages, and those packages are still the overwhelming majority of
the bytes. A tool that deduplicates therefore still has plenty to deduplicate in S3, and the results show that.

That is not a defect in the tool being measured — sharing `zod` between functions is a real saving in a real
application — but it does mean S3 is a weaker control than its name suggests. Read it as "the handlers do not
share *your* code", not as "nothing can be deduplicated".

## Reproducing it

```sh
git clone <this repository>
cd stacktape-packaging-benchmark

node fixtures/generate.ts        # materialize generated/ (`containers` rewrites only the container projects)
node bench/run.ts install        # warm dependency install for every fixture
node bench/run.ts all            # everything that can run, then write the report
```

These results measured a Linux release build of the Stacktape CLI, made from the Stacktape monorepo by its
production release function into a directory of its own:

```sh
cd <stacktape>/apps/cli
OUT=<directory> bun -e "import { buildDistPackage } from './scripts/build-dist-package.ts';
  await buildDistPackage({ platform: 'linux', version: '4.0.0-bench', distFolderPath: process.env.OUT, keepUnarchived: true })"
```

`STACKTAPE_BINARY` then points at `<directory>/linux/stacktape`. Before any timed run, pack, nixpacks and the Session
Manager plugin were resolved once through the same commit's resolver (`resolveExternalTool` in
`apps/cli/src/utils/external-tools.ts`), and two untimed `package` runs put the AWS identity in the CLI's cache.

Individual stages:

```sh
node bench/run.ts lambda         # package time and size
node bench/run.ts incremental    # S5
node bench/run.ts overhead       # Stacktape CLI start-up, the floor under its measurements
node bench/run.ts containers     # the five container paths
node bench/run.ts sst            # DEPLOYS TO AWS - read fixtures/sst/README.md first
node bench/run.ts report         # rewrite results/RESULTS.md from results/results.json
```

`node bench/run.ts all` runs everything except `sst`, which is opt-in because it creates real AWS resources.

Environment variables:

| Variable | Meaning |
| --- | --- |
| `STACKTAPE_REPO` | Path to a Stacktape monorepo checkout. Default `../stacktape`. |
| `STACKTAPE_BINARY` | The Stacktape CLI executable to measure. Default `<repo>/apps/cli/__dist/linux/stacktape`. |
| `BENCH_AWS_PROFILE` | AWS profile for Stacktape's read-only identity lookup. Default `default`. |
| `BENCH_AWS_REGION` | Default `eu-west-1`. |
| `SERVERLESS_ACCESS_KEY` | Enables the Serverless Framework runs. |
| `BENCH_ALLOW_SST_AWS_BOOTSTRAP` | Required by `run.ts sst`. **It deploys stages and bootstraps the account.** Read [fixtures/sst/README.md](fixtures/sst/README.md) first. |
| `BENCH_SST_COMMAND` | `diff` (default) or `deploy`: which command SST is timed on. |
| `BENCH_SAMPLES` | Samples per measurement. Default 3; these results used 5. |
| `BENCH_SHAPES` | Comma-separated shape ids, to run a subset. |
| `BENCH_TOOLS` | Comma-separated tool ids, to run a subset. |
| `BENCH_CONTAINER_VARIANTS` | Comma-separated container variants, to run a subset. |
| `BENCH_INCREMENTAL_REPEATS` | Repeats of each edit scenario. Default 3; these results used 5. |
| `STACKTAPE_BINARY_COMMIT` | The Stacktape commit the binary was built from, recorded in the report. |

`.github/workflows/benchmark.yml` runs the same runner on `ubuntu-latest`. It is there so the benchmark can be
shown to still run end to end; a shared two-core hosted runner is not a machine to take timings from.

### How size is measured

Some tools hand over a finished zip (Stacktape's function packages, Serverless), some hand over a directory
(CDK assets, Stacktape layers). Zip implementations differ in compression level and in whether they store
directory entries, so comparing one tool's zip with another tool's would compare zip writers, not packages.

Every artifact therefore gets the same treatment: the runner walks the unzipped directory and computes the exact
size of a zip holding those files — deflate level 9, store when deflate does not help, files only. Where the tool
produced its own zip, that size is recorded separately as `toolZipBytes` in `results.json`.

Unzipped bytes are the sum of the file sizes. Content hashes are SHA-256 over the sorted relative paths and the
SHA-256 of each file's bytes.

---

## What this benchmark does not measure

**Cold-start latency.** S6 is a size proxy and nothing more. No function was invoked.

**Deployment time.** Package time is not deploy time, and upload bytes are not upload seconds. SST stages were
deployed, but only so SST would build bundles at all; the deploy times in the SST section are context, not a
comparison — no other tool was deployed.

**Correctness of the packages.** The artifacts were measured, not invoked. Every fixture type-checks and every
tool reported success, but no handler was run in Lambda.

**SST on equal terms.** SST has no packaging command, so its numbers come from a different kind of operation.
See the caveat below.

## Caveats

### SST's number measures something else

SST v4 has no build, package or synth command. On a stage that has never been deployed, its preview does not
build function bundles at all, and its only non-deploy path bootstraps the AWS account first. The only way to
get numbers is to deploy a throwaway stage and then time `sst diff`, which rebuilds every bundle **and** runs a
Pulumi preview against AWS.

So the SST column includes a network round trip and a state comparison that the other three columns do not.
Treat it as "the closest thing SST has to packaging", not as a like-for-like time. Its size figures are
comparable — they are the contents of the zip SST deploys — but its timings are not.
[fixtures/sst/README.md](fixtures/sst/README.md) has the full detail, including what was tried and rejected.

### SST ships a source map when told not to

With `nodejs.sourcemap: false`, SST's deployment zip contained `bundle.mjs.map` (1,838,351 bytes). With no
`nodejs` block at all, it did not. That is the opposite of what the option name implies, and it is why SST has
the largest like-for-like footprint in the S6 table. Observed on `sst 4.17.1`; no claim is made about the cause.

### Serverless Framework ships one package for the whole service

That is its default, not a choice this benchmark made. Every function in the stack is deployed from the same
zip, so upload bytes stay competitive while the per-function cold-start footprint grows with the number of
functions — 26.6 MB per function at 50 functions like-for-like, 134 MB with the framework's defaults.
`package: individually: true` changes this. See
[fixtures/serverless/README.md](fixtures/serverless/README.md).

### The Stacktape runs used an unpublished build

The public version of this repository pins a published `stacktape` version, written here as `<v4 prerelease>`.
**The numbers in `results/RESULTS.md` were not produced with it.** They were produced with a Linux release build of
the Stacktape monorepo at commit `9db960e3`, made by the production release function and reporting version
`4.0.0-bench`; its SHA-256 is in the environment block of `results/RESULTS.md`. It was built from a clean working
tree, but it is not a published release.

The 21 September results measured a build with uncommitted packaging changes, and an earlier revision used the
monorepo's development wrapper, which added about 3.3 seconds to every Stacktape measurement. Neither is in
`results/results.json`; the 21 September results are kept in `results/2026-09-21/`.

### SST was not rerun

SST's numbers are from 21 September, with the same SST version this run pins. Measuring it again means deploying and
removing a stage per shape, about 22–25 minutes of AWS time for the seven shapes, and its column measures a
different operation anyway. Its size figures do not depend on the machine.

### Transitive dependency versions

Every direct dependency is pinned exactly. The fixtures' lockfiles are not committed, and the fixtures were installed
afresh for this run, so transitive dependencies are whatever npm and pnpm resolved on 26 September. The like-for-like
artifact sizes match 21 September's to the kilobyte.

### Stacktape's cross-machine cache never engages here

Stacktape's artifact cache reads digests from the customer's own S3 bucket, which only a deployment populates.
This benchmark never deploys, so **every Stacktape run in these tables is a cold-cache run**. In a real project
that has deployed at least once, repeated packaging can skip work these numbers include.

### Stacktape packages helper Lambdas the tables do not count

Every Stacktape `package` run also materialises Stacktape's own infrastructure helper Lambdas, alongside the
application artifacts and in addition to them: `stacktapeServiceLambda` (0.88 MB zipped), `uptimeProber`
(0.32 MB) and three smaller ones (15–16 KB each), about 1.24 MB in total (3.8 MB on 21 September). They are Stacktape's service code rather
than application code, and only the ones a stack actually uses are deployed — but on a first deployment they are
real bytes that go to AWS, and the tables in this repository do not include them. CDK has a comparable cost in
its bootstrap stack, which is likewise not counted.

### Stacktape and the other tools use different bundlers

Stacktape bundles with **Bun's bundler**. CDK, SST and Serverless Framework all bundle with **esbuild**. That is
a property of the tools, not a choice this benchmark made, and it is the main reason the byte counts differ at
otherwise equivalent settings. Both bundles keep the same set of external imports.

### "minify" does not mean the same thing in every tool

Stacktape's `minify: true` compresses whitespace and syntax but **keeps local identifier names**, so stack traces
stay readable; shortening identifiers is a separate opt-in. The other tools' `minify: true` shortens identifiers
too. Stacktape is therefore doing *less* minification than the others in the like-for-like configuration.

### Stacktape's shared layer couples every function to the shared code

The layer is what makes Stacktape's upload bytes small, and it has a cost. Each function's entry file imports the
shared chunk by a content-hashed filename, so any change to shared code changes that filename and therefore
changes every function's artifact as well as the layer. S5 measures it: a one-line change in `lib/util.ts`
re-hashed 26 of 26 artifacts. A change confined to one handler re-hashed exactly one.

### Machine and measurement noise

One machine, one operating system, one filesystem. Timings from a developer workstation under WSL2 are not
timings from a CI runner or from macOS. Five samples catch gross outliers, not distribution shape; every sample
is in `results.json` so you can see the spread yourself.

**Load.** Every measurement records the one-minute load average when it started and ended. The machine has 24 logical
cores. Another agent session was running test suites and a browser test on it at times, and the benchmarked tools
themselves use several cores, so 38 of the 84 measurements of the first pass started above a load of 2 (the highest
was 5.94). Stacktape's rows were then measured again on a quiet machine, every one starting between 1.24 and 1.55,
and those are the ones reported; their medians moved by at most 36 ms and their artifacts not at all. CDK and
Serverless Framework were not measured again; CDK's samples stayed within 0.5 s of their medians throughout.

**Sporadic multi-second outliers.** Serverless Framework had 12 of its 140 samples above one and a half times their
median, up to 28.4 s against 3.96 s. Stacktape had one of 140 in the reported rows (1.40 s against 0.38 s) and two in
the first pass. CDK had none. Stacktape no longer makes an STS call while measured; the one network call left in
`stacktape package` is the telemetry report, which took 69–117 ms in 30 separate runs and produced no outlier there.
**The cause was not identified.** Every sample is in `results.json`.

### The like-for-like configuration is a judgement call

"Equivalent settings" across four tools with different defaults and different option names cannot be exact. Every
setting chosen, and the reason for it, is written down in each tool's fixture README. Disagree with one, change
it, and re-run: the generator is in `fixtures/generate.ts`.

---

## Repository layout

```
fixtures/
  template/          the one application template every shape is generated from
  generate.ts        the generator
  stacktape/         per-tool configuration notes
  cdk/
  sst/
  serverless/
  containers/        the two Dockerfiles, Paketo's project descriptor and the container build helper
bench/
  run.ts             the runner
  src/               measurement, tool adapters, container benchmark, report writer
generated/           materialized fixtures (committed; build output is not)
results/
  results.json       every sample, every artifact
  RESULTS.md         the tables
  2026-09-21/        the previous run, kept for comparison
tmp/                 scratch (gitignored)
```
