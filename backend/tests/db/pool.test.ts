import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { EventEmitter } from 'node:events';

const rawQuery = jest.fn<(...args: unknown[]) => Promise<unknown>>();
let poolOptions: Record<string, unknown> = {};

jest.unstable_mockModule('pg', () => ({
    Pool: class extends EventEmitter {
        constructor(options: Record<string, unknown>) {
            super();
            poolOptions = options;
        }
        query(...args: unknown[]) {
            return rawQuery(...args);
        }
    },
}));

const { pool, isConnectionError } = await import('../../src/db/index.ts');

const terminated = () => new Error('Connection terminated unexpectedly');

describe('db pool', () => {
    beforeEach(() => {
        rawQuery.mockReset();
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('keeps the process up when an idle client errors', () => {
        expect(() => pool.emit('error', terminated())).not.toThrow();
        expect(console.error).toHaveBeenCalledWith('postgres idle client error:', 'Connection terminated unexpectedly');
    });

    it('turns on TCP keepalive', () => {
        expect(poolOptions.keepAlive).toBe(true);
    });

    it('retries a query once on a fresh connection when its connection was gone', async () => {
        rawQuery.mockRejectedValueOnce(terminated()).mockResolvedValueOnce({ rows: [{ id: 1 }] });

        await expect(pool.query('SELECT $1', [1])).resolves.toEqual({ rows: [{ id: 1 }] });
        expect(rawQuery).toHaveBeenCalledTimes(2);
        expect(rawQuery).toHaveBeenLastCalledWith('SELECT $1', [1]);
    });

    it('gives up after the one retry', async () => {
        rawQuery.mockRejectedValue(terminated());

        await expect(pool.query('SELECT 1')).rejects.toThrow('Connection terminated unexpectedly');
        expect(rawQuery).toHaveBeenCalledTimes(2);
    });

    it("doesn't retry an error from the query itself", async () => {
        rawQuery.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

        await expect(pool.query('INSERT 1')).rejects.toMatchObject({ code: '23505' });
        expect(rawQuery).toHaveBeenCalledTimes(1);
    });

    it('recognizes dropped connections by code or message', () => {
        expect(isConnectionError(Object.assign(new Error('read'), { code: 'ECONNRESET' }))).toBe(true);
        expect(isConnectionError(Object.assign(new Error('terminating'), { code: '57P01' }))).toBe(true);
        expect(isConnectionError(terminated())).toBe(true);
        expect(isConnectionError(new Error('syntax error'))).toBe(false);
        expect(isConnectionError(undefined)).toBe(false);
    });
});
