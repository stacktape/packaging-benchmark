# Container fixtures

Five ways to ship the same application as a long-running HTTP service. `src/server.ts` is a small `node:http`
server that imports the same `lib/` directory and the same ten handlers as the S2 ten-function Lambda shape and
dispatches requests to them.

| Variant | Built by | What it is |
| --- | --- | --- |
| `stacktape` | `stacktape package` | A Stacktape `web-service` with `stacktape-image-buildpack`: Stacktape bundles the application and builds the image. No Dockerfile. |
| `nixpacks` | `stacktape package` | The same service with Stacktape's `nixpacks` packaging: nixpacks detects Node.js, runs `npm ci`, `npm run build` and `npm run start`. No Dockerfile. |
| `paketo` | `stacktape package` | The same service with Stacktape's `external-buildpack` packaging and Paketo's `builder-jammy-base`, Stacktape's default builder. No Dockerfile. |
| `expert` | `docker build` | `Dockerfile.expert`: multi-stage, dependency install in its own cache layer, bundled application, pruned production dependencies, `node:24-slim` runtime stage, non-root user, healthcheck. |
| `typical` | `docker build` | `Dockerfile.typical`: the Dockerfile from the Node.js project's guide "Dockerizing a Node.js web app". |

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

The `nixpacks` variant replaces the packaging block with `type: nixpacks` and `sourceDirectoryPath: .`; the
`paketo` variant with `type: external-buildpack`, `sourceDirectoryPath: .` and
`builder: paketobuildpacks/builder-jammy-base`.

A container has no runtime-provided AWS SDK, so the SDK is bundled into every variant, including Stacktape's.
Every variant except `stacktape` builds with `build.mjs`, the same esbuild settings the expert build uses.

## The typical Dockerfile

It is the Node.js guide's Dockerfile with three changes, each forced by this application rather than chosen:
Node 24 instead of 18, port 3000 instead of 8080, and one `RUN npm run build`, because this application is
TypeScript and the guide's is plain JavaScript. It keeps the guide's `npm install` (dev dependencies stay in the
image), its full `node:24` base and its root user. The guide copies `package*.json` before the rest of the source,
so a source edit does not reinstall dependencies.

It replaces the earlier `naive` variant (`COPY . .` before `npm install`). That one was a Dockerfile written for
this benchmark; the guide's is the one teams actually copy. The naive image's `CMD` also never worked: Node cannot
run this TypeScript directly, because its relative imports carry no `.ts` extension.

## nixpacks and Paketo

Both need the build script to run and to pick a Node version:

- **nixpacks 1.39.0** has no Node 24. Asked for 24 it silently falls back to Node 18, so its `package.json` asks for
  `22.x`, the newest it has. It runs `npm run build` on its own.
- **Paketo** runs an npm script only when `BP_NODE_RUN_SCRIPTS` names it. Stacktape's `external-buildpack`
  packaging passes no build environment, so `project.toml` sets it; the same file keeps the local `node_modules`
  and build output out of the build. Its `package.json` asks for Node 24.

Stacktape runs the pack and nixpacks executables it downloads on first use. They were downloaded before any
timed run; see the environment block of `results/RESULTS.md`.

## How each one is measured

- **Image size**: `docker image inspect --format '{{.Size}}'`.
- **Cold build**: every build cache the variant could use is cleared first: `docker builder prune -af`, the
  variant's previous image, Stacktape's build output in the project, and pack's cache volumes (Paketo reuses layers
  from them and from the previous image). Dockerfiles also build with `--no-cache`. Base images, builders and run
  images are pulled before any timing, and each variant built by Stacktape gets one discarded build first, so no
  registry download lands inside a measurement. Downloads inside a build (nixpacks fetching Node from the Nix
  cache, Paketo fetching its Node.js distribution) are part of that build and stay in the cold time.
- **Rebuild after a source edit**: one statement appended to `src/server.ts`, cache on.
- **Rebuild after a dependency change**: `jose` moved from 6.2.12 to its previous patch release, 6.2.11, in
  `package.json` and the lockfile, cache on, with the source edit still in place. Every dependency is already at its
  newest release, so the change goes down a patch; a rebuild does the same work in either direction.
- **Registry bytes**: what a push sends. Each image's layers are read from `docker save`: the digest of every layer
  blob and its compressed size. The first push sends every layer; a rebuild sends the layers whose digest the image
  before it did not have.

Every edit is reverted afterwards.

## Why the expert build uses npm

The flat benchmark shapes install with npm, so the containers use the same package manager and the same
lockfile. `npm ci --omit=dev` is the equivalent of `pnpm install --frozen-lockfile --prod`; the structure of the
build — cached dependency layer, bundled application, pruned runtime tree — is what makes it expert, not the
package manager.
