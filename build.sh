#!/usr/bin/env bash
set -euo pipefail
pnpm --filter @dtc/backend build
cp runtime-pnpm-lock.yaml apps/backend/.medusa/server/pnpm-lock.yaml
cd apps/backend/.medusa/server
pnpm --ignore-workspace install --prod --frozen-lockfile --ignore-scripts
