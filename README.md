# Stacktape packaging benchmark

How fast, and how small, four deployment tools package the same Node.js/TypeScript application into AWS Lambda
artifacts — plus a three-way comparison of the same application as a container image.

The tools are **Stacktape**, **AWS CDK**, **SST** and **Serverless Framework**. Everything is generated from one
template, so all four package byte-identical source.

The numbers live in [`results/RESULTS.md`](results/RESULTS.md) and, in machine-readable form, in
[`results/results.json`](results/results.json). This file explains what was measured, how, and what the numbers
do not say.

This benchmark is maintained by Stacktape, so treat it as an interested party's measurement and check it. All
four tools ran, but not on equal terms: SST has no packaging command at all, so its numbers come from a
different operation and are marked as such everywhere they appear. The places where Stacktape comes off worse
are in the headline section, not buried. Read
[what this benchmark does not measure](#what-this-benchmark-does-not-measure) and the
[caveats](#caveats) before quoting anything from it.

---
## Headline results

Full tables, every sample and every artifact: [`results/RESULTS.md`](results/RESULTS.md). Machine, versions and
commit are recorded there too.

### Package time, like-for-like, cold, median of 5

| Functions | Stacktape | AWS CDK | Serverless Framework | SST |
| --- | --- | --- | --- | --- |
| 1 | 2.31 s | 2.15 s | 3.74 s | 4.25 s* |
| 5 | 2.37 s | 2.91 s | 3.76 s | 4.70 s* |
| 10 | 2.39 s | 3.78 s | 3.95 s | 9.20 s* |
| 25 | 2.46 s | 6.30 s | 4.36 s | 6.36 s* |
| 50 | 2.60 s | 10.56 s | 5.09 s | 8.18 s* |

\* **SST's number is not comparable with the others.** SST has no packaging command. The only way to make it
build bundles is to deploy a stage first and then run `sst diff`, which rebuilds the bundles *and* runs a Pulumi
preview against AWS. The other three columns are local work only. See
[fixtures/sst/README.md](fixtures/sst/README.md).

CDK's synth time grows roughly linearly with the number of functions, because it bundles each one separately.
Stacktape's stays nearly flat, because one Bun build with code splitting produces all of them. Starting the
Stacktape binary and printing its version — before any config is read or any AWS call is made — already costs
1.70 s, so 0.6–0.9 s of each Stacktape row is everything else it does.

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
whole service, which comes out within a kilobyte of CDK's total. SST's packages carry a source map — see below.

### Cold-start footprint proxy, per function (S6)

Unzipped bytes a function loads: its own artifact plus any layer attached to it.

| Shape | Stacktape | AWS CDK | Serverless | SST |
| --- | --- | --- | --- | --- |
| 25 functions, like-for-like | 264.3 KB | 532.5 KB | 13312.5 KB | 2350.1 KB |
| 50 functions, like-for-like | 264.3 KB | 532.5 KB | 26624.7 KB | 2350.1 KB |
| 25 functions, defaults | 1089.1 KB | 937.1 KB | 66984.8 KB | 2125.8 KB |
| 50 functions, defaults | 1089.1 KB | 937.1 KB | 133969.2 KB | 2125.8 KB |

Serverless Framework's default is one package for the whole service, so every function loads every other
function's bundle, and the figure grows linearly with function count. `package: individually: true` avoids that,
at the cost of packaging each function separately; the benchmark measures the default.

### Where Stacktape comes off worse

- **With defaults rather than like-for-like settings, Stacktape's single-function artifact is larger than CDK's**:
  1088.3 KB unzipped and 244.5 KB uploaded, against CDK's 937.1 KB and 155.4 KB. Stacktape's current default puts
  source maps in the deployment package; CDK's default does not produce them. The same shows in the footprint
  proxy: 1089.1 KB per function against CDK's 937.1 KB.
- **A one-line change to shared code re-hashes every artifact.** Changing one file that all 25 handlers import
  re-hashed all 26 Stacktape artifacts — the layer and every function — because each function's entry file embeds
  the content-hashed name of the shared chunk. A redeploy would re-upload 99.2 KB rather than just the layer. CDK
  re-hashed 25 of 25 for 3047.7 KB and Serverless re-hashed its single package for 3048.5 KB, so Stacktape still
  moves about 30× fewer bytes, but it does not get away with touching only the layer.
- **At one function, Stacktape is slower than CDK** (2.31 s against 2.15 s). Most of Stacktape's time is binary
  start-up plus an AWS identity lookup; CDK makes no AWS call at all.
- **Stacktape's wall clock is not always steady.** A handful of measurements produced samples several seconds
  above their own median. Serverless showed the same; CDK did not. The cause was not identified — see the caveat
  below. Every sample is published.

### Containers

Same application as a long-running HTTP service.

| Variant | Runtime base | Image size | Cold build | Warm rebuild |
| --- | --- | --- | --- | --- |
| Stacktape image buildpack | Alpine Linux 3.24 | 61.8 MB | 4.54 s | 3.07 s |
| Expert hand-written Dockerfile | Debian 12 (`node:24-slim`) | 77.4 MB | 7.57 s | 4.31 s |
| Naive Dockerfile | Debian 12 (`node:24`) | 419.0 MB | 6.64 s | 7.23 s |

Two things to read carefully. Stacktape's image is the smallest partly because its buildpack uses an Alpine base
while the expert Dockerfile uses the `node:24-slim` base the brief specified — that is a base-image difference, not
only a packaging one. And the naive build's *cold* build is faster than the expert's, because the expert build
installs dependencies twice and bundles the application; it wins on image size and on warm rebuild instead.


## What is measured

**Package time.** Wall clock of the tool's own package or synth command, from a warm dependency install.

- *Cold*: the tool's output and cache directories are deleted first (`.stacktape/`, `cdk.out/`, `.sst/`,
  `.serverless/`).
- *Warm*: the same command again, immediately, with nothing changed.
- Median of 5 samples, preceded by one discarded warm-up run. Every sample is kept in `results.json`.
- Tools run sequentially, never in parallel.
- SST is the exception: it has no packaging command, so it is measured against a deployed stage. See the
  caveats.

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
node bench/run.ts overhead       # Stacktape CLI start-up, the floor under its measurements
node bench/run.ts containers     # the three container paths
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

### The Stacktape runs used a source build, not a release

The public version of this repository pins a published `stacktape` version, written here as `<v4 prerelease>`.
**The numbers in `results/RESULTS.md` were not produced with it.** They were produced with a release-style Linux
binary built from the Stacktape monorepo, reporting version `4.0.0-bench`, at the commit and working-tree state
recorded in the environment block of `results/RESULTS.md`, including uncommitted packaging changes. A source
build is not a release build; a published CLI could be faster or slower.

An earlier revision of these results used the monorepo's development wrapper, which rebuilds the whole CLI with
Bun on every invocation and added about 3.3 seconds to every Stacktape measurement. Those numbers are
superseded and are not in `results/results.json`.

### Stacktape's cross-machine cache never engages here

Stacktape's artifact cache reads digests from the customer's own S3 bucket, which only a deployment populates.
This benchmark never deploys, so **every Stacktape run in these tables is a cold-cache run**. In a real project
that has deployed at least once, repeated packaging can skip work these numbers include.

### Stacktape packages helper Lambdas the tables do not count

Every Stacktape `package` run also materialises Stacktape's own infrastructure helper Lambdas, alongside the
application artifacts and in addition to them: `stacktapeServiceLambda` (2.86 MB zipped), `uptimeProber`
(0.91 MB) and three smaller ones (22–24 KB each), about 3.8 MB in total. They are Stacktape's service code rather
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
is in `results.json` so you can see the spread yourself. Other processes were running on the machine during the
measurements.

**Sporadic multi-second outliers, in two of the four tools.** A handful of measurements produced samples several
seconds above their own median — a Stacktape run that normally takes 2.4 s taking 9.3 s, a Serverless run that
normally takes 3.8 s taking 23.5 s. They cluster: a measurement either has several of them or none.

What is known about them:

- They affect **Stacktape and Serverless Framework**. CDK, in the same sessions on the same machine, produced
  nothing wider than ±0.3 s across every measurement.
- They are **not in the packaging work**. Stacktape prints the duration of its own packaging phase, and that
  stayed between 0.22 s and 0.52 s in every measurement, including the ones that produced a 9-second sample.
- `stacktape version`, which starts the same binary and does nothing else, was stable across its samples
  (1.68–1.75 s), so plain process start-up is not it either.
- `sts:GetCallerIdentity` — the one AWS call `stacktape package` makes — was timed separately from the same
  machine and came back at 1.01–1.09 s across twelve calls, so a slow STS response does not explain it either.

**The cause was not identified.** Both affected tools ship a large self-contained runtime and make a network
call during packaging; CDK does neither. That is a correlation, not a finding. The two measurements most
affected (`noshare25` Stacktape like-for-like cold, `noshare25` Serverless defaults warm) were re-run with seven
samples and the outliers recurred, so they are reported as measured rather than quietly re-rolled. Every sample
is in `results.json`.

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
