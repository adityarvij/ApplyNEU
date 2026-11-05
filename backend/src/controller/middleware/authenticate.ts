import type { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// createRemoteJWKSet caches the fetched key set (and re-fetches on unknown kid), so
// one instance per process is enough. Built on first use rather than at import time so
// the environment doesn't have to be loaded before this module is pulled in.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

const getJwks = () => {
  if (jwks) return jwks;
  const supabaseUrl = process.env.NODE_ENV === 'production'
    ? process.env.PROD_SUPABASE_URL
    : process.env.DEV_SUPABASE_URL;
  if (!supabaseUrl) return null;
  jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));
  return jwks;
};

// jose error codes that mean the token itself is bad. Anything else (the key set timing
// out or failing to download) means we couldn't check the token, not that it's invalid.
const INVALID_TOKEN_CODES = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  const keys = getJwks();
  if (!keys) {
    res.status(500).json({ message: 'Server misconfigured.' });
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
  if (!token) {
    res.status(401).json({ message: 'Unauthorized.' });
    return;
  }

  try {
    const { payload } = await jwtVerify(token, keys, { algorithms: ['ES256'] });
    const callerId = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (!callerId) {
      res.status(401).json({ message: 'Unauthorized.' });
      return;
    }
    req.auth = { userId: callerId };
    next();
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code && INVALID_TOKEN_CODES.has(code)) {
      console.log('[authenticate] jwt verification failed:', err instanceof Error ? err.message : err);
      res.status(401).json({ message: 'Unauthorized.' });
      return;
    }
    // A 401 would sign the user out over a network hiccup.
    console.error('[authenticate] could not verify token:', err instanceof Error ? err.message : err);
    res.status(503).json({ message: 'Could not verify your session. Please try again.' });
  }
};
