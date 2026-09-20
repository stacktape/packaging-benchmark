import { z } from 'zod';

export const moneySchema = z.object({
  currency: z.enum(['EUR', 'USD', 'GBP']),
  amountMinor: z.number().int().nonnegative()
});

export const addressSchema = z.object({
  line1: z.string().min(1).max(120),
  line2: z.string().max(120).optional(),
  city: z.string().min(1).max(80),
  postalCode: z.string().min(2).max(16),
  country: z.string().length(2)
});

export const orderLineSchema = z.object({
  sku: z.string().regex(/^[A-Z0-9-]{3,32}$/),
  quantity: z.number().int().positive().max(999),
  unitPrice: moneySchema,
  note: z.string().max(280).optional()
});

export const orderRequestSchema = z.object({
  orderId: z.string().min(6).max(64),
  customerId: z.string().min(3).max(64),
  placedAt: z.iso.datetime(),
  dueDate: z.iso.datetime(),
  channel: z.enum(['web', 'mobile', 'partner', 'internal']),
  shipping: addressSchema,
  billing: addressSchema.optional(),
  lines: z.array(orderLineSchema).min(1).max(100),
  metadata: z.record(z.string(), z.string()).optional()
});

export const orderPatchSchema = orderRequestSchema.partial().extend({
  orderId: z.string().min(6).max(64)
});

export type OrderRequest = z.infer<typeof orderRequestSchema>;
export type OrderLine = z.infer<typeof orderLineSchema>;

export const parseOrder = (raw: unknown) => orderRequestSchema.safeParse(raw);

export const orderTotalMinor = (order: OrderRequest) =>
  order.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice.amountMinor, 0);
