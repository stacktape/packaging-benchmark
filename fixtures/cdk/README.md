# AWS CDK fixture

`aws-cdk-lib` with `NodejsFunction`, bundling locally with `esbuild`. `esbuild` is a project dependency, so CDK
never falls back to bundling inside Docker.

## Configuration

`bin/app.ts` reads `BENCH_CONFIG`:

```ts
// like-for-like
new NodejsFunction(stack, name, {
  entry,
  runtime: Runtime.NODEJS_24_X,
  bundling: {
    minify: true,
    sourceMap: false,
    externalModules: ['@aws-sdk/*'],
    format: OutputFormat.ESM,
    target: 'node24'
  }
});

// defaults
new NodejsFunction(stack, name, { entry, runtime });
```

The defaults construct still needs a `runtime`, because `NodejsFunction` otherwise picks the CDK default rather
than the Node version every other fixture targets. Everything else about the defaults run is CDK's own choice:
no minification, CommonJS output, and whatever `externalModules` default applies to that runtime.

## Stack

```ts
const stack = new Stack(app, 'PackagingBenchmark');
```

No `env` is set, so the stack is environment-agnostic and `cdk synth` needs no AWS credentials and performs no
account lookups. CDK is the only tool here that packages with no AWS contact at all.

## Commands

```sh
node_modules/.bin/cdk synth --output cdk.out.likeforlike --quiet   # BENCH_CONFIG=likeforlike
node_modules/.bin/cdk synth --output cdk.out.defaults --quiet      # BENCH_CONFIG=defaults
```

The two configurations write to separate output directories so one never warms the other's cache.

`cdk.json` sets `"app": "node_modules/.bin/tsx bin/app.ts"`. `tsx` rather than `ts-node` because it starts
faster; its start-up is part of CDK's measured wall clock, exactly as `bun`'s is part of Stacktape's.

## Artifacts

`cdk synth` writes one `cdk.out.<config>/asset.<hash>/` directory per function — a directory, not a zip; the zip
is made at `cdk deploy` time. The benchmark therefore measures the directory and computes the zipped size the
same way it does for every other tool.

`PackagingBenchmark.template.json` carries `Metadata["aws:asset:path"]` on each `AWS::Lambda::Function`, which is
how the runner maps an asset directory back to the function that uses it.

CDK has no shared-layer mechanism for `NodejsFunction` bundles: every function gets its own complete bundle, so
the S6 footprint for CDK is the bundle alone.

## Cold and warm

Cold deletes `cdk.out.<config>`. Warm runs `cdk synth` again immediately with no source change; CDK's asset
staging can then reuse the existing asset directories.
