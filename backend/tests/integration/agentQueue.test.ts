import { jest, it, expect } from '@jest/globals';
import { describeWithDatabase, useTestDatabase } from './support/db.ts';

const db = useTestDatabase();

// The hand-off runs its own transaction on a dedicated client. Each test already runs inside
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

const {
    createAgentRun, wakeNextRuns, answerAgentRun, cancelAgentRun, moveAgentRun, getAgentRun, wakeStalledRuns,
} = await import('../../src/services/agentRun/agentRun.service.ts');

const newUser = async (num_agents?: number) => {
    const { rows: [user] } = await db.pool.query(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`);
    if (num_agents) await db.pool.query(`UPDATE preferences SET num_agents = $2 WHERE user_id = $1`, [user.id, num_agents]);
    return user.id as string;
};

const newJob = async () => {
    const { rows: [job] } = await db.pool.query(
        `INSERT INTO jobs (company, title, description, description_hash) VALUES ('Acme', 'SWE', $1, $1) RETURNING job_id`,
        [`posting ${Math.random()}`]
    );
    return job.job_id as string;
};

/** A run that waits for one of the user's slots. */
const queuedRun = async (user_id: string) =>
    createAgentRun({ user_id, type: 'external_apply', title: 'Apply @ Acme', job_id: await newJob() });

/** A sweep's job run, which never waits for a slot. */
const queuedJobRun = async (user_id: string) =>
    createAgentRun({ user_id, type: 'job', title: 'SWE @ Acme', job_id: await newJob() });

const ids = (runs: { run_id: string }[]) => runs.map((run) => run.run_id);
const statusOf = async (run_id: string) => (await getAgentRun(run_id)).status;

/** A user at num_agents 1 whose first run is paused on them and second run holds the slot. */
const pausedBehindRunning = async () => {
    const user = await newUser(1);
    const paused = await queuedRun(user);
    const running = await queuedRun(user);
    await wakeNextRuns(user);
    await moveAgentRun(paused.run_id, ['running'], 'waiting_for_you');
    return { user, paused, running };
};

describeWithDatabase('agent line against Postgres', () => {
    it('hands out up to num_agents slots in arrival order and leaves the rest queued', async () => {
        const user = await newUser(2);
        const runs = [await queuedRun(user), await queuedRun(user), await queuedRun(user)];

        expect(ids(await wakeNextRuns(user)).sort()).toEqual(ids(runs.slice(0, 2)).sort());
        expect(await statusOf(runs[2]!.run_id)).toBe('queued');
        expect(await wakeNextRuns(user)).toEqual([]);
    });

    it('defaults to 15 running agents at once', async () => {
        const user = await newUser();
        for (let i = 0; i < 16; i += 1) await queuedRun(user);

        expect(await wakeNextRuns(user)).toHaveLength(15);
    });

    it('does not count other users\' runs', async () => {
        const busy = await newUser(1);
        await queuedRun(busy);
        await wakeNextRuns(busy);

        const other = await newUser(1);
        const run = await queuedRun(other);
        expect(ids(await wakeNextRuns(other))).toEqual([run.run_id]);
    });

    it('hands a finished run\'s slot to the head of the line in the same move', async () => {
        const user = await newUser(1);
        const first = await queuedRun(user);
        const second = await queuedRun(user);
        const third = await queuedRun(user);
        await wakeNextRuns(user);

        const { moved, woken } = await moveAgentRun(first.run_id, ['running'], 'done');

        expect(moved).toBe(true);
        expect(woken).toEqual([{ run_id: second.run_id, thread_id: second.thread_id, resume: null }]);
        expect(await statusOf(second.run_id)).toBe('running');
        expect(await statusOf(third.run_id)).toBe('queued');
    });

    it('frees a slot for the next run while a run waits on the user', async () => {
        const { running } = await pausedBehindRunning();

        expect(await statusOf(running.run_id)).toBe('running');
    });

    it('puts an answered resume back in line ahead of starts that queued before it', async () => {
        const { user, paused, running } = await pausedBehindRunning();
        const earlier = await queuedRun(user);

        expect(await answerAgentRun(paused.thread_id!, 'approval', { approved: true })).toEqual([]);
        const { woken } = await moveAgentRun(running.run_id, ['running'], 'done');

        expect(woken).toEqual([{
            run_id: paused.run_id, thread_id: paused.thread_id, resume: { step: 'approval', value: { approved: true } },
        }]);
        expect(await statusOf(earlier.run_id)).toBe('queued');
    });

    it('serves answered resumes in the order they were answered', async () => {
        const user = await newUser(2);
        const runs = [await queuedRun(user), await queuedRun(user)];
        await wakeNextRuns(user);
        await moveAgentRun(runs[1]!.run_id, ['running'], 'waiting_for_you');
        await moveAgentRun(runs[0]!.run_id, ['running'], 'waiting_for_you');
        const blockers = [await queuedRun(user), await queuedRun(user)];
        await wakeNextRuns(user);

        await answerAgentRun(runs[1]!.thread_id!, 'approval', { approved: true });
        await answerAgentRun(runs[0]!.thread_id!, 'approval', { approved: true });

        expect(ids((await moveAgentRun(blockers[0]!.run_id, ['running'], 'done')).woken)).toEqual([runs[1]!.run_id]);
    });

    it('resumes an answered run straight away when a slot is free', async () => {
        const user = await newUser(1);
        const run = await queuedRun(user);
        await wakeNextRuns(user);
        await moveAgentRun(run.run_id, ['running'], 'waiting_for_you');

        expect(ids(await answerAgentRun(run.thread_id!, 'approval', { approved: true }))).toEqual([run.run_id]);
        expect(await statusOf(run.run_id)).toBe('running');
    });

    it('ignores a second answer to the same pause', async () => {
        const { paused } = await pausedBehindRunning();

        await answerAgentRun(paused.thread_id!, 'approval', { approved: true });
        const { rows: [before] } = await db.pool.query(`SELECT queued_at, resume FROM agent_runs WHERE run_id = $1`, [paused.run_id]);
        await answerAgentRun(paused.thread_id!, 'approval', { approved: false });
        const { rows: [after] } = await db.pool.query(`SELECT queued_at, resume FROM agent_runs WHERE run_id = $1`, [paused.run_id]);

        expect(after).toEqual(before);
    });

    it('hands a failed run\'s slot on', async () => {
        const user = await newUser(1);
        const first = await queuedRun(user);
        const second = await queuedRun(user);
        await wakeNextRuns(user);

        const { woken } = await moveAgentRun(first.run_id, ['queued', 'running', 'waiting_for_you'], 'failed');

        expect(ids(woken)).toEqual([second.run_id]);
    });

    it('hands a cancelled run\'s slot on', async () => {
        const user = await newUser(1);
        const first = await queuedRun(user);
        const second = await queuedRun(user);
        await wakeNextRuns(user);

        const { run, woken } = await cancelAgentRun(first.run_id, user);

        expect(run.status).toBe('cancelled');
        expect(ids(woken)).toEqual([second.run_id]);
    });

    it('takes a cancelled run out of line and leaves it cancelled', async () => {
        const user = await newUser(1);
        const run = await queuedRun(user);
        await cancelAgentRun(run.run_id, user);

        expect(await wakeNextRuns(user)).toEqual([]);
        expect((await moveAgentRun(run.run_id, ['running'], 'done')).moved).toBe(false);
        expect(await statusOf(run.run_id)).toBe('cancelled');
    });

    it('refuses to cancel a finished run or someone else\'s', async () => {
        const user = await newUser();
        const run = await queuedRun(user);

        await expect(cancelAgentRun(run.run_id, await newUser())).rejects.toMatchObject({ status: 404 });
        await moveAgentRun(run.run_id, ['queued'], 'done');
        await expect(cancelAgentRun(run.run_id, user)).rejects.toMatchObject({ status: 409 });
    });

    it('safety net: wakes a line whose hand-off was lost and re-lists runs already holding a slot', async () => {
        const user = await newUser(2);
        const holding = await queuedRun(user);
        await wakeNextRuns(user);
        const stranded = await queuedRun(user);
        const waiting = await queuedRun(user);
        const inline = await createAgentRun({ user_id: await newUser(), type: 'external_apply', title: 'a', job_id: await newJob(), status: 'running' });

        const woken = ids(await wakeStalledRuns());

        expect(woken.sort()).toEqual([holding.run_id, stranded.run_id].sort());
        expect(woken).not.toContain(inline.run_id);
        expect(await statusOf(waiting.run_id)).toBe('queued');
    });

    it('starts a job run straight away when every slot is taken', async () => {
        const user = await newUser(1);
        const holding = await queuedRun(user);
        await wakeNextRuns(user);
        const waiting = await queuedRun(user);
        const job = await queuedJobRun(user);

        expect(ids(await wakeNextRuns(user))).toEqual([job.run_id]);
        expect(await statusOf(holding.run_id)).toBe('running');
        expect(await statusOf(waiting.run_id)).toBe('queued');
    });

    it('does not count running job runs toward num_agents', async () => {
        const user = await newUser(1);
        await queuedJobRun(user);
        await queuedJobRun(user);
        await wakeNextRuns(user);
        const run = await queuedRun(user);

        expect(ids(await wakeNextRuns(user))).toEqual([run.run_id]);
    });

    it('resumes an answered job run while every slot is taken', async () => {
        const user = await newUser(1);
        const job = await queuedJobRun(user);
        await wakeNextRuns(user);
        await moveAgentRun(job.run_id, ['running'], 'waiting_for_you');
        await queuedRun(user);
        await wakeNextRuns(user);

        expect(ids(await answerAgentRun(job.thread_id!, 'approval', { approved: true }))).toEqual([job.run_id]);
    });

    it('safety net: wakes a stranded job run for a user whose slots are full', async () => {
        const user = await newUser(1);
        const holding = await queuedRun(user);
        await wakeNextRuns(user);
        const job = await queuedJobRun(user);

        expect(ids(await wakeStalledRuns()).sort()).toEqual([holding.run_id, job.run_id].sort());
        expect(await statusOf(job.run_id)).toBe('running');
    });
});
