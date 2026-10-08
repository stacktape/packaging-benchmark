import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createProductsWorkflow } from "@medusajs/medusa/core-flows"

export async function POST(req: MedusaRequest<{ nonce: string }>, res: MedusaResponse) {
  if (!process.env.BENCHMARK_TOKEN || req.headers["x-benchmark-token"] !== process.env.BENCHMARK_TOKEN) {
    res.sendStatus(401)
    return
  }
  const nonce = req.body?.nonce
  if (typeof nonce !== "string" || !/^[a-z0-9-]{1,64}$/.test(nonce)) {
    res.status(400).json({ error: "Invalid nonce" })
    return
  }
  const { result } = await createProductsWorkflow(req.scope).run({
    input: {
      products: [{
        title: `Benchmark ${nonce}`,
        handle: `benchmark-${nonce}`,
        metadata: { benchmark_nonce: nonce },
        options: [{ title: "Size", values: ["Standard"] }],
        variants: [{ title: "Standard", sku: nonce, options: { Size: "Standard" }, prices: [{ currency_code: "usd", amount: 12500 }] }],
      }],
    },
  })
  res.status(201).json({ id: result[0].id, nonce })
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!process.env.BENCHMARK_TOKEN || req.headers["x-benchmark-token"] !== process.env.BENCHMARK_TOKEN) {
    res.sendStatus(401)
    return
  }
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "product",
    fields: ["id", "title", "metadata"],
    filters: { id: String(req.query.id || "") },
  })
  res.json({ products: data })
}
