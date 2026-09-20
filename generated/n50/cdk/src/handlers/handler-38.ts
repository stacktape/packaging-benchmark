import { authenticate, AuthError, hasScope } from '../lib/auth';
import { bumpCounter, getRecord, putDocument, putRecord, queryPartition } from '../lib/aws-clients';
import { handlerLogger, timed } from '../lib/logger';
import { orderTotalMinor, parseOrder } from '../lib/schema';
import { chunk, isOverdue, jsonResponse, leadTimeInBusinessDays, newId, newRequestId, promiseDate, stamp } from '../lib/util';

const ROUTE = 'orders-38';
const HANDLER_NAME = 'handler38';

type MinimalEvent = {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
};

export const handler = async (event: MinimalEvent) => {
  const requestId = event.requestContext?.requestId ?? newRequestId();
  const log = handlerLogger(HANDLER_NAME, requestId);
  const startedAt = Date.now();

  try {
    const claims = await authenticate(event.headers?.authorization ?? event.headers?.Authorization);
    if (!hasScope(claims, 'orders:write')) {
      return jsonResponse(403, { error: 'insufficient_scope', route: ROUTE });
    }

    const parsed = parseOrder(JSON.parse(event.body ?? '{}'));
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues.length }, 'order rejected');
      return jsonResponse(400, { error: 'invalid_order', issues: parsed.error.issues.slice(0, 3) });
    }

    const order = parsed.data;
    const partition = `tenant#${claims.tenantId}`;
    const sortKey = `order#${order.orderId}#38`;

    const existing = await timed(log, 'get', () => getRecord(partition, sortKey));
    const record = {
      pk: partition,
      sk: sortKey,
      id: newId('ord'),
      route: ROUTE,
      channel: order.channel,
      customerId: order.customerId,
      totalMinor: orderTotalMinor(order),
      currency: order.lines[0].unitPrice.currency,
      lineCount: order.lines.length,
      leadDays: leadTimeInBusinessDays(order.placedAt, order.dueDate),
      promisedAt: promiseDate(order.placedAt, 3 + (38 % 5)),
      overdue: isOverdue(order.dueDate),
      revision: (Number(existing?.revision ?? 0) || 0) + 1,
      updatedAt: stamp()
    };

    await timed(log, 'put', () => putRecord(record));
    await timed(log, 'counter', () => bumpCounter(partition, 'stats#orders', 'processed'));

    const history = await timed(log, 'query', () => queryPartition(partition, 50));
    const batches = chunk(history, 25);

    await timed(log, 's3', () =>
      putDocument(`orders/${claims.tenantId}/${record.id}.json`, JSON.stringify({ record, batches: batches.length }))
    );

    log.info({ id: record.id, revision: record.revision, batches: batches.length }, 'order processed');

    return jsonResponse(200, {
      id: record.id,
      handler: HANDLER_NAME,
      route: ROUTE,
      revision: record.revision,
      totalMinor: record.totalMinor,
      batches: batches.length,
      tookMs: Date.now() - startedAt
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonResponse(error.statusCode, { error: error.message, route: ROUTE });
    }
    log.error({ err: error }, 'handler failed');
    return jsonResponse(500, { error: 'internal_error', route: ROUTE });
  }
};
