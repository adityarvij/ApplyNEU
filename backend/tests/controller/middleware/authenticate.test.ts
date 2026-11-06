import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { generateKeyPair, SignJWT, jwtVerify } from 'jose';
import type { Request, Response } from 'express';

const USER_ID = 'e2f1a2d0-1111-4a2a-9c3e-000000000001';
const SUPABASE_URL = 'https://project.supabase.co';

// Signing keys for the tests. The static jose import above resolves to the real
// module (static imports are linked before the mock below is registered), so the
// real jwtVerify still runs and genuinely checks signature, algorithm and expiry.
const projectKeys = await generateKeyPair('ES256');
const attackerKeys = await generateKeyPair('ES256');
const hmacSecret = new TextEncoder().encode('a-shared-secret-of-at-least-32-bytes!!');

// Native ESM: mocks must be registered with unstable_mockModule and the modules
// under test pulled in via dynamic import() afterwards so the mocks take effect.
// Only the remote key-set fetch is stubbed; verification itself is not.
// Stands in for the key set failing to download (Supabase unreachable).
let keySetError: Error | null = null;
jest.unstable_mockModule('jose', () => ({
  createRemoteJWKSet: () => projectKeys.publicKey,
  jwtVerify: (...args: Parameters<typeof jwtVerify>) =>
    keySetError ? Promise.reject(keySetError) : jwtVerify(...args),
}));

const { authenticate } = await import('../../../src/controller/middleware/authenticate.ts');

const makeReq = (authHeader?: string): Request =>
  ({
    headers: authHeader === undefined ? {} : { authorization: authHeader },
  }) as unknown as Request;

const makeRes = (): Response => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res as Response;
};

const sign = async (
  sub: string,
  key: Parameters<SignJWT['sign']>[0],
  { alg = 'ES256', expiresIn = '5m' }: { alg?: string; expiresIn?: string } = {}
) =>
  new SignJWT({ sub })
    .setProtectedHeader({ alg })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);

describe('authenticate', () => {
  beforeEach(() => {
    process.env.DEV_SUPABASE_URL = SUPABASE_URL;
    keySetError = null;
  });

  it('rejects when there is no Authorization header', async () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a header that is not a bearer token', async () => {
    const token = await sign(USER_ID, projectKeys.privateKey);
    const req = makeReq(`Basic ${token}`);
    const res = makeRes();
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a valid token and attaches req.auth from its sub', async () => {
    const token = await sign(USER_ID, projectKeys.privateKey);
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.auth).toEqual({ userId: USER_ID });
  });

  it('rejects a valid token that carries no sub', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(projectKeys.privateKey);
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token signed by a key outside the project key set', async () => {
    const token = await sign(USER_ID, attackerKeys.privateKey);
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an expired token', async () => {
    const token = await sign(USER_ID, projectKeys.privateKey, { expiresIn: '-1m' });
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a symmetrically signed token, so a leaked shared secret is not enough', async () => {
    const token = await sign(USER_ID, hmacSecret, { alg: 'HS256' });
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    const next = jest.fn();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a malformed token', async () => {
    const res = makeRes();
    const next = jest.fn();

    await authenticate(makeReq('Bearer not-a-jwt'), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['the key set fetch times out', Object.assign(new Error('request timed out'), { code: 'ERR_JWKS_TIMEOUT' })],
    ['Supabase is unreachable', new TypeError('fetch failed')],
  ])('answers 503, not 401, when %s', async (_case, error) => {
    keySetError = error;
    const token = await sign(USER_ID, projectKeys.privateKey);
    const res = makeRes();
    const next = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await authenticate(makeReq(`Bearer ${token}`), res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
});
