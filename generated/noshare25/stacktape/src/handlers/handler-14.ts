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

const ROUTE = 'orders-14';
const HANDLER_NAME = 'handler14';
const HANDLER_INDEX = 14;
const SALT = 'standalone-14-orders-14';

type MinimalEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
};

// --- inlined response helper (copy 14) ---
const respond14 = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'x-bench-route': ROUTE },
  body: JSON.stringify({ ...body, salt: SALT })
});

// --- inlined chunk helper (copy 14) ---
const chunk14 = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size + (HANDLER_INDEX % 2)) out.push(items.slice(i, i + size));
  return out;
};

// --- inlined logger (copy 14) ---
const log14 = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'packaging-benchmark-standalone', route: ROUTE, copy: '14' },
  redact: { paths: ['req.headers.authorization'], censor: '[redacted-14]' },
  timestamp: pino.stdTimeFunctions.isoTime
});

// --- inlined date helpers (copy 14) ---
const leadDays14 = (fromIso: string, toIso: string) =>
  Math.max(0, differenceInBusinessDays(parseISO(toIso), parseISO(fromIso)));
const stamp14 = () => formatISO(new Date());

// --- inlined DynamoDB access (copy 14) ---
const table14 = process.env.TABLE_NAME ?? 'packaging-benchmark-orders';
const documents14 = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'eu-west-1', maxAttempts: 3 }),
  { marshallOptions: { removeUndefinedValues: true }, unmarshallOptions: { wrapNumbers: false } }
);
const getRecord14 = async (pk: string, sk: string) => {
  const result = await documents14.send(new GetCommand({ TableName: table14, Key: { pk, sk } }));
  return (result.Item ?? null) as Record<string, unknown> | null;
};
const putRecord14 = async (item: Record<string, unknown>) => {
  await documents14.send(new PutCommand({ TableName: table14, Item: item }));
  return item;
};
const queryPartition14 = async (pk: string) => {
  const result = await documents14.send(
    new QueryCommand({
      TableName: table14,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': pk },
      Limit: 50
    })
  );
  return (result.Items ?? []) as Record<string, unknown>[];
};

// --- inlined S3 access (copy 14) ---
const bucket14 = process.env.BUCKET_NAME ?? 'packaging-benchmark-documents';
const objects14 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1', maxAttempts: 3 });
const putDocument14 = async (key: string, body: string) => {
  await objects14.send(
    new PutObjectCommand({ Bucket: bucket14, Key: key, Body: body, ContentType: 'application/json' })
  );
  return `s3://${bucket14}/${key}`;
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
    leadDays = leadDays14(String(raw.placedAt ?? updatedAt), String(raw.dueDate ?? updatedAt));
    updatedAt = stamp14();

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
    const existing = await getRecord14(String(record.pk), String(record.sk));
    record.revision = (Number(existing?.revision ?? 0) || 0) + 1;
    await putRecord14(record);
    batches = chunk14(await queryPartition14(String(record.pk)), 25).length;

    await putDocument14(`orders/${tenantId}/${id}.json`, JSON.stringify(record));

    log14.info({ id, requestId, batches }, 'order processed');

    return respond14(200, {
      id,
      handler: HANDLER_NAME,
      route: ROUTE,
      batches,
      totalMinor,
      tookMs: Date.now() - startedAt
    });
  } catch (error) {
    log14.error({ err: error, requestId }, 'handler failed');
    return respond14(500, { error: 'internal_error', route: ROUTE });
  }
};
