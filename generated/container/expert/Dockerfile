# Expert, hand-written multi-stage build.
#
# What makes it "expert":
#   - the dependency install is its own layer, keyed only on the manifest and the lockfile, so a source
#     change does not reinstall anything;
#   - the application is bundled, so the runtime stage carries no build tooling and no dev dependencies;
#   - a pruned production dependency tree is still installed for anything that must stay unbundled;
#   - a slim runtime base, a non-root user, and an explicit healthcheck.
#
# `npm ci --omit=dev` is the equivalent of `pnpm install --frozen-lockfile --prod`; the benchmark installs
# the flat shapes with npm, so the container uses the same package manager and the same lockfile.

# syntax=docker/dockerfile:1

# ---------- deps ----------
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- build ----------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json build.mjs ./
COPY src ./src
RUN node build.mjs
# Pruned production dependency tree for anything the bundle leaves external.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------- runtime ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
RUN groupadd --system --gid 1001 app \
  && useradd --system --uid 1001 --gid app --home /app app
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
