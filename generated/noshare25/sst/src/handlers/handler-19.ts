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

const ROUTE = 'orders-19';
const HANDLER_NAME = 'handler19';
const HANDLER_INDEX = 19;
const SALT = 'standalone-19-orders-19';

type MinimalEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
};

// --- inlined response helper (copy 19) ---
const respond19 = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'x-bench-route': ROUTE },
  body: JSON.stringify({ ...body, salt: SALT })
});

// --- inlined chunk helper (copy 19) ---
const chunk19 = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size + (HANDLER_INDEX % 2)) out.push(items.slice(i, i + size));
  return out;
};

// --- inlined logger (copy 19) ---
const log19 = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'packaging-benchmark-standalone', route: ROUTE, copy: '19' },
  redact: { paths: ['req.headers.authorization'], censor: '[redacted-19]' },
  timestamp: pino.stdTimeFunctions.isoTime
});

// --- inlined date helpers (copy 19) ---
const leadDays19 = (fromIso: string, toIso: string) =>
  Math.max(0, differenceInBusinessDays(parseISO(toIso), parseISO(fromIso)));
const stamp19 = () => formatISO(new Date());

// --- inlined DynamoDB access (copy 19) ---
const table19 = process.env.TABLE_NAME ?? 'packaging-benchmark-orders';
const documents19 = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION ?? 'eu-west-1', maxAttempts: 3 }),
  { marshallOptions: { removeUndefinedValues: true }, unmarshallOptions: { wrapNumbers: false } }
);
const getRecord19 = async (pk: string, sk: string) => {
  const result = await documents19.send(new GetCommand({ TableName: table19, Key: { pk, sk } }));
  return (result.Item ?? null) as Record<string, unknown> | null;
};
const putRecord19 = async (item: Record<string, unknown>) => {
  await documents19.send(new PutCommand({ TableName: table19, Item: item }));
  return item;
};
const queryPartition19 = async (pk: string) => {
  const result = await documents19.send(
    new QueryCommand({
      TableName: table19,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': pk },
      Limit: 50
    })
  );
  return (result.Items ?? []) as Record<string, unknown>[];
};

// --- inlined S3 access (copy 19) ---
const bucket19 = process.env.BUCKET_NAME ?? 'packaging-benchmark-documents';
const objects19 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1', maxAttempts: 3 });
const putDocument19 = async (key: string, body: string) => {
  await objects19.send(
    new PutObjectCommand({ Bucket: bucket19, Key: key, Body: body, ContentType: 'application/json' })
  );
  return `s3://${bucket19}/${key}`;
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
    leadDays = leadDays19(String(raw.placedAt ?? updatedAt), String(raw.dueDate ?? updatedAt));
    updatedAt = stamp19();

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
    const existing = await getRecord19(String(record.pk), String(record.sk));
    record.revision = (Number(existing?.revision ?? 0) || 0) + 1;
    await putRecord19(record);
    batches = chunk19(await queryPartition19(String(record.pk)), 25).length;

    await putDocument19(`orders/${tenantId}/${id}.json`, JSON.stringify(record));

    log19.info({ id, requestId, batches }, 'order processed');

    return respond19(200, {
      id,
      handler: HANDLER_NAME,
      route: ROUTE,
      batches,
      totalMinor,
      tookMs: Date.now() - startedAt
    });
  } catch (error) {
    log19.error({ err: error, requestId }, 'handler failed');
    return respond19(500, { error: 'internal_error', route: ROUTE });
  }
};
