// Must load env before any import below that reads process.env at module load
// time (the pg Pool in db/index.ts and the Anthropic client in jobMatch.agent.ts).
import 'dotenv/config';
import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { Command } from '@langchain/langgraph';
import { jobGraph, runJobThread } from '../agents/jobGraph/graph.ts';
import { enqueueWokenRuns, scheduleWakeStalledAgents, wakeStalledAgents } from '../agents/scheduler.ts';
import { AGENTS_QUEUE } from '../queues/agentsQueue.ts';
import { bullConnection } from '../queues/connection.ts';
import { pool } from '../db/index.ts';
import { getAgentRun, getAgentRunByThread, moveAgentRun } from '../services/agentRun/agentRun.service.ts';
import { AppError } from '../errors/AppError.ts';
import type { AgentRunStatus } from '../types/agentRuns.ts';
import { onShutdownSignal, runShutdown } from '../utils/shutdown.ts';

/** The graph each run type runs on. Types without one yet fail instead of hanging. */
const GRAPHS = {
    job: {
        graph: jobGraph,
        start: (run: { thread_id: string; user_id: string; job_id: string }) =>
            runJobThread(run.thread_id, { user_id: run.user_id, job_id: run.job_id }),
    },
} as const;

const graphFor = (type: string) => {
    const entry = GRAPHS[type as keyof typeof GRAPHS];
    if (!entry) throw new UnrecoverableError(`No graph for agent type ${type}.`);
    return entry;
};

/** Moves the run and starts whichever runs the slot it freed was handed to. */
const release = async (run_id: string, from: AgentRunStatus[], to: AgentRunStatus) => {
    const { woken } = await moveAgentRun(run_id, from, to);
    await enqueueWokenRuns(woken);
};

/**
 * After a graph returns, a thread with nothing left to run is done; one with a pending node
 * stopped at an interrupt and is waiting on the user. Only moves a run that's still running.
 */
const settle = async (run_id: string, thread_id: string, graph: typeof jobGraph) => {
    const state = await graph.getState({ configurable: { thread_id } });
    await release(run_id, ['running'], state.next.length ? 'waiting_for_you' : 'done');
};

/** How long a rate-limited step waits when the limit gives no reset time. */
const RATE_LIMIT_RETRY_MS = 15_000;

/**
 * Runs a graph step, parking the job until the user's model rate limit resets instead of spending
 * an attempt on it. The run keeps its slot, and retry_at is recorded so the analyze poll can report
 * the wait.
 */
const runStep = async (job: Job, token: string | undefined, step: () => Promise<unknown>) => {
    try {
        await step();
    } catch (error) {
        if (!(error instanceof AppError) || error.status !== 429) throw error;
        const retry_at = Date.now() + (error.retryAfter === undefined ? RATE_LIMIT_RETRY_MS : error.retryAfter * 1000);
        await job.updateData({ ...job.data, retry_at });
        await job.moveToDelayed(retry_at, token);
        throw new DelayedError();
    }
};

const start = async (job: Job, token?: string) => {
    const run = await getAgentRun(job.data.run_id);
    const { graph, start: runGraph } = graphFor(run.type);
    if (run.status !== 'running') return;
    await runStep(job, token, () => runGraph({ thread_id: run.thread_id!, user_id: run.user_id, job_id: run.job_id! }));
    await settle(run.run_id, run.thread_id!, graph);
};

const resume = async (job: Job, token?: string) => {
    const run = await getAgentRunByThread(job.data.thread_id);
    const { graph } = graphFor(run.type);
    if (run.status !== 'running') return;
    await runStep(job, token, () =>
        graph.invoke(new Command({ resume: job.data.value }), { configurable: { thread_id: run.thread_id } }));
    await settle(run.run_id, run.thread_id!, graph);
};

/**
 * Runs agent threads that were handed one of their user's slots; a run is only enqueued once it
 * holds one, and one cancelled since is dropped. A start runs the graph from the beginning; a
 * resume continues a paused thread with the value the user gave, handed to the paused node as
 * the return value of its interrupt() call. The `wake` job is the periodic safety net.
 */
const worker = new Worker(AGENTS_QUEUE, async (job, token) => {
    const startedAt = Date.now();
    console.log(`[agents] ${job.name} ${job.id} started`);
    try {
        if (job.name === 'start') await start(job, token);
        else if (job.name === 'resume') await resume(job, token);
        else if (job.name === 'wake') await wakeStalledAgents();
        else throw new UnrecoverableError(`Unknown agents job ${job.name}.`);
        console.log(`[agents] ${job.name} ${job.id} finished in ${Date.now() - startedAt}ms`);
    } catch (err) {
        if (err instanceof DelayedError) throw err;
        console.error(`[agents] ${job.name} ${job.id} threw after ${Date.now() - startedAt}ms`, err);
        throw err;
    }
}, {
    connection: bullConnection,
    concurrency: 5,
});

scheduleWakeStalledAgents().catch((err) => {
    console.error('[agents] could not schedule the wake job:', err);
});

/** Marks the run failed once a start or resume has used its last attempt. */
worker.on('failed', async (job, err) => {
    console.error(`[agents] ${job?.name} ${job?.id} failed:`, err);
    if (!job || job.name === 'wake') return;
    const outOfAttempts = job.attemptsMade >= (job.opts.attempts ?? 1) || err instanceof UnrecoverableError;
    if (!outOfAttempts) return;
    try {
        const run = job.name === 'start' ? await getAgentRun(job.data.run_id) : await getAgentRunByThread(job.data.thread_id);
        await release(run.run_id, ['queued', 'running', 'waiting_for_you'], 'failed');
    } catch (statusErr) {
        console.error(`[agents] could not mark the run for job ${job.id} failed:`, statusErr);
    }
});

// worker.close() waits for active jobs to finish and stops new ones from starting, so a
// deploy never cuts a node off mid-step.
onShutdownSignal((signal) => {
    console.log(`[agents] ${signal} received, finishing active jobs`);
    void runShutdown([
        () => worker.close(),
        () => pool.end(),
    ]);
});
