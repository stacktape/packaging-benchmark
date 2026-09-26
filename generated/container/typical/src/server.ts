// Container entry point: the same application as a long-running HTTP service.
//
// It imports the same `lib/` directory and the same handlers as the Lambda shapes, and dispatches
// requests to them, so the container comparison packages the same code as the 10-function Lambda shape.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { logger } from './lib/logger';
import { TABLE_NAME, BUCKET_NAME } from './lib/aws-clients';
import { newRequestId } from './lib/util';
import { routes } from './routes';

const port = Number(process.env.PORT ?? 3000);

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const requestId = newRequestId();
  const path = (req.url ?? '/').split('?')[0];

  if (path === '/health' || path === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, routes: Object.keys(routes), table: TABLE_NAME, bucket: BUCKET_NAME }));
    return;
  }

  const route = routes[path.replace(/^\//, '')];
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path }));
    return;
  }

  try {
    const body = await readBody(req);
    const result = await route({
      body,
      headers: req.headers as Record<string, string | undefined>,
      requestContext: { requestId }
    });
    res.writeHead(result.statusCode, result.headers ?? { 'content-type': 'application/json' });
    res.end(result.body);
  } catch (error) {
    logger.error({ err: error, requestId }, 'request failed');
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal_error' }));
  }
});

server.listen(port, () => logger.info({ port }, 'packaging benchmark service listening'));

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
