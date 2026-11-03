import { jest, it, expect } from '@jest/globals';
import { describeWithDatabase, useTestDatabase } from './support/db.ts';

const db = useTestDatabase();

// The run moves run their own transaction on a dedicated client. Each test already runs inside
// one, so its BEGIN/COMMIT/ROLLBACK become a savepoint on the same connection.
const SAVEPOINT: Record<string, string> = {
    BEGIN: 'SAVEPOINT handoff',
    COMMIT: 'RELEASE SAVEPOINT handoff',
    ROLLBACK: 'ROLLBACK TO SAVEPOINT handoff',
};
const pool = {
    query: db.pool.query,
    connect: async () => ({
        query: (text: string, params?: unknown[]) => db.pool.query(SAVEPOINT[text] ?? text, params),
        release: () => {},
    }),
};

jest.unstable_mockModule('../../src/db/index.ts', () => ({ pool }));

// The real resume only adds BullMQ jobs on top of answerAgentRun, so the scheduler stands in
// with the line change alone.
const resumeJobThread = jest.fn(async (thread_id: string, step: string, value: unknown) => {
    await answerAgentRun(thread_id, step, value);
});
jest.unstable_mockModule('../../src/agents/scheduler.ts', () => ({
    enqueueWokenRuns: async () => {},
    resumeJobThread,
}));

const { createAgentRun, wakeNextRuns, cancelAgentRun, getAgentRun, answerAgentRun } =
    await import('../../src/services/agentRun/agentRun.service.ts');
const { createHumanRequest, listHumanRequests, resolveHumanRequest, expireHumanRequests } =
    await import('../../src/services/humanRequest/humanRequest.service.ts');

const newUser = async () => {
    const { rows: [user] } = await db.pool.query(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`);
    return user.id as string;
};

const newJob = async () => {
    const { rows: [job] } = await db.pool.query(
        `INSERT INTO jobs (company, title, description, description_hash) VALUES ('Acme', 'SWE', $1, $1) RETURNING job_id`,
        [`posting ${Math.random()}`]
    );
    return job.job_id as string;
};

/** A job run that holds one of its user's slots. */
const runningJobRun = async (user_id: string) => {
    const run = await createAgentRun({ user_id, type: 'job', title: 'SWE @ Acme', job_id: await newJob() });
    await wakeNextRuns(user_id);
    return run;
};

const statusOf = async (run_id: string) => (await getAgentRun(run_id)).status;

describeWithDatabase('human requests against Postgres', () => {
    it("creates a request under the run's user and job and moves the run to waiting_for_you", async () => {
        const user = await newUser();
        const run = await runningJobRun(user);

        const request = await createHumanRequest({ run_id: run.run_id, kind: 'apply_approval', payload: { title: 'SWE' } });

        expect(request).toMatchObject({ run_id: run.run_id, job_id: run.job_id, kind: 'apply_approval', status: 'pending', payload: { title: 'SWE' } });
        expect(await statusOf(run.run_id)).toBe('waiting_for_you');
        expect((await listHumanRequests(user, 'pending')).map((r) => r.request_id)).toEqual([request.request_id]);
    });

    it('resolves a pending request for its owner and puts the run back in line with the answer', async () => {
        const user = await newUser();
        const run = await runningJobRun(user);
        const request = await createHumanRequest({ run_id: run.run_id, kind: 'apply_approval' });

        const resolved = await resolveHumanRequest(request.request_id, user, { approved: true });

        expect(resolved).toMatchObject({ status: 'resolved', answer: { approved: true } });
        expect(resolved.resolved_at).not.toBeNull();
        expect(resumeJobThread).toHaveBeenCalledWith(run.thread_id, `apply_approval:${request.request_id}`, { approved: true });
        expect(await statusOf(run.run_id)).toBe('running');
        expect(await listHumanRequests(user, 'pending')).toEqual([]);
    });

    it("doesn't let another user see or resolve the request, and resolves it only once", async () => {
        const user = await newUser();
        const other = await newUser();
        const run = await runningJobRun(user);
        const request = await createHumanRequest({ run_id: run.run_id, kind: 'question' });

        expect(await listHumanRequests(other)).toEqual([]);
        await expect(resolveHumanRequest(request.request_id, other, 'yes')).rejects.toMatchObject({ status: 404 });

        await resolveHumanRequest(request.request_id, user, 'yes');
        await expect(resolveHumanRequest(request.request_id, user, 'no')).rejects.toMatchObject({ status: 409 });
    });

    it('expires an overdue request and cancels its run', async () => {
        const user = await newUser();
        const run = await runningJobRun(user);
        const request = await createHumanRequest({ run_id: run.run_id, kind: 'question', expires_at: new Date(Date.now() - 1000) });

        expect(await listHumanRequests(user, 'pending')).toEqual([]);
        expect((await expireHumanRequests()).map((r) => r.request_id)).toContain(request.request_id);
        expect((await listHumanRequests(user, 'expired')).map((r) => r.request_id)).toEqual([request.request_id]);
        expect(await statusOf(run.run_id)).toBe('cancelled');
    });

    it("cancels a run's pending request when the user cancels the run", async () => {
        const user = await newUser();
        const run = await runningJobRun(user);
        const request = await createHumanRequest({ run_id: run.run_id, kind: 'handoff' });

        await cancelAgentRun(run.run_id, user);

        expect((await listHumanRequests(user, 'cancelled')).map((r) => r.request_id)).toEqual([request.request_id]);
    });

    it('allows one pending request per run', async () => {
        const user = await newUser();
        const run = await runningJobRun(user);
        await createHumanRequest({ run_id: run.run_id, kind: 'question' });

        // The unique violation aborts the test's transaction, so nothing can run after it.
        await expect(createHumanRequest({ run_id: run.run_id, kind: 'question' })).rejects.toMatchObject({ status: 409 });
    });
});
