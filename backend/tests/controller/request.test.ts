import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import { AppError } from '../../src/errors/AppError.ts';

const listHumanRequests = jest.fn<(user_id: string, status?: string) => Promise<any>>();
const resolveHumanRequest = jest.fn<(request_id: string, user_id: string, answer: unknown) => Promise<any>>();

const authenticate = jest.fn((req: any, _res: any, next: any) => {
  req.auth = { userId: USER_ID };
  next();
});

jest.unstable_mockModule('../../src/services/humanRequest/humanRequest.service.ts', () => ({
  listHumanRequests, resolveHumanRequest,
}));
jest.unstable_mockModule('../../src/controller/middleware/authenticate.ts', () => ({
  authenticate: (req: any, res: any, next: any) => authenticate(req, res, next),
}));

const { app } = await import('../../src/app.ts');

const USER_ID = 'test-user-id';
const REQUEST_ID = '3f1c2b9e-8a4d-4c6e-9b2a-1d5e7f9a0c3b';
const PENDING = [{ request_id: REQUEST_ID, kind: 'apply_approval', status: 'pending' }];

beforeEach(() => {
  listHumanRequests.mockReset().mockResolvedValue(PENDING);
  resolveHumanRequest.mockReset().mockResolvedValue({ request_id: REQUEST_ID, status: 'resolved' });
  authenticate.mockReset().mockImplementation((req: any, _res: any, next: any) => {
    req.auth = { userId: USER_ID };
    next();
  });
});

describe('GET /me/requests', () => {
  it("returns the caller's requests filtered by status", async () => {
    const res = await request(app).get('/me/requests?status=pending');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(PENDING);
    expect(listHumanRequests).toHaveBeenCalledWith(USER_ID, 'pending');
  });

  it('lists every status without a filter', async () => {
    const res = await request(app).get('/me/requests');

    expect(res.status).toBe(200);
    expect(listHumanRequests).toHaveBeenCalledWith(USER_ID, undefined);
  });

  it('returns 400 for an unknown status', async () => {
    const res = await request(app).get('/me/requests?status=open');

    expect(res.status).toBe(400);
    expect(listHumanRequests).not.toHaveBeenCalled();
  });

  it('returns 401 without a valid token', async () => {
    authenticate.mockImplementation((_req: any, res: any) => res.status(401).json({ message: 'Unauthorized.' }));

    const res = await request(app).get('/me/requests');

    expect(res.status).toBe(401);
    expect(listHumanRequests).not.toHaveBeenCalled();
  });
});

describe('POST /me/requests/:request_id/resolve', () => {
  it("resolves the caller's request with the answer", async () => {
    const res = await request(app).post(`/me/requests/${REQUEST_ID}/resolve`).send({ answer: { approved: true } });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
    expect(resolveHumanRequest).toHaveBeenCalledWith(REQUEST_ID, USER_ID, { approved: true });
  });

  it('accepts a falsy answer', async () => {
    const res = await request(app).post(`/me/requests/${REQUEST_ID}/resolve`).send({ answer: false });

    expect(res.status).toBe(200);
    expect(resolveHumanRequest).toHaveBeenCalledWith(REQUEST_ID, USER_ID, false);
  });

  it('returns 400 for a request_id that is not a UUID', async () => {
    const res = await request(app).post('/me/requests/not-a-uuid/resolve').send({ answer: true });

    expect(res.status).toBe(400);
    expect(resolveHumanRequest).not.toHaveBeenCalled();
  });

  it('returns 400 without an answer', async () => {
    const res = await request(app).post(`/me/requests/${REQUEST_ID}/resolve`).send({});

    expect(res.status).toBe(400);
    expect(resolveHumanRequest).not.toHaveBeenCalled();
  });

  it('passes a 409 from the service through', async () => {
    resolveHumanRequest.mockRejectedValue(new AppError(409, 'This request is no longer waiting for an answer.'));

    const res = await request(app).post(`/me/requests/${REQUEST_ID}/resolve`).send({ answer: true });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('This request is no longer waiting for an answer.');
  });
});
