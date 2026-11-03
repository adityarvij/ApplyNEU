import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { AppError } from '../../src/errors/AppError.ts';
import { normalizeAndHash } from '../../src/utils/hash.ts';

const addJob = jest.fn<(company: string, title: string, description: string) => Promise<any>>();
const getJobById = jest.fn<(job_id: string) => Promise<any>>();
const startAgent = jest.fn<(run: any) => Promise<any>>();
const getActiveJobRun = jest.fn<(user_id: string, job_id: string) => Promise<any>>();
const getAgentRun = jest.fn<(run_id: string) => Promise<any>>();
const getInstructions = jest.fn<(description_hash: string) => Promise<any>>();
const getState = jest.fn<(config: any) => Promise<any>>();
const getJob = jest.fn<(id: string) => Promise<any>>();

jest.unstable_mockModule('../../src/services/job.service.ts', () => ({ addJob, getJobById }));
jest.unstable_mockModule('../../src/agents/scheduler.ts', () => ({
  startAgent, startJobId: (run_id: string) => `start:${run_id}`,
}));
jest.unstable_mockModule('../../src/services/agentRun/agentRun.service.ts', () => ({ getActiveJobRun, getAgentRun }));
jest.unstable_mockModule('../../src/services/instructions/instructions.service.ts', () => ({ getInstructions }));
jest.unstable_mockModule('../../src/agents/jobGraph/graph.ts', () => ({ jobGraph: { getState } }));
jest.unstable_mockModule('../../src/queues/agentsQueue.ts', () => ({ getAgentsQueue: () => ({ getJob }) }));

const { analyzeJob, getJobAnalysis } = await import('../../src/services/jobRun/jobRun.service.ts');

const USER_ID = 'user-1';
const DESCRIPTION = 'Build things.';
const JOB = { job_id: 'job-1', company: 'Acme', title: 'SWE Co-op', description: DESCRIPTION };
const RUN = { run_id: 'run-1', type: 'job', user_id: USER_ID, job_id: 'job-1', thread_id: 'thread-1', status: 'queued' };
const INSTRUCTIONS = [{ kind: 'other', instruction: 'Email Acme recruiting', description: 'jobs@acme.example' }];
const VALUES = {
  user_id: USER_ID, job_id: 'job-1', match_score: 72, rationale: 'Good fit.', decision: 'APPLY', requires_approval: true,
};

const analyze = () => analyzeJob(USER_ID, DESCRIPTION, 'Acme', 'SWE Co-op');

beforeEach(() => {
  addJob.mockReset().mockResolvedValue(JOB);
  getJobById.mockReset().mockResolvedValue(JOB);
  startAgent.mockReset().mockResolvedValue(RUN);
  getActiveJobRun.mockReset().mockResolvedValue(null);
  getAgentRun.mockReset().mockResolvedValue({ ...RUN, status: 'done' });
  getInstructions.mockReset().mockResolvedValue(INSTRUCTIONS);
  getState.mockReset().mockResolvedValue({ values: VALUES, next: [] });
  getJob.mockReset().mockResolvedValue(undefined);
});

describe('analyzeJob', () => {
  it('stores the posting and queues a job run for it', async () => {
    const result = await analyze();

    expect(addJob).toHaveBeenCalledWith('Acme', 'SWE Co-op', DESCRIPTION);
    expect(startAgent).toHaveBeenCalledWith({
      user_id: USER_ID, type: 'job', title: 'SWE Co-op at Acme', job_id: 'job-1',
    });
    expect(result).toEqual({ run_id: 'run-1', status: 'queued' });
  });

  it('returns the active run when the job already has one', async () => {
    startAgent.mockRejectedValue(new AppError(409, 'This job already has an active run.'));
    getActiveJobRun.mockResolvedValue({ ...RUN, run_id: 'run-0', status: 'running' });

    const result = await analyze();

    expect(getActiveJobRun).toHaveBeenCalledWith(USER_ID, 'job-1');
    expect(result).toEqual({ run_id: 'run-0', status: 'running' });
  });

  it('rethrows the 409 when the active run finished before it could be loaded', async () => {
    startAgent.mockRejectedValue(new AppError(409, 'This job already has an active run.'));

    await expect(analyze()).rejects.toMatchObject({ status: 409 });
  });

  it('does not look for an active run on other errors', async () => {
    startAgent.mockRejectedValue(new AppError(500, 'Error creating agent run.'));

    await expect(analyze()).rejects.toMatchObject({ status: 500 });
    expect(getActiveJobRun).not.toHaveBeenCalled();
  });
});

describe('getJobAnalysis', () => {
  it.each(['done', 'waiting_for_you'])("answers a %s run from the thread's state with the posting's instructions", async (status) => {
    getAgentRun.mockResolvedValue({ ...RUN, status });

    const result = await getJobAnalysis('run-1', USER_ID);

    expect(getState).toHaveBeenCalledWith({ configurable: { thread_id: 'thread-1' } });
    expect(getInstructions).toHaveBeenCalledWith(normalizeAndHash(DESCRIPTION));
    expect(result).toEqual({
      run_id: 'run-1',
      status,
      decision: 'APPLY',
      match_score: 72,
      rationale: 'Good fit.',
      requires_approval: true,
      employer_instructions: INSTRUCTIONS,
    });
  });

  it('returns no instructions when the memo has none', async () => {
    getInstructions.mockResolvedValue(null);

    const result = await getJobAnalysis('run-1', USER_ID);

    expect(result).toMatchObject({ employer_instructions: [] });
  });

  it('reports a running run with no rate limit wait', async () => {
    getAgentRun.mockResolvedValue({ ...RUN, status: 'running' });

    const result = await getJobAnalysis('run-1', USER_ID);

    expect(getJob).toHaveBeenCalledWith('start:run-1');
    expect(result).toEqual({ run_id: 'run-1', status: 'running', retry_after: null });
    expect(getState).not.toHaveBeenCalled();
  });

  it('reports how long a rate-limited run waits', async () => {
    getAgentRun.mockResolvedValue({ ...RUN, status: 'running' });
    getJob.mockResolvedValue({ data: { run_id: 'run-1', retry_at: Date.now() + 30_000 } });

    const result = await getJobAnalysis('run-1', USER_ID);

    expect(result).toMatchObject({ status: 'running', retry_after: 30 });
  });

  it('ignores a rate limit wait that has passed', async () => {
    getAgentRun.mockResolvedValue({ ...RUN, status: 'running' });
    getJob.mockResolvedValue({ data: { run_id: 'run-1', retry_at: Date.now() - 1000 } });

    const result = await getJobAnalysis('run-1', USER_ID);

    expect(result).toMatchObject({ retry_after: null });
  });

  it.each(['queued', 'failed', 'cancelled'])('reports a %s run without reading the thread', async (status) => {
    getAgentRun.mockResolvedValue({ ...RUN, status });

    const result = await getJobAnalysis('run-1', USER_ID);

    expect(result).toEqual({ run_id: 'run-1', status });
    expect(getState).not.toHaveBeenCalled();
  });

  it("returns 404 for another user's run", async () => {
    await expect(getJobAnalysis('run-1', 'user-2')).rejects.toMatchObject({ status: 404 });
  });

  it('returns 404 for a run that is not a job run', async () => {
    getAgentRun.mockResolvedValue({ ...RUN, type: 'sweep' });

    await expect(getJobAnalysis('run-1', USER_ID)).rejects.toMatchObject({ status: 404 });
  });
});
