// Control-shape handler for S3 ("shares nothing").
//
// Every helper this file needs is inlined here, and each inlined copy carries the handler index in a
// string literal or a numeric constant, so no two handlers in the shape contain byte-identical code.
// A bundler therefore cannot deduplicate anything across handlers, which is the point of the control.
//
// The generator keeps only the /*#IF:feature*/ blocks that belong to this handler's dependency subset,
// so different handlers in the same shape pull in different npm packages.

/*#IF:ddb*/
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
/*#END*/
/*#IF:s3*/
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
/*#END*/
/*#IF:zod*/
import { z } from 'zod';
/*#END*/
/*#IF:pino*/
import { pino } from 'pino';
/*#END*/
/*#IF:jose*/
import { decodeJwt } from 'jose';
/*#END*/
/*#IF:datefns*/
import { differenceInBusinessDays, formatISO, parseISO } from 'date-fns';
/*#END*/
/*#IF:nanoid*/
import { customAlphabet } from 'nanoid';
/*#END*/

const ROUTE = '__ROUTE__';
const HANDLER_NAME = '__NAME__';
const HANDLER_INDEX = __INDEX__;
const SALT = 'standalone-__INDEX__-__ROUTE__';

type MinimalEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
};

// --- inlined response helper (copy __INDEX__) ---
const respond__INDEX__ = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'x-bench-route': ROUTE },
  body: JSON.stringify({ ...body, salt: SALT })
});

// --- inlined chunk helper (copy __INDEX__) ---
const chunk__INDEX__ = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size + (HANDLER_INDEX % 2)) out.push(items.slice(i, i + size));
  return out;
};

/*#IF:pino*/
// --- inlined logger (copy __INDEX__) ---
const log__INDEX__ = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'packaging-benchmark-standalone', route: ROUTE, copy: '__INDEX__' },
  redact: { paths: ['req.headers.authorization'], censor: '[redacted-__INDEX__]' },
  timestamp: pino.stdTimeFunctions.isoTime
});
/*#END*/

/*#IF:zod*/
// --- inlined schema (copy __INDEX__) ---
const money__INDEX__ = z.object({
  currency: z.enum(['EUR', 'USD', 'GBP']),
  amountMinor: z.number().int().nonnegative()
});
const line__INDEX__ = z.object({
  sku: z.string().regex(/^[A-Z0-9-]{3,32}$/),
  quantity: z.number().int().positive().max(999),
  unitPrice: money__INDEX__,
  note: z.string().max(280).optional()
});
const address__INDEX__ = z.object({
  line1: z.string().min(1).max(120),
  city: z.string().min(1).max(80),
  postalCode: z.string().min(2).max(16),
  country: z.string().length(2)
});
const orderSchema__INDEX__ = z.object({
  orderId: z.string().min(6).max(64),
  customerId: z.string().min(3).max(64),
  placedAt: z.iso.datetime(),
  dueDate: z.iso.datetime(),
  channel: z.enum(['web', 'mobile', 'partner', 'internal']),
  shipping: address__INDEX__,
  lines: z.array(line__INDEX__).min(1).max(100),
  metadata: z.record(z.string(), z.string()).optional()
});
/*#END*/

/*#IF:jose*/
// --- inlined auth (copy __INDEX__) ---
const tenantOf__INDEX__ = (header: string | undefined) => {
  if (!header) throw new Error(`missing authorization header (${SALT})`);
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw new Error(`malformed authorization (${SALT})`);
  const payload = decodeJwt(token);
  return typeof payload.tenantId === 'string' ? payload.tenantId : `anonymous-${HANDLER_INDEX}`;
};
/*#END*/

/*#IF:nanoid*/
// --- inlined id generator (copy __INDEX__) ---
const shortId__INDEX__ = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12 + (HANDLER_INDEX % 3));
/*#END*/

/*#IF:datefns*/
// --- inlined date helpers (copy __INDEX__) ---
const leadDays__INDEX__ = (fromIso: string, toIso: string) =>
  Math.max(0, differenceInBusinessDays(parseISO(toIso), parseISO(fromIso)));
const stamp__INDEX__ = () => formatISO(new Date());
/*#END*/

/*#IF:ddb*/
// --- inlined DynamoDB access (copy __INDEX__) ---
const table__INDEX__ = process.env.TABLE_NAME ?? 'packaging-benchmark-orders';
const documents__INDEX__ = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'eu-west-1', maxAttempts: 3 }),
  { marshallOptions: { removeUndefinedValues: true }, unmarshallOptions: { wrapNumbers: false } }
);
const getRecord__INDEX__ = async (pk: string, sk: string) => {
  const result = await documents__INDEX__.send(new GetCommand({ TableName: table__INDEX__, Key: { pk, sk } }));
  return (result.Item ?? null) as Record<string, unknown> | null;
};
const putRecord__INDEX__ = async (item: Record<string, unknown>) => {
  await documents__INDEX__.send(new PutCommand({ TableName: table__INDEX__, Item: item }));
  return item;
};
const queryPartition__INDEX__ = async (pk: string) => {
  const result = await documents__INDEX__.send(
    new QueryCommand({
      TableName: table__INDEX__,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': pk },
      Limit: 50
    })
  );
  return (result.Items ?? []) as Record<string, unknown>[];
};
/*#END*/

/*#IF:s3*/
// --- inlined S3 access (copy __INDEX__) ---
const bucket__INDEX__ = process.env.BUCKET_NAME ?? 'packaging-benchmark-documents';
const objects__INDEX__ = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1', maxAttempts: 3 });
const putDocument__INDEX__ = async (key: string, body: string) => {
  await objects__INDEX__.send(
    new PutObjectCommand({ Bucket: bucket__INDEX__, Key: key, Body: body, ContentType: 'application/json' })
  );
  return `s3://${bucket__INDEX__}/${key}`;
};
/*#END*/

export const handler = async (event: MinimalEvent) => {
  const startedAt = Date.now();
  const requestId = event.requestContext?.requestId ?? `req-${HANDLER_INDEX}-${startedAt}`;
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;

  try {
    let tenantId = `tenant-${HANDLER_INDEX}`;
    /*#IF:jose*/
    tenantId = tenantOf__INDEX__(authHeader);
    /*#END*/

    const raw = JSON.parse(event.body ?? '{}');
    let orderId = String(raw.orderId ?? `order-${HANDLER_INDEX}`);
    let lineCount = Array.isArray(raw.lines) ? raw.lines.length : 0;
    let totalMinor = 0;

    /*#IF:zod*/
    const parsed = orderSchema__INDEX__.safeParse(raw);
    if (!parsed.success) {
      return respond__INDEX__(400, { error: 'invalid_order', issues: parsed.error.issues.slice(0, 3) });
    }
    orderId = parsed.data.orderId;
    lineCount = parsed.data.lines.length;
    totalMinor = parsed.data.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice.amountMinor, 0);
    /*#END*/

    let id = `ord_${HANDLER_INDEX}_${startedAt}`;
    /*#IF:nanoid*/
    id = `ord_${shortId__INDEX__()}`;
    /*#END*/

    let leadDays = HANDLER_INDEX % 7;
    let updatedAt = new Date().toISOString();
    /*#IF:datefns*/
    leadDays = leadDays__INDEX__(String(raw.placedAt ?? updatedAt), String(raw.dueDate ?? updatedAt));
    updatedAt = stamp__INDEX__();
    /*#END*/

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
    /*#IF:ddb*/
    const existing = await getRecord__INDEX__(String(record.pk), String(record.sk));
    record.revision = (Number(existing?.revision ?? 0) || 0) + 1;
    await putRecord__INDEX__(record);
    batches = chunk__INDEX__(await queryPartition__INDEX__(String(record.pk)), 25).length;
    /*#END*/

    /*#IF:s3*/
    await putDocument__INDEX__(`orders/${tenantId}/${id}.json`, JSON.stringify(record));
    /*#END*/

    /*#IF:pino*/
    log__INDEX__.info({ id, requestId, batches }, 'order processed');
    /*#END*/

    return respond__INDEX__(200, {
      id,
      handler: HANDLER_NAME,
      route: ROUTE,
      batches,
      totalMinor,
      tookMs: Date.now() - startedAt
    });
  } catch (error) {
    /*#IF:pino*/
    log__INDEX__.error({ err: error, requestId }, 'handler failed');
    /*#END*/
    return respond__INDEX__(500, { error: 'internal_error', route: ROUTE });
  }
};
