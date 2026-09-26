import { pino } from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'packaging-benchmark-api', stage: process.env.STAGE ?? 'dev' },
  redact: { paths: ['req.headers.authorization', 'claims.email'], censor: '[redacted]' },
  timestamp: pino.stdTimeFunctions.isoTime
});

export const handlerLogger = (handlerName: string, requestId: string | undefined) =>
  logger.child({ handler: handlerName, requestId: requestId ?? 'local' });

export const timed = async <T>(
  log: ReturnType<typeof handlerLogger>,
  label: string,
  fn: () => Promise<T>
): Promise<T> => {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    log.debug({ label, durationMs: Date.now() - start }, 'step finished');
  }
};
