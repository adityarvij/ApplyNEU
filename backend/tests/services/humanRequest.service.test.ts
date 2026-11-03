import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { AppError } from '../../src/errors/AppError.ts';

const query = jest.fn<(text: string, params?: any[]) => Promise<any>>();
const moveAgentRun = jest.fn<(run_id: string, from: string[], to: string) => Promise<any>>();
const enqueueWokenRuns = jest.fn<(runs: any[]) => Promise<void>>();
const resumeJobThread = jest.fn<(thread_id: string, step: string, value: unknown) => Promise<void>>();

jest.unstable_mockModule('../../src/db/index.ts', () => ({ pool: { query } }));
jest.unstable_mockModule('../../src/services/agentRun/agentRun.service.ts', () => ({ moveAgentRun }));
jest.unstable_mockModule('../../src/agents/scheduler.ts', () => ({ enqueueWokenRuns, resumeJobThread }));

const { createHumanRequest, listHumanRequests, resolveHumanRequest, expireHumanRequests } =
  await import('../../src/services/humanRequest/humanRequest.service.ts');

const USER_ID = 'user-1';
const REQUEST_ID = 'request-1';
const NEXT = [{ run_id: 'run-2', thread_id: 'thread-2', resume: null }];

const request = (overrides: Record<string, unknown> = {}) => ({
  request_id: REQUEST_ID,
  run_id: 'run-1',
  job_id: 'job-1',
  kind: 'apply_approval',
  status: 'pending',
  payload: { title: 'SWE', company: 'Acme' },
  answer: null,
  created_at: '2026-11-02T00:00:00Z',
  resolved_at: null,
  expires_at: null,
  ...overrides,
});

const callWith = (fragment: string) => query.mock.calls.find(([sql]) => sql.includes(fragment));

beforeEach(() => {
  query.mockReset();
  moveAgentRun.mockReset().mockResolvedValue({ moved: true, woken: NEXT });
  enqueueWokenRuns.mockReset().mockResolvedValue();
  resumeJobThread.mockReset().mockResolvedValue();
});

describe('createHumanRequest', () => {
  it("records the request under the run's user and job and moves the run to waiting_for_you", async () => {
    query.mockResolvedValue({ rows: [request()] });

    const created = await createHumanRequest({ run_id: 'run-1', kind: 'apply_approval', payload: { title: 'SWE' } });

    expect(created.request_id).toBe(REQUEST_ID);
    const [sql, params] = callWith('INSERT INTO human_requests')!;
    expect(sql).toContain('FROM agent_runs');
    expect(params).toEqual(['run-1', 'apply_approval', JSON.stringify({ title: 'SWE' }), null]);
    expect(moveAgentRun).toHaveBeenCalledWith('run-1', ['running'], 'waiting_for_you');
    expect(enqueueWokenRuns).toHaveBeenCalledWith(NEXT);
  });

  it('returns 404 when the run does not exist', async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(createHumanRequest({ run_id: 'missing', kind: 'question' })).rejects.toMatchObject({ status: 404 });
    expect(moveAgentRun).not.toHaveBeenCalled();
  });

  it('returns 409 when the run is already waiting on the user', async () => {
    query.mockRejectedValue(Object.assign(new Error('duplicate'), { constraint: 'human_requests_one_pending_per_run' }));

    await expect(createHumanRequest({ run_id: 'run-1', kind: 'question' })).rejects.toMatchObject({ status: 409 });
    expect(moveAgentRun).not.toHaveBeenCalled();
  });
});

describe('listHumanRequests', () => {
  it("returns the caller's requests with the status filter", async () => {
    query.mockResolvedValue({ rows: [request()] });

    const rows = await listHumanRequests(USER_ID, 'pending');

    expect(rows).toHaveLength(1);
    expect(query.mock.calls[0]![1]).toEqual([USER_ID, 'pending', 100]);
  });

  it('passes no status when unfiltered and never selects user_id', async () => {
    query.mockResolvedValue({ rows: [] });

    await listHumanRequests(USER_ID);

    const [sql, params] = query.mock.calls[0]!;
    expect(params).toEqual([USER_ID, null, 100]);
    expect(sql.split('FROM')[0]).not.toContain('user_id');
  });

  it('wraps a database error as a 500', async () => {
    query.mockRejectedValue(new Error('connection refused'));

    await expect(listHumanRequests(USER_ID)).rejects.toEqual(new AppError(500, 'Error fetching requests.'));
  });
});

describe('resolveHumanRequest', () => {
  it("records the answer, scoped to the owner and pending requests, and resumes the run's thread", async () => {
    query.mockResolvedValue({ rows: [{ ...request({ status: 'resolved', answer: { approved: true } }), thread_id: 'thread-1' }] });

    const resolved = await resolveHumanRequest(REQUEST_ID, USER_ID, { approved: true });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("hr.status = 'pending'");
    expect(sql).toContain('hr.user_id = $2');
    expect(params).toEqual([REQUEST_ID, USER_ID, JSON.stringify({ approved: true })]);
    expect(resumeJobThread).toHaveBeenCalledWith('thread-1', `apply_approval:${REQUEST_ID}`, { approved: true });
    expect(resolved).not.toHaveProperty('thread_id');
    expect(resolved.status).toBe('resolved');
  });

  it('moves a run without a thread straight back to running', async () => {
    query.mockResolvedValue({ rows: [{ ...request({ kind: 'handoff', status: 'resolved' }), thread_id: null }] });

    await resolveHumanRequest(REQUEST_ID, USER_ID, { done: true });

    expect(resumeJobThread).not.toHaveBeenCalled();
    expect(moveAgentRun).toHaveBeenCalledWith('run-1', ['waiting_for_you'], 'running');
    expect(enqueueWokenRuns).toHaveBeenCalledWith(NEXT);
  });

  it("returns 404 for a request that doesn't exist or belongs to someone else", async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(resolveHumanRequest(REQUEST_ID, USER_ID, true)).rejects.toMatchObject({ status: 404 });
    expect(resumeJobThread).not.toHaveBeenCalled();
  });

  it('returns 409 for a request that is no longer pending', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ status: 'resolved' }] });

    await expect(resolveHumanRequest(REQUEST_ID, USER_ID, true)).rejects.toMatchObject({ status: 409 });
    expect(resumeJobThread).not.toHaveBeenCalled();
  });

  it('puts the request back to pending when the resume fails', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...request({ status: 'resolved' }), thread_id: 'thread-1' }] })
      .mockResolvedValue({ rows: [] });
    resumeJobThread.mockRejectedValue(new Error('redis down'));

    await expect(resolveHumanRequest(REQUEST_ID, USER_ID, true)).rejects.toEqual(new AppError(500, 'Error resuming the agent.'));
    const [sql, params] = callWith("SET status = 'pending'")!;
    expect(sql).toContain("status = 'resolved'");
    expect(params).toEqual([REQUEST_ID]);
  });
});

describe('expireHumanRequests', () => {
  it('expires overdue pending requests and cancels their runs', async () => {
    query.mockResolvedValue({ rows: [{ request_id: 'r1', run_id: 'run-1' }, { request_id: 'r2', run_id: 'run-3' }] });

    const expired = await expireHumanRequests();

    expect(expired).toHaveLength(2);
    expect(query.mock.calls[0]![0]).toContain('expires_at <= now()');
    expect(moveAgentRun).toHaveBeenCalledWith('run-1', ['waiting_for_you'], 'cancelled');
    expect(moveAgentRun).toHaveBeenCalledWith('run-3', ['waiting_for_you'], 'cancelled');
    expect(enqueueWokenRuns).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no request is overdue', async () => {
    query.mockResolvedValue({ rows: [] });

    expect(await expireHumanRequests()).toEqual([]);
    expect(moveAgentRun).not.toHaveBeenCalled();
  });
});
