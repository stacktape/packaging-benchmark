// Control-shape handler for S3 ("shares nothing").
//
// Every helper this file needs is inlined here, and each inlined copy carries the handler index in a
// string literal or a numeric constant, so no two handlers in the shape contain byte-identical code.
// A bundler therefore cannot deduplicate anything across handlers, which is the point of the control.
//
// The generator keeps only the /*#IF:feature*/ blocks that belong to this handler's dependency subset,
// so different handlers in the same shape pull in different npm packages.

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { pino } from 'pino';
import { decodeJwt } from 'jose';

const ROUTE = 'orders-20';
const HANDLER_NAME = 'handler20';
const HANDLER_INDEX = 20;
const SALT = 'standalone-20-orders-20';

type MinimalEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
};

// --- inlined response helper (copy 20) ---
const respond20 = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'x-bench-route': ROUTE },
  body: JSON.stringify({ ...body, salt: SALT })
});

// --- inlined chunk helper (copy 20) ---
const chunk20 = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size + (HANDLER_INDEX % 2)) out.push(items.slice(i, i + size));
  return out;
};

// --- inlined logger (copy 20) ---
const log20 = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'packaging-benchmark-standalone', route: ROUTE, copy: '20' },
  redact: { paths: ['req.headers.authorization'], censor: '[redacted-20]' },
  timestamp: pino.stdTimeFunctions.isoTime
});

// --- inlined schema (copy 20) ---
const money20 = z.object({
  currency: z.enum(['EUR', 'USD', 'GBP']),
  amountMinor: z.number().int().nonnegative()
});
const line20 = z.object({
  sku: z.string().regex(/^[A-Z0-9-]{3,32}$/),
  quantity: z.number().int().positive().max(999),
  unitPrice: money20,
  note: z.string().max(280).optional()
});
const address20 = z.object({
  line1: z.string().min(1).max(120),
  city: z.string().min(1).max(80),
  postalCode: z.string().min(2).max(16),
  country: z.string().length(2)
});
const orderSchema20 = z.object({
  orderId: z.string().min(6).max(64),
  customerId: z.string().min(3).max(64),
  placedAt: z.iso.datetime(),
  dueDate: z.iso.datetime(),
  channel: z.enum(['web', 'mobile', 'partner', 'internal']),
  shipping: address20,
  lines: z.array(line20).min(1).max(100),
  metadata: z.record(z.string(), z.string()).optional()
});

// --- inlined auth (copy 20) ---
const tenantOf20 = (header: string | undefined) => {
  if (!header) throw new Error(`missing authorization header (${SALT})`);
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw new Error(`malformed authorization (${SALT})`);
  const payload = decodeJwt(token);
  return typeof payload.tenantId === 'string' ? payload.tenantId : `anonymous-${HANDLER_INDEX}`;
};

// --- inlined S3 access (copy 20) ---
const bucket20 = process.env.BUCKET_NAME ?? 'packaging-benchmark-documents';
const objects20 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1', maxAttempts: 3 });
const putDocument20 = async (key: string, body: string) => {
  await objects20.send(
    new PutObjectCommand({ Bucket: bucket20, Key: key, Body: body, ContentType: 'application/json' })
  );
  return `s3://${bucket20}/${key}`;
};

export const handler = async (event: MinimalEvent) => {
  const startedAt = Date.now();
  const requestId = event.requestContext?.requestId ?? `req-${HANDLER_INDEX}-${startedAt}`;
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;

  try {
    let tenantId = `tenant-${HANDLER_INDEX}`;
    tenantId = tenantOf20(authHeader);

    const raw = JSON.parse(event.body ?? '{}');
    let orderId = String(raw.orderId ?? `order-${HANDLER_INDEX}`);
    let lineCount = Array.isArray(raw.lines) ? raw.lines.length : 0;
    let totalMinor = 0;

    const parsed = orderSchema20.safeParse(raw);
    if (!parsed.success) {
      return respond20(400, { error: 'invalid_order', issues: parsed.error.issues.slice(0, 3) });
    }
    orderId = parsed.data.orderId;
    lineCount = parsed.data.lines.length;
    totalMinor = parsed.data.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice.amountMinor, 0);

    let id = `ord_${HANDLER_INDEX}_${startedAt}`;

    let leadDays = HANDLER_INDEX % 7;
    let updatedAt = new Date().toISOString();

    const record: Record<string, unknown> = {
      pk: `tenant#${tenantId}`,
      sk: `order#${orderId}#${HANDLER_INDEX}`,
      id,
      route: ROUTE,
      lineCount,
      totalMinor,
      leadDays,
      updatedAt
    };

    let batches = 0;

    await putDocument20(`orders/${tenantId}/${id}.json`, JSON.stringify(record));

    log20.info({ id, requestId, batches }, 'order processed');

    return respond20(200, {
      id,
      handler: HANDLER_NAME,
      route: ROUTE,
      batches,
      totalMinor,
      tookMs: Date.now() - startedAt
    });
  } catch (error) {
    log20.error({ err: error, requestId }, 'handler failed');
    return respond20(500, { error: 'internal_error', route: ROUTE });
  }
};
