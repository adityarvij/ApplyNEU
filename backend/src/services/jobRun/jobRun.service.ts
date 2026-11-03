import { jobGraph } from '../../agents/jobGraph/graph.ts';
import { startAgent, startJobId } from '../../agents/scheduler.ts';
import { AppError } from '../../errors/AppError.ts';
import { getAgentsQueue } from '../../queues/agentsQueue.ts';
import type { AgentRunStatus } from '../../types/agentRuns.ts';
import { normalizeAndHash } from '../../utils/hash.ts';
import { getActiveJobRun, getAgentRun } from '../agentRun/agentRun.service.ts';
import { getInstructions } from '../instructions/instructions.service.ts';
import { addJob, getJobById } from '../job.service.ts';

const SETTLED: AgentRunStatus[] = ['done', 'waiting_for_you'];

/**
 * Queues the posting's job run for the caller, or returns the active one when an earlier analyze
 * already queued it. The run waits for a free slot under the user's num_agents limit, so the
 * caller polls getJobAnalysis for the result.
 * @throws AppError(409) when the active run finished between the insert and the lookup
 */
export const analyzeJob = async (user_id: string, job_description: string, company: string, title: string) => {
  const job = await addJob(company, title, job_description);
  try {
    const run = await startAgent({
      user_id, type: 'job', title: `${job.title} at ${job.company}`, job_id: job.job_id,
    });
    return { run_id: run.run_id, status: run.status };
  } catch (error) {
    if (!(error instanceof AppError) || error.status !== 409) throw error;
    const active = await getActiveJobRun(user_id, job.job_id);
    if (!active) throw error;
    return { run_id: active.run_id, status: active.status };
  }
};

/** Seconds until a rate-limited start tries again, or null when it isn't waiting on the limit. */
const rateLimitWait = async (run_id: string) => {
  const job = await getAgentsQueue().getJob(startJobId(run_id));
  const retry_at = job?.data.retry_at;
  if (typeof retry_at !== 'number' || retry_at <= Date.now()) return null;
  return Math.ceil((retry_at - Date.now()) / 1000);
};

/**
 * Reports one of the caller's job runs. A run that ended or paused on the user comes with the
 * thread's decision, score, rationale and the posting's employer instructions; a running run
 * waiting out the user's model rate limit comes with retry_after in seconds.
 * @throws AppError(404) when the run doesn't exist, isn't a job run, or belongs to someone else
 */
export const getJobAnalysis = async (run_id: string, user_id: string) => {
  const run = await getAgentRun(run_id);
  if (run.user_id !== user_id || run.type !== 'job') throw new AppError(404, 'Agent run not found.');
  if (run.status === 'running') return { run_id, status: run.status, retry_after: await rateLimitWait(run_id) };
  if (!SETTLED.includes(run.status)) return { run_id, status: run.status };

  const [{ values }, job] = await Promise.all([
    jobGraph.getState({ configurable: { thread_id: run.thread_id! } }),
    getJobById(run.job_id!),
  ]);
  const employer_instructions = await getInstructions(normalizeAndHash(job.description));
  return {
    run_id,
    status: run.status,
    decision: values.decision,
    match_score: values.match_score,
    rationale: values.rationale,
    requires_approval: values.requires_approval,
    employer_instructions: employer_instructions ?? [],
  };
};
