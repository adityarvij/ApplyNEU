import { getAgentsQueue, AGENT_PRIORITY } from '../queues/agentsQueue.ts';
import {
  answerAgentRun, cancelAgentRun, createAgentRun, wakeNextRuns, wakeStalledRuns,
} from '../services/agentRun/agentRun.service.ts';
import type { AgentRunType, WokenRun } from '../types/agentRuns.ts';

/** How long a finished job is kept, so a repeated start or resume for the same step is ignored. */
const DEDUP_SECONDS = 24 * 60 * 60;

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: DEDUP_SECONDS },
  removeOnFail: { age: DEDUP_SECONDS },
};

const WAKE_EVERY_MS = 60_000;

export const startJobId = (run_id: string) => `start:${run_id}`;

/**
 * A resume's job id is `${thread_id}:${step}`, so the same pause is resumed once, while the
 * thread's next pause gets a new id.
 */
const jobFor = (run: WokenRun) => run.resume
  ? {
    name: 'resume',
    data: { thread_id: run.thread_id, value: run.resume.value },
    opts: { ...JOB_OPTIONS, jobId: `${run.thread_id}:${run.resume.step}`, priority: AGENT_PRIORITY.resume },
  }
  : {
    name: 'start',
    data: { run_id: run.run_id },
    opts: { ...JOB_OPTIONS, jobId: startJobId(run.run_id), priority: AGENT_PRIORITY.start },
  };

/**
 * Enqueues the start or resume of each run that was just handed a slot. Call after the hand-off
 * commits. A job that already exists under its id isn't added twice.
 */
export const enqueueWokenRuns = async (runs: WokenRun[]) => {
  if (runs.length) await getAgentsQueue().addBulk(runs.map(jobFor));
};

type StartAgent = {
  user_id: string;
  type: AgentRunType;
  title: string;
  job_id?: string;
  parent_run_id?: string;
};

/**
 * Starts an agent in the background: records a queued run at the back of the user's line and
 * enqueues its start only once it has a slot under the user's num_agents limit.
 */
export const startAgent = async (run: StartAgent) => {
  const created = await createAgentRun({ ...run, status: 'queued' });
  await enqueueWokenRuns(await wakeNextRuns(run.user_id));
  return created;
};

/**
 * Hands the user's answer to a paused thread to the worker instead of resuming it inline, so
 * long nodes never run inside an API request. The run goes back in line ahead of new starts and
 * resumes once it has a slot; answering the same pause twice (a double-clicked approve) resumes
 * it once.
 * @param thread_id - Thread to resume
 * @param step - The pause being resumed, e.g. 'approval'
 * @param value - What the paused node receives, e.g. { approved: true }
 */
export const resumeJobThread = async (thread_id: string, step: string, value: unknown) =>
  enqueueWokenRuns(await answerAgentRun(thread_id, step, value));

/**
 * Cancels one of the caller's unfinished runs, drops its start job if it hasn't run yet, and
 * starts the next run in line if the cancel freed a slot. A run already inside a node finishes
 * that node; the worker then leaves it cancelled.
 */
export const cancelAgent = async (run_id: string, user_id: string) => {
  const { run, woken } = await cancelAgentRun(run_id, user_id);
  await getAgentsQueue().remove(startJobId(run_id)).catch(() => 0);
  await enqueueWokenRuns(woken);
  return run;
};

/**
 * The periodic safety net: starts the head of the line for every user with a free slot, and
 * re-adds the job of any run that was handed a slot but lost its job to a crash before enqueue.
 */
export const wakeStalledAgents = async () => enqueueWokenRuns(await wakeStalledRuns());

/** Runs wakeStalledAgents every minute as the queue's `wake` job. Safe to call on every boot. */
export const scheduleWakeStalledAgents = () =>
  getAgentsQueue().upsertJobScheduler('wake', { every: WAKE_EVERY_MS }, {
    name: 'wake',
    opts: { removeOnComplete: true, removeOnFail: true },
  });
