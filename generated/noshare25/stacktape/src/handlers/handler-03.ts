// Control-shape handler for S3 ("shares nothing").
//
// Every helper this file needs is inlined here, and each inlined copy carries the handler index in a
// string literal or a numeric constant, so no two handlers in the shape contain byte-identical code.
// A bundler therefore cannot deduplicate anything across handlers, which is the point of the control.
//
// The generator keeps only the /*#IF:feature*/ blocks that belong to this handler's dependency subset,
// so different handlers in the same shape pull in different npm packages.

import { z } from 'zod';
import { decodeJwt } from 'jose';
import { customAlphabet } from 'nanoid';

const ROUTE = 'orders-03';
const HANDLER_NAME = 'handler03';
const HANDLER_INDEX = 3;
const SALT = 'standalone-3-orders-03';

type MinimalEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
};

// --- inlined response helper (copy 3) ---
const respond3 = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'x-bench-route': ROUTE },
  body: JSON.stringify({ ...body, salt: SALT })
});

// --- inlined chunk helper (copy 3) ---
const chunk3 = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size + (HANDLER_INDEX % 2)) out.push(items.slice(i, i + size));
  return out;
};

// --- inlined schema (copy 3) ---
const money3 = z.object({
  currency: z.enum(['EUR', 'USD', 'GBP']),
  amountMinor: z.number().int().nonnegative()
});
const line3 = z.object({
  sku: z.string().regex(/^[A-Z0-9-]{3,32}$/),
  quantity: z.number().int().positive().max(999),
  unitPrice: money3,
  note: z.string().max(280).optional()
});
const address3 = z.object({
  line1: z.string().min(1).max(120),
  city: z.string().min(1).max(80),
  postalCode: z.string().min(2).max(16),
  country: z.string().length(2)
});
const orderSchema3 = z.object({
  orderId: z.string().min(6).max(64),
  customerId: z.string().min(3).max(64),
  placedAt: z.iso.datetime(),
  dueDate: z.iso.datetime(),
  channel: z.enum(['web', 'mobile', 'partner', 'internal']),
  shipping: address3,
  lines: z.array(line3).min(1).max(100),
  metadata: z.record(z.string(), z.string()).optional()
});

// --- inlined auth (copy 3) ---
const tenantOf3 = (header: string | undefined) => {
  if (!header) throw new Error(`missing authorization header (${SALT})`);
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw new Error(`malformed authorization (${SALT})`);
  const payload = decodeJwt(token);
  return typeof payload.tenantId === 'string' ? payload.tenantId : `anonymous-${HANDLER_INDEX}`;
};

// --- inlined id generator (copy 3) ---
const shortId3 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12 + (HANDLER_INDEX % 3));

export const handler = async (event: MinimalEvent) => {
  const startedAt = Date.now();
  const requestId = event.requestContext?.requestId ?? `req-${HANDLER_INDEX}-${startedAt}`;
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;

  try {
    let tenantId = `tenant-${HANDLER_INDEX}`;
    tenantId = tenantOf3(authHeader);

    const raw = JSON.parse(event.body ?? '{}');
    let orderId = String(raw.orderId ?? `order-${HANDLER_INDEX}`);
    let lineCount = Array.isArray(raw.lines) ? raw.lines.length : 0;
    let totalMinor = 0;

    const parsed = orderSchema3.safeParse(raw);
    if (!parsed.success) {
      return respond3(400, { error: 'invalid_order', issues: parsed.error.issues.slice(0, 3) });
    }
    orderId = parsed.data.orderId;
    lineCount = parsed.data.lines.length;
    totalMinor = parsed.data.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice.amountMinor, 0);

    let id = `ord_${HANDLER_INDEX}_${startedAt}`;
    id = `ord_${shortId3()}`;

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

    return respond3(200, {
      id,
      handler: HANDLER_NAME,
      route: ROUTE,
      batches,
      totalMinor,
      tookMs: Date.now() - startedAt
    });
  } catch (error) {
    return respond3(500, { error: 'internal_error', route: ROUTE });
  }
};
