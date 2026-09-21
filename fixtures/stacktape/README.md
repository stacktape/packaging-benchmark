# Stacktape fixture

The generator writes two configurations into every `generated/<shape>/stacktape/` project.

## Configuration files

`stacktape.yml` — the like-for-like configuration:

```yaml
resources:
  handler01:
    type: function
    properties:
      packaging:
        type: stacktape-lambda-buildpack
        properties:
          entryfilePath: src/handlers/handler-01.ts
          languageSpecificConfig:
            nodeVersion: 24
            outputModuleFormat: esm
            minify: true
            disableSourceMaps: true
      memory: 512
      timeout: 15
```

`stacktape.defaults.yml` — the defaults configuration, only the entry point:

```yaml
resources:
  handler01:
    type: function
    properties:
      packaging:
        type: stacktape-lambda-buildpack
        properties:
          entryfilePath: src/handlers/handler-01.ts
```

## Why each like-for-like setting is there

| Setting | Why |
| --- | --- |
| `minify: true` | Already Stacktape's default. Whitespace and syntax only; local identifiers are kept, which is *less* minification than the other tools' `minify: true`. |
| `disableSourceMaps: true` | Stacktape's current default puts source maps **in** the deployment package. CDK, SST and Serverless are all configured here with `sourceMap: false`, so the like-for-like run turns Stacktape's off too. The defaults table shows what leaving them on costs. |
| `nodeVersion: 24`, `outputModuleFormat: esm` | Matches the other tools' `target: node24` and ESM output. |
| AWS SDK | Left alone. Stacktape's `bundleAwsSdk` already defaults to `false`, so `@aws-sdk/client-*` and `@aws-sdk/lib-*` resolve from the Lambda runtime, which is what `externalModules: ['@aws-sdk/*']` does for the other tools. |

## YAML, not TypeScript

Stacktape supports `stacktape.yml`, `stacktape.yaml`, `stacktape.js` and `stacktape.ts`. The fixtures use YAML
because a `.ts` configuration has to `import { defineConfig } from 'stacktape'`, which means installing the CLI
package into every fixture project. YAML needs nothing installed and is what `stacktape init` writes by default.
The two forms describe the same configuration.

## How the benchmark runs it

The published CLI is a standalone binary:

```sh
stacktape package --configPath stacktape.yml --projectName pkgbench --stage dev --region eu-west-1 --profile <profile>
```

`package` resolves AWS identity with an STS call, because the account and region take part in stable resource
names. It does not deploy and it changes nothing in AWS.

These runs did not use a published release. They used a release-style Linux binary built from the Stacktape
monorepo, which reports version `4.0.0-bench`, standing in for the published v4 prerelease. It was built from
the commit and working-tree state recorded in the environment block of `results/RESULTS.md`, including
uncommitted packaging changes.

The binary runs with the fixture directory as its working directory, so `package` leaves its artifacts in
`<fixture>/.stacktape/<invocation>/build/`. The runner snapshots that directory before each run, reads the
artifacts the run produced, and deletes the invocation directory afterwards. Point the runner at a different
executable with `STACKTAPE_BINARY=/path/to/stacktape`.

`node bench/run.ts overhead` measures `stacktape version`, the binary starting up and printing its version.
That is the floor under every Stacktape measurement in the tables.

An earlier version of these results used the monorepo development wrapper (`bun run scripts/dev.ts`) instead.
That wrapper rebuilds the whole CLI with Bun on every invocation, which added about 3.3 seconds to every
measurement, and it writes its artifacts into `apps/cli/.stacktape` rather than into the fixture. Those
numbers are superseded by the binary runs.

## Artifact layout

```
build/lambdas/<function>/            unzipped function package
build/lambdas/<function>-<digest>.zip the zip Stacktape produced
build/layers/<layer>/nodejs/         shared code promoted into a Lambda layer
build/split-bundle/                  intermediate output, not an artifact
helper-lambdas/*.zip                 Stacktape's own infrastructure helpers
```

The benchmark measures `build/lambdas/*` and `build/layers/*`. It does not count `build/split-bundle`, which is
an intermediate, and it does not count `helper-lambdas/`, which are Stacktape's own service Lambdas rather than
application code — see the caveat about them in the repository README.

Functions that use a layer import from `/opt/nodejs/...`; the runner reads those paths out of each function's
JavaScript and matches them against the files in each layer, which is how the S6 footprint knows which layers
attach to which function.

## Bundler

Stacktape bundles with **Bun's bundler** (`Bun.build`, `target: node`, `format: esm`, `splitting: true`). CDK, SST
and Serverless Framework all bundle with **esbuild**. That is a real difference between the tools, not a
configuration choice the benchmark made, and it is the main reason the byte counts differ at equivalent settings.

## Caching

Stacktape's cross-machine artifact cache reads artifact digests from the customer's own S3 bucket, which is only
populated by a deployment. The benchmark never deploys, so **every Stacktape run here is a cold-cache run**.
