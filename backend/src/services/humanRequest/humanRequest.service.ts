import { pool } from '../../db/index.ts';
import { AppError } from '../../errors/AppError.ts';
import { enqueueWokenRuns, resumeJobThread } from '../../agents/scheduler.ts';
import type { HumanRequest, HumanRequestKind, HumanRequestStatus } from '../../types/humanRequests.ts';
import { moveAgentRun } from '../agentRun/agentRun.service.ts';

/** Requests shown per status; the inbox only needs the latest. */
const LIST_LIMIT = 100;

const REQUEST_COLUMNS = 'request_id, run_id, job_id, kind, status, payload, answer, created_at, resolved_at, expires_at';

/**
 * The step a request's answer resumes. Unique per request, so a thread that asks twice gets a
 * resume job for each answer instead of the second one being taken for a repeat of the first.
 */
const stepFor = (request: Pick<HumanRequest, 'kind' | 'request_id'>) => `${request.kind}:${request.request_id}`;

type NewHumanRequest = {
  run_id: string;
  kind: HumanRequestKind;
  payload?: Record<string, unknown>;
  expires_at?: Date;
};

/**
 * Records that a run is waiting on its user and moves the run to waiting_for_you, handing the
 * slot it frees to the next run in line. The request takes the run's user and job. Call it in
 * the node before the one that interrupts, since a node that interrupts runs again on resume.
 * @throws AppError(404) when no run has that id; AppError(409) when the run already has a pending request
 */
export const createHumanRequest = async ({ run_id, kind, payload = {}, expires_at }: NewHumanRequest): Promise<HumanRequest> => {
  let request: HumanRequest | undefined;
  try {
    const result = await pool.query<HumanRequest>(
      `
        INSERT INTO human_requests (user_id, run_id, job_id, kind, payload, expires_at)
        SELECT user_id, run_id, job_id, $2::human_request_kind, $3::jsonb, $4::timestamptz
        FROM agent_runs
        WHERE run_id = $1
        RETURNING ${REQUEST_COLUMNS};
      `,
      [run_id, kind, JSON.stringify(payload), expires_at ?? null]
    );
    request = result.rows[0];
  } catch (error) {
    if ((error as { constraint?: string }).constraint === 'human_requests_one_pending_per_run') {
      throw new AppError(409, 'This run is already waiting on you.');
    }
    throw new AppError(500, 'Error creating request.');
  }
  if (!request) throw new AppError(404, 'Agent run not found.');

  const { woken } = await moveAgentRun(run_id, ['running'], 'waiting_for_you');
  await enqueueWokenRuns(woken);
  return request;
};

/**
 * Lists the caller's requests, newest first, optionally only those with one status. A pending
 * request past its expiry is left out even before the sweep marks it expired.
 * @param user_id - Owner of the requests
 */
export const listHumanRequests = async (user_id: string, status?: HumanRequestStatus): Promise<HumanRequest[]> => {
  try {
    const result = await pool.query<HumanRequest>(
      `
        SELECT ${REQUEST_COLUMNS}
        FROM human_requests
        WHERE user_id = $1
          AND ($2::human_request_status IS NULL OR status = $2)
          AND (status <> 'pending' OR expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC
        LIMIT $3;
      `,
      [user_id, status ?? null, LIST_LIMIT]
    );
    return result.rows;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Error fetching requests.');
  }
};

/**
 * Records the caller's answer to one of their pending requests and resumes the run with it.
 * A run with a thread goes back in line and resumes once it has a slot; a run without one
 * (a sweep, driven by the desktop app) goes straight back to running. If the resume can't be
 * queued, the request is put back to pending so the user can answer again.
 * @param answer - What the paused node receives
 * @throws AppError(404) when the request doesn't exist or isn't theirs; AppError(409) when it's no longer pending
 */
export const resolveHumanRequest = async (request_id: string, user_id: string, answer: unknown): Promise<HumanRequest> => {
  const { rows: [resolved] } = await pool.query<HumanRequest & { thread_id: string | null }>(
    `
      UPDATE human_requests hr
      SET status = 'resolved', answer = $3, resolved_at = now()
      FROM agent_runs r
      WHERE hr.request_id = $1 AND hr.user_id = $2 AND hr.status = 'pending'
        AND (hr.expires_at IS NULL OR hr.expires_at > now())
        AND r.run_id = hr.run_id
      RETURNING hr.request_id, hr.run_id, hr.job_id, hr.kind, hr.status, hr.payload, hr.answer,
        hr.created_at, hr.resolved_at, hr.expires_at, r.thread_id;
    `,
    [request_id, user_id, JSON.stringify(answer ?? null)]
  );
  if (!resolved) {
    const { rows: [existing] } = await pool.query(
      `SELECT status FROM human_requests WHERE request_id = $1 AND user_id = $2;`,
      [request_id, user_id]
    );
    if (!existing) throw new AppError(404, 'Request not found.');
    throw new AppError(409, 'This request is no longer waiting for an answer.');
  }

  const { thread_id, ...request } = resolved;
  try {
    if (thread_id) {
      await resumeJobThread(thread_id, stepFor(request), answer);
    } else {
      const { woken } = await moveAgentRun(request.run_id, ['waiting_for_you'], 'running');
      await enqueueWokenRuns(woken);
    }
  } catch (error) {
    await pool.query(
      `
        UPDATE human_requests SET status = 'pending', answer = NULL, resolved_at = NULL
        WHERE request_id = $1 AND status = 'resolved';
      `,
      [request_id]
    ).catch(() => {});
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Error resuming the agent.');
  }
  return request;
};

/**
 * Marks every pending request past its expiry expired and cancels its run, which has no one
 * left to answer it. Run by the agents worker's periodic wake job.
 * @returns the requests that expired
 */
export const expireHumanRequests = async (): Promise<Pick<HumanRequest, 'request_id' | 'run_id'>[]> => {
  const { rows } = await pool.query<Pick<HumanRequest, 'request_id' | 'run_id'>>(
    `
      UPDATE human_requests SET status = 'expired', resolved_at = now()
      WHERE status = 'pending' AND expires_at <= now()
      RETURNING request_id, run_id;
    `
  );
  for (const { run_id } of rows) {
    const { woken } = await moveAgentRun(run_id, ['waiting_for_you'], 'cancelled');
    await enqueueWokenRuns(woken);
  }
  return rows;
};
