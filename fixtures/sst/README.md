# SST fixture — not measured

**SST v4 is present in this repository as a complete, runnable fixture, but the benchmark records it as blocked
rather than measuring it.** This file documents exactly why, so the finding can be checked rather than taken on
trust.

## What was tried

`sst 4.17.1`. Its command list is:

```
sst init | dev | deploy | diff | add | install | secret | shell | remove | unlock
    | version | upgrade | telemetry | refresh | state | cert | tunnel | diagnostic
```

There is no build, package, synth or bundle command. `sst diff` is the only candidate that is not a deployment.

1. **`sst diff` with `home: "aws"`** fails before it bundles anything:

   ```
   ✕ aws: operation error SSM: GetParameter ... UnrecognizedClientException
   ```

   That is SST's bootstrap lookup. With valid credentials it does not fail — it **bootstraps the account**.

2. **`sst diff` with `home: "local"`** (state on the local machine) plus an explicit `providers: { aws: ... }`
   entry gets further, and with valid credentials it completes a Pulumi preview. It still bootstraps AWS. On the
   run that produced this note it created, in `eu-west-1`:

   - S3 bucket `sst-asset-<random>`
   - S3 bucket `sst-state-<random>`
   - ECR repository `sst-asset`
   - SSM parameter `/sst/bootstrap`

3. That preview **does not produce function bundles**. `.sst/artifacts/` is never created. SST computes the
   function's code asset inside a Pulumi output that depends on the bootstrap resources, and a preview of a stack
   that does not exist yet leaves those outputs unknown, so the bundling step never runs.

So there is no way to make SST package the fixtures without both writing to an AWS account and deploying, and
even the read-only-looking path does not produce the artifacts the benchmark needs to measure.

## Consequence for the tables

SST appears in the "tools that could not be measured" section and nowhere else. Its packaging speed and its
artifact sizes are unknown to this benchmark. Nothing should be inferred about them from the other tools'
numbers.

## Running it anyway

If you have a disposable AWS account of your own:

```sh
BENCH_ALLOW_SST_AWS_BOOTSTRAP=1 AWS_PROFILE=<disposable> node bench/run.ts lambda
```

This will bootstrap that account. Do not point it at an account you care about. Even then, expect
`.sst/artifacts` to be empty on a first run, for the reason above; measuring SST properly needs a deployed stage,
which is outside what this benchmark does.

## Configuration the fixture would use

```ts
new sst.aws.Function(name, {
  handler,
  runtime: 'nodejs24.x',
  nodejs: {
    minify: true,
    sourcemap: false,
    install: [],
    esbuild: { external: ['@aws-sdk/*'], format: 'esm', target: 'node24' }
  }
});
```

`minify` and `sourcemap` are SST's own like-for-like switches. `install: []` keeps SST from adding a separate
`node_modules` beside the bundle. `esbuild.external` is set explicitly even though SST already externalises the
AWS SDK, so the fixture states the intent rather than relying on a default. The defaults configuration is
`new sst.aws.Function(name, { handler })`.
