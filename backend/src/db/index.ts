import { Pool } from 'pg';

export const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  ssl: { rejectUnauthorized: false },
  // Lets the OS notice a dead idle connection (a dropped pooler link, a laptop that slept)
  // so the pool discards it instead of handing it to the next query.
  keepAlive: true,
});

pool.on('connect', () => {
  console.log('connected to postgres');
});

pool.on('error', (err: Error) => {
  // An idle client lost its connection and the pool has already discarded it. Without a
  // listener, this event would be thrown and stop the process.
  console.error('postgres idle client error:', err.message);
});

const CONNECTION_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', '57P01']);

/** True when the query failed because its connection was gone, not because of the query. */
export const isConnectionError = (error: unknown) => {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  return (!!code && CONNECTION_ERROR_CODES.has(code)) || !!message?.includes('Connection terminated');
};

// A connection that died while idle fails the first query given to it. Retry that query once
// on a fresh connection. Only pool.query retries: a client from pool.connect() may be
// mid-transaction, and rerunning part of a transaction is not safe.
const query = pool.query.bind(pool);
pool.query = (async (...args: Parameters<typeof query>) => {
  try {
    return await query(...args);
  } catch (error) {
    if (!isConnectionError(error)) throw error;
    console.error('postgres query lost its connection, retrying once:', (error as Error).message);
    return query(...args);
  }
}) as typeof pool.query;
