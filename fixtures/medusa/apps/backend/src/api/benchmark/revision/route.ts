import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export async function GET(_req: MedusaRequest, res: MedusaResponse) {
  res.json({ revision: "base", workerMode: process.env.MEDUSA_WORKER_MODE })
}
