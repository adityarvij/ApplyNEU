import { pool } from '../../db/index.ts';
import { AppError } from '../../errors/AppError.ts';
import { normalizeAndHash } from '../../utils/hash.ts';
import type { CandidateContextResponse, ResumedCandidateContext } from '../../types/candidateContext.ts';

/**
 * Gathers everything needed to reason about a candidate: their primary resume
 * (falling back to their newest, or null when none has finished uploading), their
 * matching preferences and their profile.
 * @param user_id - ID of the user
 */
export const getCandidateContext = async (user_id: string): Promise<CandidateContextResponse> => {
    try {
        const result = await pool.query(
            `
            SELECT r.resume_id,
                   r.resume_text,
                   r.search_terms,
                   r.enrichment_status,
                   pref.job_match,
                   pref.wait_for_approval,
                   pref.job_types,
                   pref.unpaid_roles,
                   pref.recent_jobs,
                   pref.interests,
                   p.grad_year
            FROM profile p
            JOIN preferences pref ON pref.user_id = p.user_id
            LEFT JOIN LATERAL (
                SELECT resume_id, resume_text, search_terms, enrichment_status
                FROM resumes
                WHERE user_id = p.user_id AND upload_complete = true
                ORDER BY (resume_id = pref.primary_resume_id) DESC NULLS LAST, created_at DESC
                LIMIT 1
            ) r ON true
            WHERE p.user_id::text = $1;
            `,
            [user_id]
        );
        if (result.rows.length === 0) throw new AppError(404, 'Candidate context not found.');

        const row = result.rows[0];
        return {
            resume: row.resume_id
                ? { resume_text: row.resume_text, search_terms: row.search_terms, enrichment_status: row.enrichment_status }
                : null,
            preferences: {
                job_match: row.job_match,
                wait_for_approval: row.wait_for_approval,
                job_types: row.job_types,
                unpaid_roles: row.unpaid_roles,
                recent_jobs: row.recent_jobs,
                interests: row.interests,
            },
            profile: {
                grad_year: row.grad_year,
            },
        };
    } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(500, 'Error fetching candidate context.');
    }
};

/**
 * Renders the candidate's own signals in a fixed field order so the same profile always
 * produces byte-identical text. Sensitivity and filter preferences are deliberately absent:
 * the score is sensitivity-agnostic and the cutoff is applied in code, so including
 * job_match here would invalidate every cached score whenever the user retunes it.
 */
export const renderCandidateContext = (context: ResumedCandidateContext): string => {
    const { resume, preferences, profile } = context;

    return [
        `GRADUATION YEAR: ${profile.grad_year}`,
        `INTERESTS: ${preferences.interests.join(', ') || 'none specified'}`,
        `RESUME:`,
        resume.resume_text,
    ].join('\n');
};

export const candidateHash = (context: ResumedCandidateContext): string =>
    normalizeAndHash(renderCandidateContext(context));
