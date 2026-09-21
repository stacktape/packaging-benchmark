# SST fixture

`sst 4.17.1`. SST is measured differently from every other tool here, and the difference matters when
reading its numbers.

## SST has no packaging command

Its command list is:

```
sst init | dev | deploy | diff | add | install | secret | shell | remove | unlock
    | version | upgrade | telemetry | refresh | state | cert | tunnel | diagnostic
```

There is no build, package, synth or bundle command. Two things follow:

1. **Every path contacts AWS.** `sst diff` with the default `home: "aws"` fails at an SSM `GetParameter`
   before it builds anything — that is SST's bootstrap lookup. With valid credentials it does not fail; it
   bootstraps the account.
2. **On a stage that does not exist yet, nothing is built.** SST computes a function's code asset inside a
   Pulumi output that depends on the bootstrap resources. A preview of a stack that has never been deployed
   leaves those outputs unknown, so the bundling step never runs and `.sst/artifacts/` is never created.

So SST can only be measured against a **deployed stage**.

## How this benchmark measures it

`node bench/run.ts sst` does, per shape, one shape at a time:

```
sst deploy --stage bench-<random>     # like-for-like configuration
sst diff   --stage bench-<random>     # discarded warm-up, then 5 timed samples
sst deploy --stage bench-<random>     # defaults configuration
sst diff   --stage bench-<random>     # discarded warm-up, then 5 timed samples
sst remove --stage bench-<random>
```

It refuses to run unless `BENCH_ALLOW_SST_AWS_BOOTSTRAP=1` is set, because it creates real AWS resources.

**What the timed command includes.** `sst diff` rebuilds every function bundle and then runs a Pulumi
preview against the deployed state. The preview talks to AWS. It is therefore **not** comparable with
`cdk synth`, `stacktape package` or `serverless package`, which do local work only. It is reported because
it is the closest analogue SST has, not because it measures the same thing. `sst deploy` on an unchanged
stage is the alternative; it adds a no-op update on top of the same work, so it is further away still.
`BENCH_SST_COMMAND=deploy` switches to it.

## What SST writes, and what is measured

Per function, SST produces two directories:

```
.sst/artifacts/<name>/code.zip     what it deploys
.sst/artifacts/<name>-src/         bundle.mjs, bundle.mjs.map, resource.enc
```

Only `code.zip` reaches Lambda, so the benchmark unpacks it and measures its contents, exactly as it does
for Serverless Framework. The `-src` file list is recorded in `results.json` as build output, not as an
artifact.

## A finding worth checking yourself

The like-for-like configuration sets `nodejs.sourcemap: false`. Measured contents of `code.zip`:

| Configuration | `bundle.mjs` | `bundle.mjs.map` in the zip | Unzipped total | SST's zip |
| --- | --- | --- | --- | --- |
| like-for-like (`sourcemap: false`) | 568,083 B | **yes, 1,838,351 B** | 2,406,452 B | 599,506 B |
| defaults (no `nodejs` block) | 2,176,751 B | no | 2,176,769 B | 480,138 B |

Setting `sourcemap: false` put a source map **into** the deployment package; leaving the option alone kept
it out. That is the opposite of what the option name suggests. Both builds produced a map in `-src`; only
the `sourcemap: false` build shipped it. SST also uploads source maps to its own asset bucket, keyed by log
group, which is presumably the feature the flag is really about.

This is what was observed on `sst 4.17.1`; no claim is made about the cause. It is the reason SST's
like-for-like footprint is the largest in the S6 table.

The like-for-like `bundle.mjs` at 568 KB against CDK's 532 KB is a useful cross-check that the two
configurations really are equivalent: both externalise `@aws-sdk/*` and both minify.

## Configuration

```ts
new sst.aws.Function(name, {
  handler,
  runtime: 'nodejs24.x',
  nodejs: {
    minify: true,
    sourcemap: false,
    install: [],
    format: 'esm',
    esbuild: { external: ['@aws-sdk/*'], target: 'node24' }
  }
});
```

`install: []` keeps SST from adding a separate `node_modules` beside the bundle. `esbuild.external` is set
explicitly rather than relying on SST's default. The defaults configuration is
`new sst.aws.Function(name, { handler })`.

App name `pkgbench`, `home: 'aws'`, stage `bench-<6 random lowercase hex characters>`.

## AWS resources

A run creates, per shape: one Lambda function per function in the shape, each with an IAM role and a log
group; plus, the first time, the SST bootstrap (two S3 buckets, an ECR repository and an SSM parameter).
Each stage is removed before the next shape is deployed.

`sst remove` does **not** remove everything. It leaves an SSM parameter per stage at
`/sst/passphrase/<app>/<stage>`, and it never removes the bootstrap. Both have to be cleaned up by hand.
`results.json` records every stage created and removed under `sst.resourceLog`.
