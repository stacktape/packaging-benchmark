# Substantial backend benchmarks

These fixtures extend the older starter-app benchmark. Pilot runs establish correctness and measurement boundaries;
they are not a publication data set.

## Report-generation Lambdas

The handler writes and reads an XLSX workbook, produces PDF and DOCX files, validates the input, and processes dates
and XML. Every application dependency is exercised. Its standalone compiled payload exceeds 2.5 MB without padding.
The 25-function case represents separate report domains with the same dependencies. It is not the partially shared
pnpm monorepo case, which must be measured separately.

```sh
node fixtures/substantial.mjs 1 cjs
cp fixtures/locks/reports-1.yaml generated/reports-1/pnpm-lock.yaml
cd generated/reports-1
pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts
cd ../..

node fixtures/substantial.mjs 25 esm
cp fixtures/locks/reports-25-esm.yaml generated/reports-25-esm/pnpm-lock.yaml
cd generated/reports-25-esm
pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts
cd ../..

BENCH_STACKTAPE_BINARY=/absolute/path/to/current/stacktape node bench/substantial.ts 25 5 esm
```

The controlled presets retain identifiers while minifying whitespace and syntax, disable source maps, use Node 24
and x86_64, and leave the same AWS SDK family to the Lambda runtime. ESM is required for Stacktape's automatic code
splitting. The native CommonJS preset is a separate case; do not mix its observations into ESM results.

The harness rotates tool order and records project-cold, unique edit, and unchanged runs. Dependency installation,
identity and tool caches are deliberately warm. It waits up to two minutes for host load below 2 before a sample;
cooldown is excluded from command timing. Failures and earlier samples are retained if the guard stops a run.

Timing is the entire native package command or CDK synth. CDK leaves directory assets unzipped, and Stacktape leaves
shared layers unzipped until deployment. These command times are not a common “every deployment ZIP ready” endpoint.
Serverless native ZIP sizes are measured directly. Normalized ZIP sizes for unarchived assets are estimates; never
present them as actual upload bytes. Count shared layers once in total unique bytes, and include attached layers in
each function's runtime footprint.

`qualify-lambda-artifacts.py` invokes the artifacts in real AWS Lambda, including Stacktape's shared layer. Archiving
the deferred assets occurs outside packaging timing. This procedure measures artifact correctness, not framework
deployment speed. It creates only uniquely named resources, verifies the account, writes recovery state before
effects, and removes the resources in `finally`. Review the explicit account/profile/region guard before use.

```sh
BENCH_AWS_ACCOUNT=<expected-account> BENCH_AWS_PROFILE=<test-profile> BENCH_AWS_REGION=<region> \
  python3 bench/qualify-lambda-artifacts.py tmp/<completed-pilot-directory>
python3 bench/qualify-lambda-artifacts.py --cleanup-only tmp/<owner>-aws.json
```

## Medusa backend

`fixtures/medusa` contains the MIT-licensed backend from the pinned official DTC starter, with its normal Admin build
and no separate storefront. `UPSTREAM.md` lists the source and benchmark adaptations. Production Redis modules and
separate server/worker modes follow Medusa's deployment guide. The revision route observes fresh deployments; an
authenticated product route and subscriber verify PostgreSQL and the separate Redis worker.

```sh
cd fixtures/medusa
pnpm install --frozen-lockfile --filter @dtc/backend... --ignore-scripts
bash build.sh
cd ../..
python3 bench/qualify-medusa.py
python3 bench/qualify-medusa.py <built-image>
```

The qualifier uses pinned local PostgreSQL/Redis image digests, creates isolated containers and a network, records
evidence under ignored `tmp/`, and verifies deletion. Supply both image digests locally before running it. It does
not alter shared databases or globally prune Docker caches.

Hosted Render/Ravion builds and local image builds are separate populations. Record region, build resources, plan,
queue, cache state and complete rollout completion. For updates, observe the new revision and completed provider
rollout from one clock; a provider's successful build alone is insufficient.

Before making website claims, finish the SST and partially shared monorepo cases, qualify each runtime, collect the
predeclared publication samples across two sessions, and rerun against the intended released CLI and runner image.
Keep the full observations, including failures and outliers, with the resulting report.
