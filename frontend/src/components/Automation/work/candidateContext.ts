import { api } from '../../../lib/api'

export type CandidateContext = {
  resume: {
    resume_text: string
    search_terms: string[]
    enrichment_status?: 'none' | 'pending' | 'failed' | 'complete'
  } | null
  preferences: {
    job_match: string
    wait_for_approval: boolean
    job_types: string[]
    unpaid_roles: boolean
    recent_jobs: boolean
    interests: string[]
  }
  profile: { grad_year: number }
}

export type ContextResult =
  | { ok: true; context: CandidateContext }
  | { ok: false; status: number }

let cached: CandidateContext | null = null

/**
 * The resume, preferences and profile a run needs, in one request. Cached because a
 * run reads it from several places; `force` is for the search-term poll, which is
 * waiting for enrichment to fill in terms that were empty at run start.
 */
export const loadCandidateContext = async (force = false): Promise<ContextResult> => {
  if (cached && !force) return { ok: true, context: cached }
  try {
    const resp = await api.get('/me/context')
    if (!resp.ok) return { ok: false, status: resp.status }
    const data = await resp.json()
    cached = data as CandidateContext
    return { ok: true, context: cached }
  } catch (_err) {
    return { ok: false, status: 0 }
  }
}

export const resetCandidateContext = () => { cached = null }
