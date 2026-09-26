import { addBusinessDays, differenceInBusinessDays, formatISO, isAfter, parseISO } from 'date-fns';
import { customAlphabet, nanoid } from 'nanoid';

const shortAlphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const shortId = customAlphabet(shortAlphabet, 12);

export const newId = (prefix: string) => `${prefix}_${shortId()}`;
export const newRequestId = () => nanoid(21);

export const stamp = (date: Date = new Date()) => formatISO(date);

export const leadTimeInBusinessDays = (fromIso: string, toIso: string) => {
  const from = parseISO(fromIso);
  const to = parseISO(toIso);
  return Math.max(0, differenceInBusinessDays(to, from));
};

export const promiseDate = (fromIso: string, businessDays: number) =>
  formatISO(addBusinessDays(parseISO(fromIso), businessDays));

export const isOverdue = (dueIso: string, now: Date = new Date()) => isAfter(now, parseISO(dueIso));

export const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export const jsonResponse = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});
