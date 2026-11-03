import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import { AppError } from '../../src/errors/AppError.ts';

const listAgentRuns = jest.fn<(user_id: string) => Promise<any>>();
const cancelAgent = jest.fn<(run_id: string, user_id: string) => Promise<any>>();

const authenticate = jest.fn((req: any, _res: any, next: any) => {
  req.auth = { userId: USER_ID };
  next();
});

jest.unstable_mockModule('../../src/services/agentRun/agentRun.service.ts', () => ({ listAgentRuns }));
jest.unstable_mockModule('../../src/agents/scheduler.ts', () => ({ cancelAgent }));
jest.unstable_mockModule('../../src/services/jobRun/jobRun.service.ts', () => ({ analyzeJob: jest.fn(), getJobAnalysis: jest.fn() }));
jest.unstable_mockModule('../../src/controller/middleware/authenticate.ts', () => ({
  authenticate: (req: any, res: any, next: any) => authenticate(req, res, next),
}));

const { app } = await import('../../src/app.ts');

const USER_ID = 'test-user-id';
const GROUPS = { needs_you: [], running: [{ run_id: 'run-1' }], queued: [], recent: [] };
const RUN_ID = '3f1c2b9e-8a4d-4c6e-9b2a-1d5e7f9a0c3b';

beforeEach(() => {
  listAgentRuns.mockReset().mockResolvedValue(GROUPS);
  cancelAgent.mockReset().mockResolvedValue({ run_id: RUN_ID, status: 'cancelled' });
  authenticate.mockReset().mockImplementation((req: any, _res: any, next: any) => {
    req.auth = { userId: USER_ID };
    next();
  });
});

describe('GET /me/agents', () => {
  it("returns the caller's grouped runs", async () => {
    const res = await request(app).get('/me/agents');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(GROUPS);
    expect(listAgentRuns).toHaveBeenCalledWith(USER_ID);
  });

  it('returns 401 without a valid token', async () => {
    authenticate.mockImplementation((_req: any, res: any) => res.status(401).json({ message: 'Unauthorized.' }));

    const res = await request(app).get('/me/agents');

    expect(res.status).toBe(401);
    expect(listAgentRuns).not.toHaveBeenCalled();
  });

  it('passes a service error through', async () => {
    listAgentRuns.mockRejectedValue(new AppError(500, 'Error fetching agent runs.'));

    const res = await request(app).get('/me/agents');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Error fetching agent runs.');
  });
});

describe('POST /me/agents/:run_id/cancel', () => {
  it('returns 400 for a run_id that is not a UUID', async () => {
    const res = await request(app).post('/me/agents/not-a-uuid/cancel');

    expect(res.status).toBe(400);
    expect(cancelAgent).not.toHaveBeenCalled();
  });


  it('cancels the caller\'s run', async () => {
    const res = await request(app).post(`/me/agents/${RUN_ID}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(cancelAgent).toHaveBeenCalledWith(RUN_ID, USER_ID);
  });

  it('returns 401 without a valid token', async () => {
    authenticate.mockImplementation((_req: any, res: any) => res.status(401).json({ message: 'Unauthorized.' }));

    const res = await request(app).post(`/me/agents/${RUN_ID}/cancel`);

    expect(res.status).toBe(401);
    expect(cancelAgent).not.toHaveBeenCalled();
  });
});
