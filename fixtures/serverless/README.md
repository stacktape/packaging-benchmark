# Serverless Framework fixture

`serverless 4.42.0`, using the framework's built-in esbuild.

## Licence key

Serverless Framework v4 refuses to run without one:

```
$ serverless package
✖ Error: You must sign in or use a license key with Serverless Framework V.4 and later versions.
```

`serverless package` does not deploy, but it needs `SERVERLESS_ACCESS_KEY` and AWS credentials: it reads
CloudFormation and the SSM parameter `/serverless-framework/deployment/s3-bucket`, and when that parameter is missing
it creates it and a `serverless-framework-deployments-<region>-<id>` bucket. The first run of this benchmark did so. With the variable set the runner includes Serverless in every table; without it
the runner records it as blocked and carries on.

## Configuration

`serverless.yml` — like-for-like:

```yaml
service: packaging-benchmark
provider:
  name: aws
  runtime: nodejs24.x
  region: eu-west-1
build:
  esbuild:
    minify: true
    sourcemap: false
    external:
      - '@aws-sdk/*'
functions:
  handler01:
    handler: src/handlers/handler-01.handler
```

`serverless.defaults.yml` is the same file with the whole `build` block removed, so the framework's own
esbuild defaults apply.

## Command

```sh
node_modules/.bin/serverless package --config serverless.yml --stage dev --region eu-west-1
```

Cold deletes `.serverless/` and `.esbuild/`; warm runs again immediately.

## One package for the whole service

This is the single most important thing about Serverless Framework's output here, and it is its default
behaviour, not a setting this benchmark chose.

`serverless package` produces **one zip for the entire service**, not one per function:

```
.serverless/packaging-benchmark.zip
  package.json
  package-lock.json
  src/handlers/handler-01.js
  src/handlers/handler-02.js
  ...
```

Every Lambda function in the stack is created from that same zip, with a different handler path. Two
consequences:

- **Upload bytes are competitive.** One package, sent once. At 25 functions it is within a kilobyte of what
  CDK uploads across 25 separate assets.
- **The cold-start footprint is not.** Each function loads the whole service package, so the footprint per
  function is the sum of every function's bundle. At 50 functions, like-for-like, that is 26.6 MB per
  function; with the framework's defaults it is 134 MB. The other three tools stay flat as functions are
  added.

`package: individually: true` changes this, at the cost of bundling each function separately. The benchmark
measures the default, because that is what a project gets without deciding otherwise. The size tables
therefore show Serverless with `Functions: 25` but `Code artifacts: 1`.

## Incremental behaviour

Because there is one artifact, any change re-hashes it. The S5 table shows a one-line change to a single
handler re-hashing the whole 3 MB service package, against 1.4 KB for Stacktape and 122 KB for CDK.
Serverless Framework also re-uploads every function artifact on every deployment regardless of content, so
even an unchanged redeploy sends the whole package.

## Artifacts

The runner unpacks `.serverless/*.zip` into `tmp/` before measuring, so unzipped bytes, the deterministic
zip size and the content hash are computed the same way as for every other tool. The zip Serverless itself
produced is recorded separately as `toolZipBytes`.
