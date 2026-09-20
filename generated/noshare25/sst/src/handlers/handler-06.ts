// Control-shape handler for S3 ("shares nothing").
//
// Every helper this file needs is inlined here, and each inlined copy carries the handler index in a
// string literal or a numeric constant, so no two handlers in the shape contain byte-identical code.
// A bundler therefore cannot deduplicate anything across handlers, which is the point of the control.
//
// The generator keeps only the /*#IF:feature*/ blocks that belong to this handler's dependency subset,
// so different handlers in the same shape pull in different npm packages.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { differenceInBusinessDays, formatISO, parseISO } from 'date-fns';

const ROUTE = 'orders-06';
const HANDLER_NAME = 'handler06';
const HANDLER_INDEX = 6;
const SALT = 'standalone-6-orders-06';

type MinimalEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
};

// --- inlined response helper (copy 6) ---
const respond6 = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'x-bench-route': ROUTE },
  body: JSON.stringify({ ...body, salt: SALT })
});

// --- inlined chunk helper (copy 6) ---
const chunk6 = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size + (HANDLER_INDEX % 2)) out.push(items.slice(i, i + size));
  return out;
};

// --- inlined schema (copy 6) ---
const money6 = z.object({
  currency: z.enum(['EUR', 'USD', 'GBP']),
  amountMinor: z.number().int().nonnegative()
});
const line6 = z.object({
  sku: z.string().regex(/^[A-Z0-9-]{3,32}$/),
  quantity: z.number().int().positive().max(999),
  unitPrice: money6,
  note: z.string().max(280).optional()
});
const address6 = z.object({
  line1: z.string().min(1).max(120),
  city: z.string().min(1).max(80),
  postalCode: z.string().min(2).max(16),
  country: z.string().length(2)
});
const orderSchema6 = z.object({
  orderId: z.string().min(6).max(64),
  customerId: z.string().min(3).max(64),
  placedAt: z.iso.datetime(),
  dueDate: z.iso.datetime(),
  channel: z.enum(['web', 'mobile', 'partner', 'internal']),
  shipping: address6,
  lines: z.array(line6).min(1).max(100),
  metadata: z.record(z.string(), z.string()).optional()
});

// --- inlined date helpers (copy 6) ---
const leadDays6 = (fromIso: string, toIso: string) =>
  Math.max(0, differenceInBusinessDays(parseISO(toIso), parseISO(fromIso)));
const stamp6 = () => formatISO(new Date());

// --- inlined DynamoDB access (copy 6) ---
const table6 = process.env.TABLE_NAME ?? 'packaging-benchmark-orders';
const documents6 = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'eu-west-1', maxAttempts: 3 }),
  { marshallOptions: { removeUndefinedValues: true }, unmarshallOptions: { wrapNumbers: false } }
);
const getRecord6 = async (pk: string, sk: string) => {
  const result = await documents6.send(new GetCommand({ TableName: table6, Key: { pk, sk } }));
  return (result.Item ?? null) as Record<string, unknown> | null;
};
const putRecord6 = async (item: Record<string, unknown>) => {
  await documents6.send(new PutCommand({ TableName: table6, Item: item }));
  return item;
};
const queryPartition6 = async (pk: string) => {
  const result = await documents6.send(
    new QueryCommand({
      TableName: table6,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': pk },
      Limit: 50
    })
  );
  return (result.Items ?? []) as Record<string, unknown>[];
};

export const handler = async (event: MinimalEvent) => {
  const startedAt = Date.now();
  const requestId = event.requestContext?.requestId ?? `req-${HANDLER_INDEX}-${startedAt}`;
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;

  try {
    let tenantId = `tenant-${HANDLER_INDEX}`;

    const raw = JSON.parse(event.body ?? '{}');
    let orderId = String(raw.orderId ?? `order-${HANDLER_INDEX}`);
    let lineCount = Array.isArray(raw.lines) ? raw.lines.length : 0;
    let totalMinor = 0;

    const parsed = orderSchema6.safeParse(raw);
    if (!parsed.success) {
      return respond6(400, { error: 'invalid_order', issues: parsed.error.issues.slice(0, 3) });
    }
    orderId = parsed.data.orderId;
    lineCount = parsed.data.lines.length;
    totalMinor = parsed.data.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice.amountMinor, 0);

    let id = `ord_${HANDLER_INDEX}_${startedAt}`;

    let leadDays = HANDLER_INDEX % 7;
    let updatedAt = new Date().toISOString();
    leadDays = leadDays6(String(raw.placedAt ?? updatedAt), String(raw.dueDate ?? updatedAt));
    updatedAt = stamp6();

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
    const existing = await getRecord6(String(record.pk), String(record.sk));
    record.revision = (Number(existing?.revision ?? 0) || 0) + 1;
    await putRecord6(record);
    batches = chunk6(await queryPartition6(String(record.pk)), 25).length;

    return respond6(200, {
      id,
      handler: HANDLER_NAME,
      route: ROUTE,
      batches,
      totalMinor,
      tookMs: Date.now() - startedAt
    });
  } catch (error) {
    return respond6(500, { error: 'internal_error', route: ROUTE });
  }
};
