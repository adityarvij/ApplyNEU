import { jest, describe, it, expect, beforeEach } from '@jest/globals';

class DelayedError extends Error {}
class UnrecoverableError extends Error {}
class Command {
    constructor(public args: { resume: unknown }) {}
}

let processor: (job: any, token?: string) => Promise<unknown>;
const handlers: Record<string, (...args: any[]) => Promise<void>> = {};

const runJobThread = jest.fn<(thread_id: string, input: any) => Promise<unknown>>();
const invoke = jest.fn<(input: unknown, config: any) => Promise<unknown>>();
const getState = jest.fn<(config: any) => Promise<any>>();
const getAgentRun = jest.fn<(run_id: string) => Promise<any>>();
const getAgentRunByThread = jest.fn<(thread_id: string) => Promise<any>>();
const moveAgentRun = jest.fn<(run_id: string, from: string[], to: string) => Promise<any>>();
const enqueueWokenRuns = jest.fn<(runs: any[]) => Promise<void>>();
const wakeStalledAgents = jest.fn<() => Promise<void>>();
const scheduleWakeStalledAgents = jest.fn<() => Promise<unknown>>().mockResolvedValue({});

jest.unstable_mockModule('bullmq', () => ({
    DelayedError,
    UnrecoverableError,
    Worker: class {
        constructor(_name: string, fn: typeof processor) {
            processor = fn;
        }
        on(event: string, handler: (...args: any[]) => Promise<void>) {
            handlers[event] = handler;
        }
    },
}));
jest.unstable_mockModule('@langchain/langgraph', () => ({ Command }));
jest.unstable_mockModule('../../src/agents/jobGraph/graph.ts', () => ({ jobGraph: { invoke, getState }, runJobThread }));
jest.unstable_mockModule('../../src/agents/scheduler.ts', () => ({ enqueueWokenRuns, scheduleWakeStalledAgents, wakeStalledAgents }));
jest.unstable_mockModule('../../src/queues/agentsQueue.ts', () => ({ AGENTS_QUEUE: 'agents' }));
jest.unstable_mockModule('../../src/queues/connection.ts', () => ({ bullConnection: {} }));
jest.unstable_mockModule('../../src/db/index.ts', () => ({ pool: { end: jest.fn() } }));
jest.unstable_mockModule('../../src/services/agentRun/agentRun.service.ts', () => ({
    getAgentRun, getAgentRunByThread, moveAgentRun,
}));
jest.unstable_mockModule('../../src/utils/shutdown.ts', () => ({ onShutdownSignal: jest.fn(), runShutdown: jest.fn() }));

await import('../../src/workers/agentsWorker.ts');
const { AppError } = await import('../../src/errors/AppError.ts');

const RUN = { run_id: 'run-1', type: 'job', user_id: 'user-1', job_id: 'job-1', thread_id: 'thread-1', status: 'running' };
const NEXT = [{ run_id: 'run-2', thread_id: 'thread-2', resume: null }];
const moveToDelayed = jest.fn<(ts: number, token?: string) => Promise<void>>();
const updateData = jest.fn<(data: unknown) => Promise<void>>();
const startJob = () => ({ name: 'start', id: 'start:run-1', data: { run_id: 'run-1' }, moveToDelayed, updateData, attemptsMade: 0, opts: { attempts: 3 } });
const resumeJob = { name: 'resume', id: 'thread-1:approval', data: { thread_id: 'thread-1', value: { approved: true } }, attemptsMade: 0, opts: { attempts: 3 } };

beforeEach(() => {
    runJobThread.mockReset().mockResolvedValue({});
    invoke.mockReset().mockResolvedValue({});
    getState.mockReset().mockResolvedValue({ next: [] });
    getAgentRun.mockReset().mockResolvedValue(RUN);
    getAgentRunByThread.mockReset().mockResolvedValue(RUN);
    moveAgentRun.mockReset().mockResolvedValue({ moved: true, woken: NEXT });
    enqueueWokenRuns.mockReset().mockResolvedValue();
    wakeStalledAgents.mockReset().mockResolvedValue();
    moveToDelayed.mockReset().mockResolvedValue();
    updateData.mockReset().mockResolvedValue();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

it('schedules the safety net when the worker boots', () => {
    expect(scheduleWakeStalledAgents).toHaveBeenCalled();
});

describe('start', () => {
    it('runs the graph of a run holding a slot and marks a finished thread done', async () => {
        await processor(startJob());

        expect(runJobThread).toHaveBeenCalledWith('thread-1', { user_id: 'user-1', job_id: 'job-1' });
        expect(moveAgentRun).toHaveBeenCalledWith('run-1', ['running'], 'done');
    });

    it('hands the freed slot on by enqueuing the run it went to', async () => {
        await processor(startJob());

        expect(enqueueWokenRuns).toHaveBeenCalledWith(NEXT);
    });

    it('marks a thread stopped at an interrupt as waiting for the user', async () => {
        getState.mockResolvedValue({ next: ['awaitApproval'] });

        await processor(startJob());

        expect(moveAgentRun).toHaveBeenCalledWith('run-1', ['running'], 'waiting_for_you');
    });

    it('drops the job when the run was cancelled before it started', async () => {
        getAgentRun.mockResolvedValue({ ...RUN, status: 'cancelled' });

        await processor(startJob());

        expect(runJobThread).not.toHaveBeenCalled();
        expect(moveAgentRun).not.toHaveBeenCalled();
    });

    it('parks a rate-limited start until the limit resets, keeping its slot, and records when', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        runJobThread.mockRejectedValue(new AppError(429, 'Too many requests.', 30));

        await expect(processor(startJob(), 'token')).rejects.toBeInstanceOf(DelayedError);
        expect(updateData).toHaveBeenCalledWith({ run_id: 'run-1', retry_at: 1_030_000 });
        expect(moveToDelayed).toHaveBeenCalledWith(1_030_000, 'token');
        expect(moveAgentRun).not.toHaveBeenCalled();
        now.mockRestore();
    });

    it('rethrows other graph errors so BullMQ retries them', async () => {
        runJobThread.mockRejectedValue(new AppError(502, 'Error with API.'));

        await expect(processor(startJob(), 'token')).rejects.toMatchObject({ status: 502 });
        expect(moveToDelayed).not.toHaveBeenCalled();
    });

    it('fails a run type that has no graph yet', async () => {
        getAgentRun.mockResolvedValue({ ...RUN, type: 'cover_letter' });

        await expect(processor(startJob())).rejects.toBeInstanceOf(UnrecoverableError);
        expect(runJobThread).not.toHaveBeenCalled();
    });
});

describe('resume', () => {
    it('resumes the thread with the value and settles the run', async () => {
        await processor(resumeJob);

        expect(getAgentRunByThread).toHaveBeenCalledWith('thread-1');
        const [input, config] = invoke.mock.calls[0]!;
        expect((input as Command).args).toEqual({ resume: { approved: true } });
        expect(config).toEqual({ configurable: { thread_id: 'thread-1' } });
        expect(moveAgentRun).toHaveBeenCalledWith('run-1', ['running'], 'done');
        expect(enqueueWokenRuns).toHaveBeenCalledWith(NEXT);
    });

    it('drops a resume for a cancelled run', async () => {
        getAgentRunByThread.mockResolvedValue({ ...RUN, status: 'cancelled' });

        await processor(resumeJob);

        expect(invoke).not.toHaveBeenCalled();
    });

    it('rethrows a failed resume so BullMQ retries it', async () => {
        invoke.mockRejectedValue(new Error('checkpoint load failed'));

        await expect(processor(resumeJob)).rejects.toThrow('checkpoint load failed');
    });
});

describe('wake', () => {
    it('runs the safety net', async () => {
        await processor({ name: 'wake', id: 'repeat:wake', data: {} });

        expect(wakeStalledAgents).toHaveBeenCalled();
    });
});

describe('failed', () => {
    it('marks the run failed after the last attempt and hands its slot on', async () => {
        await handlers.failed!({ ...startJob(), attemptsMade: 3 }, new Error('boom'));

        expect(moveAgentRun).toHaveBeenCalledWith('run-1', ['queued', 'running', 'waiting_for_you'], 'failed');
        expect(enqueueWokenRuns).toHaveBeenCalledWith(NEXT);
    });

    it('leaves the run alone while retries remain', async () => {
        await handlers.failed!({ ...startJob(), attemptsMade: 1 }, new Error('boom'));

        expect(moveAgentRun).not.toHaveBeenCalled();
    });

    it('marks it failed straight away on an unrecoverable error', async () => {
        await handlers.failed!({ ...startJob(), attemptsMade: 1 }, new UnrecoverableError('no graph'));

        expect(moveAgentRun).toHaveBeenCalledWith('run-1', ['queued', 'running', 'waiting_for_you'], 'failed');
    });

    it('ignores a failed wake job, which has no run', async () => {
        await handlers.failed!({ name: 'wake', id: 'repeat:wake', data: {}, attemptsMade: 1, opts: {} }, new Error('redis down'));

        expect(moveAgentRun).not.toHaveBeenCalled();
    });
});
