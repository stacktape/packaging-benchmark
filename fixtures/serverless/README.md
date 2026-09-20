# Serverless Framework fixture — pending a licence key

`serverless 4.42.0`, using the framework's built-in esbuild.

## Status

The fixture and the runner path are complete. The runs are **pending**, because Serverless Framework v4 refuses
to do anything without a licence:

```
$ serverless package
✖ Error: You must sign in or use a license key with Serverless Framework V.4 and later versions.
  Please use "serverless login".
```

`serverless package` does not deploy and does not need AWS credentials, but it does need
`SERVERLESS_ACCESS_KEY`. Set it and the tool joins every table:

```sh
SERVERLESS_ACCESS_KEY=<key> node bench/run.ts lambda
```

Without it the runner records Serverless under "tools that could not be measured" and carries on.

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

`serverless.defaults.yml` is the same file with the whole `build` block removed, so the framework's own esbuild
defaults apply.

## Command

```sh
node_modules/.bin/serverless package --config serverless.yml
node_modules/.bin/serverless package --config serverless.defaults.yml
```

Cold deletes `.serverless/` and `.esbuild/`; warm runs again immediately.

## Artifacts

Serverless writes one zip per function into `.serverless/`. It is the only tool here that hands over finished
zips, so the runner unpacks each one into `tmp/` before measuring, and the reported zipped size is computed the
same way as for every other tool. The zip Serverless itself produced is recorded separately as `toolZipBytes`.

## Incremental behaviour

Serverless Framework re-uploads every function artifact on every deployment: it has no per-artifact content hash
that lets it skip an unchanged function, the way CDK does with asset hashes, SST with Pulumi asset hashes and
Stacktape with its own digest. The S5 table reports the re-hash counts for each tool; for Serverless the
practical number of re-uploaded artifacts is all of them regardless of what the table shows.
