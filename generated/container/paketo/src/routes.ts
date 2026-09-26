// Generated: maps a URL path to the same handler the Lambda shapes package.
import { handler as handler01 } from './handlers/handler-01';
import { handler as handler02 } from './handlers/handler-02';
import { handler as handler03 } from './handlers/handler-03';
import { handler as handler04 } from './handlers/handler-04';
import { handler as handler05 } from './handlers/handler-05';
import { handler as handler06 } from './handlers/handler-06';
import { handler as handler07 } from './handlers/handler-07';
import { handler as handler08 } from './handlers/handler-08';
import { handler as handler09 } from './handlers/handler-09';
import { handler as handler10 } from './handlers/handler-10';

type RouteHandler = (event: {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
}) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>;

export const routes: Record<string, RouteHandler> = {
  'orders-01': handler01,
  'orders-02': handler02,
  'orders-03': handler03,
  'orders-04': handler04,
  'orders-05': handler05,
  'orders-06': handler06,
  'orders-07': handler07,
  'orders-08': handler08,
  'orders-09': handler09,
  'orders-10': handler10,
};
