import { getJobById } from '../../services/job.service.ts';
import { getUserPreferences } from '../../services/preference.service.ts';
import { getInstructionIds } from '../../services/instructions/instructions.service.ts';
import { decideFromScore, sendJobDescription } from '../../services/jobMatch/jobMatch.service.ts';
import { normalizeAndHash } from '../../utils/hash.ts';
import type { JobState } from './state.ts';

/**
 * Scores the posting through the existing job match path, so the score cache, instruction memo
 * and per-user rate limit still apply, and job_matches is upserted, so a re-run after a crash
 * is harmless. Keeps the ids of the posting's stored instructions, so later nodes route the
 * same steps even if the posting is re-extracted under a new version.
 * @throws when the instructions weren't stored, so the worker retries the node
 */
export const jobMatch = async (state: JobState): Promise<Partial<JobState>> => {
  const job = await getJobById(state.job_id);
  const { match_score, rationale } = await sendJobDescription(state.user_id, job.description, job.company, job.title);
  const instruction_ids = await getInstructionIds(normalizeAndHash(job.description));
  if (instruction_ids === null) throw new Error(`Instructions for job ${state.job_id} were not stored.`);
  return { match_score, rationale, instruction_ids };
};

/**
 * Applies the user's job_match threshold in code. The preference is read here rather than
 * carried in state, so changing it mid-sweep affects the next job.
 */
export const decide = async (state: JobState): Promise<Partial<JobState>> => {
  if (state.match_score === null) throw new Error('decide ran before jobMatch scored the job.');
  const { job_match, wait_for_approval } = await getUserPreferences(state.user_id);
  const decision = decideFromScore(state.match_score, job_match);
  return { decision, requires_approval: decision === 'APPLY' && wait_for_approval };
};
