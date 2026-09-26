import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from 'jose';

const issuer = process.env.JWT_ISSUER ?? 'https://auth.example.test/';
const audience = process.env.JWT_AUDIENCE ?? 'packaging-benchmark';
const jwksUrl = new URL(process.env.JWKS_URL ?? 'https://auth.example.test/.well-known/jwks.json');

const jwks = createRemoteJWKSet(jwksUrl, { cacheMaxAge: 10 * 60 * 1000 });

export type Claims = JWTPayload & { tenantId: string; scope?: string };

export class AuthError extends Error {
  readonly statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export const bearerToken = (header: string | undefined) => {
  if (!header) throw new AuthError('missing authorization header');
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw new AuthError('malformed authorization header');
  return token;
};

export const authenticate = async (header: string | undefined): Promise<Claims> => {
  const token = bearerToken(header);
  const { payload } = await jwtVerify(token, jwks, { issuer, audience, clockTolerance: 30 });
  const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : null;
  if (!tenantId) throw new AuthError('token carries no tenant');
  return { ...payload, tenantId };
};

export const tenantFromUnverifiedToken = (header: string | undefined) => {
  const payload = decodeJwt(bearerToken(header));
  return typeof payload.tenantId === 'string' ? payload.tenantId : 'unknown';
};

export const hasScope = (claims: Claims, required: string) =>
  (claims.scope ?? '').split(' ').includes(required);
