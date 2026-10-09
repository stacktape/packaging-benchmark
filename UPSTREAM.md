Medusa DTC backend from https://github.com/medusajs/dtc-starter
Commit: 15ef93da7d155ad990d8cc6db0296446fecbdfe6
MIT license retained. No separate storefront.

Node 24.15.0 is pinned for platform parity.

Benchmark adaptations: production Redis modules, server/worker environment configuration, revision endpoint and a product-created subscriber to verify the worker. No synthetic payload padding.

`railpack.json` explicitly retains Medusa's generated production server directory, including its separate production dependency installation. Some automatic Node image plans otherwise omit that directory's `node_modules`. This uses Railpack's native configuration and keeps the same install/build/start commands; it adds no Dockerfile.
