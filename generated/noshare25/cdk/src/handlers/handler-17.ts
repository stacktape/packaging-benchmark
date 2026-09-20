// Control-shape handler for S3 ("shares nothing").
//
// Every helper this file needs is inlined here, and each inlined copy carries the handler index in a
// string literal or a numeric constant, so no two handlers in the shape contain byte-identical code.
// A bundler therefore cannot deduplicate anything across handlers, which is the point of the control.
//
// The generator keeps only the /*#IF:feature*/ blocks that belong to this handler's dependency subset,
// so different handlers in the same shape pull in different npm packages.

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { pino } from 'pino';
import { customAlphabet } from 'nanoid';

const ROUTE = 'orders-17';
const HANDLER_NAME = 'handler17';
const HANDLER_INDEX = 17;
const SALT = 'standalone-17-orders-17';

type MinimalEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
};

// --- inlined response helper (copy 17) ---
const respond17 = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'x-bench-route': ROUTE },
  body: JSON.stringify({ ...body, salt: SALT })
});

// --- inlined chunk helper (copy 17) ---
const chunk17 = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size + (HANDLER_INDEX % 2)) out.push(items.slice(i, i + size));
  return out;
};

// --- inlined logger (copy 17) ---
const log17 = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'packaging-benchmark-standalone', route: ROUTE, copy: '17' },
  redact: { paths: ['req.headers.authorization'], censor: '[redacted-17]' },
  timestamp: pino.stdTimeFunctions.isoTime
});

// --- inlined id generator (copy 17) ---
const shortId17 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12 + (HANDLER_INDEX % 3));

// --- inlined S3 access (copy 17) ---
const bucket17 = process.env.BUCKET_NAME ?? 'packaging-benchmark-documents';
const objects17 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1', maxAttempts: 3 });
const putDocument17 = async (key: string, body: string) => {
  await objects17.send(
    new PutObjectCommand({ Bucket: bucket17, Key: key, Body: body, ContentType: 'application/json' })
  );
  return `s3://${bucket17}/${key}`;
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
    id = `ord_${shortId17()}`;

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

    await putDocument17(`orders/${tenantId}/${id}.json`, JSON.stringify(record));

    log17.info({ id, requestId, batches }, 'order processed');

    return respond17(200, {
      id,
      handler: HANDLER_NAME,
      route: ROUTE,
      batches,
      totalMinor,
      tookMs: Date.now() - startedAt
    });
  } catch (error) {
    log17.error({ err: error, requestId }, 'handler failed');
    return respond17(500, { error: 'internal_error', route: ROUTE });
  }
};
