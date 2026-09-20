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
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { pino } from 'pino';
import { differenceInBusinessDays, formatISO, parseISO } from 'date-fns';

const ROUTE = 'orders-09';
const HANDLER_NAME = 'handler09';
const HANDLER_INDEX = 9;
const SALT = 'standalone-9-orders-09';

type MinimalEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
};

// --- inlined response helper (copy 9) ---
const respond9 = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'x-bench-route': ROUTE },
  body: JSON.stringify({ ...body, salt: SALT })
});

// --- inlined chunk helper (copy 9) ---
const chunk9 = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size + (HANDLER_INDEX % 2)) out.push(items.slice(i, i + size));
  return out;
};

// --- inlined logger (copy 9) ---
const log9 = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'packaging-benchmark-standalone', route: ROUTE, copy: '9' },
  redact: { paths: ['req.headers.authorization'], censor: '[redacted-9]' },
  timestamp: pino.stdTimeFunctions.isoTime
});

// --- inlined date helpers (copy 9) ---
const leadDays9 = (fromIso: string, toIso: string) =>
  Math.max(0, differenceInBusinessDays(parseISO(toIso), parseISO(fromIso)));
const stamp9 = () => formatISO(new Date());

// --- inlined DynamoDB access (copy 9) ---
const table9 = process.env.TABLE_NAME ?? 'packaging-benchmark-orders';
const documents9 = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'eu-west-1', maxAttempts: 3 }),
  { marshallOptions: { removeUndefinedValues: true }, unmarshallOptions: { wrapNumbers: false } }
);
const getRecord9 = async (pk: string, sk: string) => {
  const result = await documents9.send(new GetCommand({ TableName: table9, Key: { pk, sk } }));
  return (result.Item ?? null) as Record<string, unknown> | null;
};
const putRecord9 = async (item: Record<string, unknown>) => {
  await documents9.send(new PutCommand({ TableName: table9, Item: item }));
  return item;
};
const queryPartition9 = async (pk: string) => {
  const result = await documents9.send(
    new QueryCommand({
      TableName: table9,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': pk },
      Limit: 50
    })
  );
  return (result.Items ?? []) as Record<string, unknown>[];
};

// --- inlined S3 access (copy 9) ---
const bucket9 = process.env.BUCKET_NAME ?? 'packaging-benchmark-documents';
const objects9 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1', maxAttempts: 3 });
const putDocument9 = async (key: string, body: string) => {
  await objects9.send(
    new PutObjectCommand({ Bucket: bucket9, Key: key, Body: body, ContentType: 'application/json' })
  );
  return `s3://${bucket9}/${key}`;
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

    let id = `ord_${HANDLER_INDEX}_${startedAt}`;

    let leadDays = HANDLER_INDEX % 7;
    let updatedAt = new Date().toISOString();
    leadDays = leadDays9(String(raw.placedAt ?? updatedAt), String(raw.dueDate ?? updatedAt));
    updatedAt = stamp9();

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
    const existing = await getRecord9(String(record.pk), String(record.sk));
    record.revision = (Number(existing?.revision ?? 0) || 0) + 1;
    await putRecord9(record);
    batches = chunk9(await queryPartition9(String(record.pk)), 25).length;

    await putDocument9(`orders/${tenantId}/${id}.json`, JSON.stringify(record));

    log9.info({ id, requestId, batches }, 'order processed');

    return respond9(200, {
      id,
      handler: HANDLER_NAME,
      route: ROUTE,
      batches,
      totalMinor,
      tookMs: Date.now() - startedAt
    });
  } catch (error) {
    log9.error({ err: error, requestId }, 'handler failed');
    return respond9(500, { error: 'internal_error', route: ROUTE });
  }
};
