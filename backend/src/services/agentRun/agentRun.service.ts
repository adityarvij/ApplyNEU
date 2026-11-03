import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/index.ts';
import { AppError } from '../../errors/AppError.ts';
import type { AgentRun, AgentRunGroups, AgentRunStatus, AgentRunType, WokenRun } from '../../types/agentRuns.ts';

/** Finished runs shown on the homepage; active runs are always shown in full. */
const RECENT_LIMIT = 20;

const RUN_COLUMNS = 'run_id, type, parent_run_id, job_id, status, title, started_at, updated_at';

/**
 * Lists the caller's agent runs grouped for the homepage, each group newest activity first:
 * runs waiting on the user, running, queued, and the most recent finished ones.
 * @param user_id - Owner of the runs
 */
export const listAgentRuns = async (user_id: string): Promise<AgentRunGroups> => {
  try {
    const [active, recent] = await Promise.all([
      pool.query<AgentRun>(
        `
          SELECT ${RUN_COLUMNS}
          FROM agent_runs
          WHERE user_id = $1 AND status IN ('queued', 'running', 'waiting_for_you')
          ORDER BY updated_at DESC;
        `,
        [user_id]
      ),
      pool.query<AgentRun>(
        `
          SELECT ${RUN_COLUMNS}
          FROM agent_runs
          WHERE user_id = $1 AND status IN ('done', 'failed', 'handed_off', 'cancelled')
          ORDER BY updated_at DESC
          LIMIT $2;
        `,
        [user_id, RECENT_LIMIT]
      ),
    ]);
    const withStatus = (status: AgentRunStatus) => active.rows.filter((run) => run.status === status);
    return {
      needs_you: withStatus('waiting_for_you'),
      running: withStatus('running'),
      queued: withStatus('queued'),
      recent: recent.rows,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Error fetching agent runs.');
  }
};

type NewAgentRun = {
  user_id: string;
  type: AgentRunType;
  title: string;
  job_id?: string;
  parent_run_id?: string;
  status?: AgentRunStatus;
};

/**
 * Records a new run. Every type except sweep gets a fresh thread_id for its LangGraph thread,
 * returned so the caller can start the graph on it. A queued run joins the back of the line.
 * @throws AppError(409) when the user already has an unfinished run for this job
 */
export const createAgentRun = async ({
  user_id, type, title, job_id, parent_run_id, status = 'queued',
}: NewAgentRun): Promise<AgentRun & { thread_id: string | null }> => {
  try {
    const result = await pool.query(
      `
        INSERT INTO agent_runs (user_id, type, title, job_id, parent_run_id, thread_id, status, queued_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::agent_run_status, CASE WHEN $7::agent_run_status = 'queued' THEN clock_timestamp() END)
        RETURNING ${RUN_COLUMNS}, thread_id;
      `,
      [user_id, type, title, job_id ?? null, parent_run_id ?? null, type === 'sweep' ? null : randomUUID(), status]
    );
    return result.rows[0];
  } catch (error) {
    if ((error as { constraint?: string }).constraint === 'agent_runs_one_active_job') {
      throw new AppError(409, 'This job already has an active run.');
    }
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Error creating agent run.');
  }
};

/**
 * Fetches the user's unfinished run for a job, the one agent_runs_one_active_job allows.
 * @returns the run with its thread, or null when the job has none
 */
export const getActiveJobRun = async (
  user_id: string,
  job_id: string
): Promise<(AgentRun & { thread_id: string | null }) | null> => {
  try {
    const result = await pool.query(
      `
        SELECT ${RUN_COLUMNS}, thread_id
        FROM agent_runs
        WHERE user_id = $1 AND job_id = $2 AND type = 'job'
          AND status IN ('queued', 'running', 'waiting_for_you');
      `,
      [user_id, job_id]
    );
    return result.rows[0] ?? null;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Error fetching agent run.');
  }
};

/**
 * Moves a run to a new status and bumps updated_at, so the homepage sorts by latest activity.
 * Called by the graph and workers, which act on a run they already own, so it isn't scoped to
 * a user.
 * @throws AppError(404) when no run has that id
 */
export const updateAgentRunStatus = async (run_id: string, status: AgentRunStatus): Promise<AgentRun> => {
  try {
    const result = await pool.query<AgentRun>(
      `
        UPDATE agent_runs
        SET status = $2, updated_at = now()
        WHERE run_id = $1
        RETURNING ${RUN_COLUMNS};
      `,
      [run_id, status]
    );
    if (!result.rows[0]) throw new AppError(404, 'Agent run not found.');
    return result.rows[0];
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Error updating agent run.');
  }
};

type RunWithThread = AgentRun & { user_id: string; thread_id: string | null };

const FINISHED: AgentRunStatus[] = ['done', 'failed', 'handed_off', 'cancelled'];

/**
 * Fetches a run by id with its owner and thread, for the worker.
 * @throws AppError(404) when no run has that id
 */
export const getAgentRun = async (run_id: string): Promise<RunWithThread> => {
  const result = await pool.query<RunWithThread>(
    `SELECT ${RUN_COLUMNS}, user_id, thread_id FROM agent_runs WHERE run_id = $1;`,
    [run_id]
  );
  if (!result.rows[0]) throw new AppError(404, 'Agent run not found.');
  return result.rows[0];
};

/**
 * Fetches the run that owns a LangGraph thread, for resumes.
 * @throws AppError(404) when no run has that thread
 */
export const getAgentRunByThread = async (thread_id: string): Promise<RunWithThread> => {
  const result = await pool.query<RunWithThread>(
    `SELECT ${RUN_COLUMNS}, user_id, thread_id FROM agent_runs WHERE thread_id = $1;`,
    [thread_id]
  );
  if (!result.rows[0]) throw new AppError(404, 'Agent run not found.');
  return result.rows[0];
};

/**
 * Fetches one of the caller's runs.
 * @throws AppError(404) when the run doesn't exist or belongs to someone else
 */
export const getAgentRunForUser = async (run_id: string, user_id: string): Promise<AgentRun> => {
  const result = await pool.query<AgentRun>(
    `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE run_id = $1 AND user_id = $2;`,
    [run_id, user_id]
  );
  if (!result.rows[0]) throw new AppError(404, 'Agent run not found.');
  return result.rows[0];
};

const transaction = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

/** Serializes every change to who holds or waits for one of the user's slots. */
const lockLine = (client: PoolClient, user_id: string) =>
  client.query(`SELECT pg_advisory_xact_lock(hashtext($1));`, [user_id]);

/** Cancels a finished run's pending request, so the inbox doesn't ask about a run that can't resume. */
const cancelPendingRequests = (client: PoolClient, run_id: string) =>
  client.query(
    `UPDATE human_requests SET status = 'cancelled', resolved_at = now() WHERE run_id = $1 AND status = 'pending';`,
    [run_id]
  );

/**
 * Gives each of the user's free slots to the next run in line and moves it to running. Runs
 * waiting on the user don't hold a slot. The line is every queued run plus every paused run the
 * user has answered: answered resumes first, then by queued_at. Job runs skip the line and
 * never hold a slot, because the sweep works one job at a time in its own NUWorks window; only
 * the runs that work by themselves share num_agents. Call with the line locked.
 * @returns the runs that took a slot, whose jobs the caller enqueues after commit
 */
const fillSlots = async (client: PoolClient, user_id: string): Promise<WokenRun[]> => {
  const result = await client.query<WokenRun>(
    `
      WITH line AS (
        SELECT run_id, type, resume, queued_at FROM agent_runs
        WHERE user_id = $1 AND (status = 'queued' OR (status = 'waiting_for_you' AND resume IS NOT NULL))
      ),
      next AS (
        SELECT run_id FROM line WHERE type = 'job'
        UNION ALL
        (
          SELECT run_id FROM line WHERE type <> 'job'
          ORDER BY resume IS NULL, queued_at, run_id
          LIMIT GREATEST(
            COALESCE((SELECT num_agents FROM preferences WHERE user_id = $1), 15)
              - (SELECT count(*) FROM agent_runs WHERE user_id = $1 AND status = 'running' AND type <> 'job'),
            0
          )
        )
      )
      UPDATE agent_runs SET status = 'running', updated_at = now()
      WHERE run_id IN (SELECT run_id FROM next)
      RETURNING run_id, thread_id, resume;
    `,
    [user_id]
  );
  return result.rows;
};

/**
 * Hands the user's free slots to the head of their line, e.g. after a new run joins it.
 * @returns the runs that took a slot, whose jobs the caller enqueues
 */
export const wakeNextRuns = (user_id: string): Promise<WokenRun[]> =>
  transaction(async (client) => {
    await lockLine(client, user_id);
    return fillSlots(client, user_id);
  });

/**
 * Records the user's answer to a paused run and puts the run back in line, ahead of every
 * queued start, then hands it a slot if one is free. Answering the same pause twice changes
 * nothing.
 * @param step - The pause being answered, e.g. 'approval'
 * @param value - What the paused node receives
 * @returns the runs that took a slot, whose jobs the caller enqueues
 * @throws AppError(404) when no run has that thread
 */
export const answerAgentRun = (thread_id: string, step: string, value: unknown): Promise<WokenRun[]> =>
  transaction(async (client) => {
    const { rows: [run] } = await client.query(`SELECT user_id FROM agent_runs WHERE thread_id = $1;`, [thread_id]);
    if (!run) throw new AppError(404, 'Agent run not found.');
    await lockLine(client, run.user_id);
    await client.query(
      `
        UPDATE agent_runs SET resume = $2, queued_at = clock_timestamp(), updated_at = now()
        WHERE thread_id = $1 AND status = 'waiting_for_you' AND resume IS NULL;
      `,
      [thread_id, JSON.stringify({ step, value })]
    );
    return fillSlots(client, run.user_id);
  });

/**
 * Moves a run between statuses only if it's still in one of `from`, so a run cancelled while
 * a node was running isn't flipped back to done or waiting. In the same transaction, a run that
 * finishes has its pending request cancelled, and a slot the move frees goes to the next run in
 * line.
 * @returns whether the run moved, and the runs that took a slot, whose jobs the caller enqueues
 */
export const moveAgentRun = (
  run_id: string,
  from: AgentRunStatus[],
  to: AgentRunStatus
): Promise<{ moved: boolean; woken: WokenRun[] }> =>
  transaction(async (client) => {
    const { rows: [run] } = await client.query(`SELECT user_id FROM agent_runs WHERE run_id = $1;`, [run_id]);
    if (!run) return { moved: false, woken: [] };
    await lockLine(client, run.user_id);
    const result = await client.query(
      `
        UPDATE agent_runs SET status = $3, resume = NULL, updated_at = now()
        WHERE run_id = $1 AND status = ANY($2::agent_run_status[]);
      `,
      [run_id, from, to]
    );
    const moved = (result.rowCount ?? 0) > 0;
    if (moved && FINISHED.includes(to)) await cancelPendingRequests(client, run_id);
    return { moved, woken: await fillSlots(client, run.user_id) };
  });

/**
 * Cancels one of the caller's unfinished runs and its pending request, and hands a slot it frees
 * to the next run in line.
 * @returns the cancelled run, and the runs that took a slot, whose jobs the caller enqueues
 * @throws AppError(404) when the run doesn't exist or isn't theirs; AppError(409) when it already finished
 */
export const cancelAgentRun = (run_id: string, user_id: string): Promise<{ run: AgentRun; woken: WokenRun[] }> =>
  transaction(async (client) => {
    await lockLine(client, user_id);
    const { rows: [run] } = await client.query<AgentRun>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE run_id = $1 AND user_id = $2;`,
      [run_id, user_id]
    );
    if (!run) throw new AppError(404, 'Agent run not found.');
    if (FINISHED.includes(run.status)) throw new AppError(409, 'This run has already finished.');
    const result = await client.query<AgentRun>(
      `
        UPDATE agent_runs SET status = 'cancelled', resume = NULL, updated_at = now()
        WHERE run_id = $1
        RETURNING ${RUN_COLUMNS};
      `,
      [run_id]
    );
    await cancelPendingRequests(client, run_id);
    return { run: result.rows[0]!, woken: await fillSlots(client, user_id) };
  });

/**
 * The periodic safety net: hands out free slots for every user who has one and someone in line,
 * then lists every run holding a slot it took from the line, so a job lost between a hand-off's
 * commit and its enqueue is added again. Re-adding a job that still exists is a no-op.
 * @returns every run holding a slot it was handed, whose jobs the caller enqueues
 */
export const wakeStalledRuns = async (): Promise<WokenRun[]> => {
  const { rows: users } = await pool.query<{ user_id: string }>(
    `
      SELECT DISTINCT line.user_id
      FROM agent_runs line
      WHERE (line.status = 'queued' OR (line.status = 'waiting_for_you' AND line.resume IS NOT NULL))
        AND (
          line.type = 'job'
          OR (SELECT count(*) FROM agent_runs r WHERE r.user_id = line.user_id AND r.status = 'running' AND r.type <> 'job')
            < COALESCE((SELECT num_agents FROM preferences p WHERE p.user_id = line.user_id), 15)
        );
    `
  );
  for (const { user_id } of users) await wakeNextRuns(user_id);
  const { rows } = await pool.query<WokenRun>(
    `SELECT run_id, thread_id, resume FROM agent_runs WHERE status = 'running' AND queued_at IS NOT NULL;`
  );
  return rows;
};
