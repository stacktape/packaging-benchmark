# Container fixtures

Three ways to ship the same application as a long-running HTTP service. `src/server.ts` is a small `node:http`
server that imports the same `lib/` directory and the same ten handlers as the S2 ten-function Lambda shape and
dispatches requests to them.

| Variant | What it is |
| --- | --- |
| `stacktape` | A Stacktape `web-service` with `stacktape-image-buildpack`. `stacktape package` builds the image; no Dockerfile is written by hand. |
| `expert` | `Dockerfile.expert`: multi-stage, dependency install in its own cache layer, bundled application, pruned production dependencies, `node:24-slim` runtime stage, non-root user, healthcheck. |
| `naive` | `Dockerfile.naive`: `FROM node:24`, `COPY . .`, `npm install`, run the TypeScript directly. |

## Stacktape configuration

```yaml
resources:
  api:
    type: web-service
    properties:
      packaging:
        type: stacktape-image-buildpack
        properties:
          entryfilePath: src/server.ts
          languageSpecificConfig:
            nodeVersion: 24
            outputModuleFormat: esm
            minify: true
            disableSourceMaps: true
      resources:
        cpu: 0.25
        memory: 512
```

A container has no runtime-provided AWS SDK, so the SDK is bundled into every container variant, including
Stacktape's. The expert build's `build.mjs` uses the same esbuild settings for the same reason.

## How each one is measured

- **Image size**: `docker image inspect --format '{{.Size}}'`.
- **Cold build**: `docker builder prune -af`, then `docker build --no-cache`. Base images are pulled first, and
  the Stacktape variant gets one discarded build before timing, so no registry download lands inside a
  measurement. `docker builder prune -af` clears the build cache without removing images.
- **Warm rebuild**: one statement appended to `src/server.ts`, then `docker build` with the cache on. The change
  is reverted afterwards.

## Is the naive build a strawman?

It is deliberately the version most teams write first, but it is not made worse than that:

- it gets a `.dockerignore` that excludes `node_modules`, `dist`, `.git` and `tmp`, which is the one thing almost
  every naive setup does have;
- it uses a current Node base image, not an old one;
- it installs with `npm install`, not `npm install --force` or anything unusual.

What makes it naive is the full `node:24` base instead of a slim one, `COPY . .` before the install so any source
change reinstalls every dependency, dev dependencies kept in the final image, running as root, and compiling
TypeScript at start-up instead of at build time.

## Why the expert build uses npm

The flat benchmark shapes install with npm, so the container uses the same package manager and the same
lockfile. `npm ci --omit=dev` is the equivalent of `pnpm install --frozen-lockfile --prod`; the structure of the
build — cached dependency layer, bundled application, pruned runtime tree — is what makes it expert, not the
package manager.
