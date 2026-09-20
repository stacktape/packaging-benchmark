# Stacktape packaging benchmark

How fast, and how small, four deployment tools package the same Node.js/TypeScript application into AWS Lambda
artifacts — plus a three-way comparison of the same application as a container image.

The tools are **Stacktape**, **AWS CDK**, **SST** and **Serverless Framework**. Everything is generated from one
template, so all four package byte-identical source.

The numbers live in [`results/RESULTS.md`](results/RESULTS.md) and, in machine-readable form, in
[`results/results.json`](results/results.json). This file explains what was measured, how, and what the numbers
do not say.

This benchmark is maintained by Stacktape. Two of the four tools could not be measured on this run, for reasons
that have nothing to do with Stacktape; both are documented in full, including the one where the result is
unflattering to Stacktape. Read [what this benchmark does not measure](#what-this-benchmark-does-not-measure)
before quoting anything from it.

---

## Headline results

Full tables, every sample and every artifact: [`results/RESULTS.md`](results/RESULTS.md). Machine, versions and
commit are recorded there too.

**Package time, like-for-like, cold, median of 5.** Only two of the four tools ran.

| Functions | Stacktape | AWS CDK |
| --- | --- | --- |
| 1 | 4.50 s | 2.20 s |
| 5 | 3.79 s | 2.95 s |
| 10 | 3.79 s | 3.86 s |
| 25 | 3.92 s | 6.69 s |
| 50 | 4.03 s | 10.86 s |

CDK's synth time grows roughly linearly with the number of functions, because it bundles each one separately.
Stacktape's stays flat, because one Bun build with code splitting produces all of them. Stacktape's wall clock is
dominated by a fixed cost that is an artefact of how these runs were done: the source-built CLI rebuilds itself
on every invocation (3.75 s median, measured separately). The CLI's own reported packaging phase went from 0.31 s
at one function to 0.48 s at fifty. See "Where the Stacktape wall clock goes" in the results, and the caveat
below.

**Bytes a first deployment uploads, like-for-like.** Distinct artifacts, zipped, functions plus shared layers.

| Shape | Stacktape | AWS CDK |
| --- | --- | --- |
| 1 function | 65.7 KB | 121.9 KB |
| 10 functions | 78.7 KB | 1219.0 KB |
| 50 functions | 133.2 KB | 6095.0 KB |
| 25 functions, no shared application code (S3) | 102.9 KB | 1721.7 KB |
| pnpm monorepo, 10 functions (S4) | 78.7 KB | 1219.0 KB |

Stacktape promotes the shared code into one Lambda layer, so each function's own artifact is about 2.7 KB and the
layer is uploaded once. CDK gives every function a complete 532 KB bundle.

**Where Stacktape comes off worse.**

- **With defaults rather than like-for-like settings, Stacktape's single-function artifact is larger than CDK's**:
  1093.5 KB unzipped and 244.6 KB uploaded, against CDK's 937.1 KB and 155.4 KB. Stacktape's current default puts
  source maps in the deployment package; CDK's default does not produce them. The same shows up in the cold-start
  footprint proxy: 1094.5 KB per function against CDK's 937.1 KB.
- **A one-line change to shared code re-hashes every artifact.** Changing one file that all 25 handlers import
  re-hashed all 26 Stacktape artifacts — the layer and every function — because each function's entry file embeds
  the content-hashed name of the shared chunk. A redeploy would re-upload 99.1 KB rather than just the layer. CDK
  re-hashed all 25 of its artifacts in the same scenario, for 3047.7 KB, so Stacktape still moves ~30× fewer bytes,
  but it does not get away with touching only the layer.
- **At one function, Stacktape is twice CDK's wall clock** (4.50 s against 2.20 s) in these runs, entirely because
  of the source-CLI self-build.

**Containers.** Same application as an HTTP service.

| Variant | Runtime base | Image size | Cold build | Warm rebuild |
| --- | --- | --- | --- | --- |
| Stacktape image buildpack | Alpine Linux 3.24 | 61.8 MB | 6.03 s | 4.38 s |
| Expert hand-written Dockerfile | Debian 12 (`node:24-slim`) | 77.4 MB | 7.39 s | 3.91 s |
| Naive Dockerfile | Debian 12 (`node:24`) | 419.0 MB | 6.63 s | 6.70 s |

Two things to read carefully. Stacktape's image is the smallest partly because its buildpack uses an Alpine base
while the expert Dockerfile uses the `node:24-slim` base the brief specified — that is a base-image difference, not
only a packaging one. And the naive build's *cold* build is faster than the expert's, because the expert build
installs dependencies twice and bundles the application; it wins on image size and on warm rebuild instead.

---

## What is measured

**Package time.** Wall clock of the tool's own package or synth command, from a warm dependency install.

- *Cold*: the tool's output and cache directories are deleted first (`.stacktape/`, `cdk.out/`, `.sst/`,
  `.serverless/`).
- *Warm*: the same command again, immediately, with nothing changed.
- Median of 3 samples, preceded by one discarded warm-up run. Every sample is kept in `results.json`.
- Tools run sequentially, never in parallel.

**Artifact size.** Per artifact: unzipped bytes and zipped bytes. Shared layers are counted once, separately from
the functions that use them. "Upload on first deploy" is the sum of the distinct artifacts a first deployment has
to send.

**Incremental cost (S5).** Package once, append one statement to one handler, package again, then package a third
time with nothing changed. Artifacts are compared by the hash of their *contents* — the file paths and the file
bytes inside the archive, never the archive bytes, which carry timestamps. The table reports how many artifacts
were re-hashed and how many bytes that is.

**Cold-start footprint proxy (S6).** Per function, the unzipped bytes Lambda would load at cold start: the
function's own artifact plus every layer attached to it. For a per-function bundler that is the bundle alone.
**This is a proxy.** Real cold-start latency depends on runtime initialisation, provisioned concurrency, VPC
attachment and much else; measuring it needs deployments and is out of scope here.

**Containers.** Image size, cold build time and warm rebuild time after a one-line source change.

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

node fixtures/generate.ts        # materialize generated/
node bench/run.ts install        # warm dependency install for every fixture
node bench/run.ts all            # everything that can run, then write the report
```

Individual stages:

```sh
node bench/run.ts lambda         # package time and size
node bench/run.ts incremental    # S5
node bench/run.ts overhead       # the source-built CLI's fixed self-build cost
node bench/run.ts containers     # the three container paths
node bench/run.ts report         # rewrite results/RESULTS.md from results/results.json
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `STACKTAPE_REPO` | Path to a Stacktape monorepo checkout, if you are running the source-built CLI. Default `../stacktape`. |
| `BENCH_AWS_PROFILE` | AWS profile for Stacktape's read-only identity lookup. Default `default`. |
| `BENCH_AWS_REGION` | Default `eu-west-1`. |
| `SERVERLESS_ACCESS_KEY` | Enables the Serverless Framework runs. |
| `BENCH_ALLOW_SST_AWS_BOOTSTRAP` | Enables the SST runs. **This bootstraps an AWS account.** Read [fixtures/sst/README.md](fixtures/sst/README.md) first. |
| `BENCH_SAMPLES` | Samples per measurement. Default 3. |
| `BENCH_SHAPES` | Comma-separated shape ids, to run a subset. |

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

**Cold-start latency.** S6 is a size proxy and nothing more. Nothing here was deployed or invoked.

**Deployment.** No stack was created. Package time is not deploy time, and upload bytes are not upload seconds.

**Correctness of the packages.** The artifacts were measured, not invoked. Every fixture type-checks and every
tool reported success, but no handler was run in Lambda.

**Anything about SST's or Serverless Framework's speed or size.** Neither ran. See below.

## Caveats

### Two of the four tools did not run

**SST** has no command that packages functions without contacting AWS. Its only non-deploy path, `sst diff`,
bootstraps the account — it creates two S3 buckets, an ECR repository and an SSM parameter — before it previews,
and on an empty state the preview does not produce function bundles at all. Rather than bootstrap an account to
get a number, this benchmark records SST as unmeasured. Full detail, including exactly what was tried and what
was created, is in [fixtures/sst/README.md](fixtures/sst/README.md).

**Serverless Framework v4** refuses to run without a licence key. `serverless package` needs no AWS credentials
and deploys nothing, but it does need `SERVERLESS_ACCESS_KEY`. The fixture and the runner path are complete;
supply a key and it joins every table. See [fixtures/serverless/README.md](fixtures/serverless/README.md).

Nothing should be inferred about either tool from the other tools' numbers.

### The Stacktape runs used a source build, not a release

The public version of this repository pins a published `stacktape` version, written here as `<v4 prerelease>`.
**The numbers in `results/RESULTS.md` were not produced with it.** They were produced with the source-built CLI
from the Stacktape monorepo, at the commit and working-tree state recorded in the environment block of
`results/RESULTS.md`, including uncommitted packaging changes.

That matters in two ways:

1. The monorepo's development wrapper **rebuilds the entire CLI with Bun on every invocation**. That is a fixed
   cost of several seconds that a published binary does not pay. `results/RESULTS.md` reports the Stacktape
   package times twice: raw wall clock, and with the measured self-build constant subtracted. The other tools'
   numbers are not adjusted for anything — their own start-up cost is included, as it should be.
2. A source build is not a release build. A published CLI could be faster or slower.

### Stacktape's cross-machine cache never engages here

Stacktape's artifact cache reads digests from the customer's own S3 bucket, which only a deployment populates.
This benchmark never deploys, so **every Stacktape run in these tables is a cold-cache run**. In a real project
that has deployed at least once, repeated packaging can skip work these numbers include.

### Stacktape packages helper Lambdas the tables do not count

Every Stacktape `package` run also materialises Stacktape's own infrastructure helper Lambdas
(`stacktapeServiceLambda` and friends, a few megabytes in total). They are Stacktape's service code, not
application code, and only the ones a stack actually uses are deployed — but on a first deployment they are real
bytes that go to AWS, and the tables in this repository do not include them. CDK has a comparable cost in its
bootstrap stack, which is likewise not counted.

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
is in `results.json` so you can see the spread yourself. Other processes were running on the machine during the
measurements.

The source-built Stacktape CLI in particular produces occasional wall-clock outliers of several seconds — a run
that normally takes 3.8 s taking 7 or 11. They appear in the samples in `results.json`. They are in the CLI's
self-build, not in packaging: the packaging phase the CLI reports stayed between 0.27 s and 0.77 s across every
measurement, including the runs that produced an outlier. Five samples were used so that one or two outliers
cannot move a median; an earlier three-sample run is what exposed the problem.

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
  containers/        the three Dockerfiles and the container build helper
bench/
  run.ts             the runner
  src/               measurement, tool adapters, container benchmark, report writer
generated/           materialized fixtures (committed; build output is not)
results/
  results.json       every sample, every artifact
  RESULTS.md         the tables
tmp/                 scratch (gitignored)
```
