import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../lib/supabase', () => ({ getUserId: async () => 'user-1' }))
vi.mock('../../../../lib/api', () => {
  const json = (body: unknown, ok = true, status = 200) =>
    ({ ok, status, json: async () => body, text: async () => '' })
  return {
    api: {
      get: vi.fn(async (path: string) => {
        if (path.includes('/me/context')) {
          if (contextThrows) throw new Error('network down')
          if (contextStatus !== 200) return json({}, false, contextStatus)
          return json({
            resume: contextResume,
            preferences: { job_match: 'medium', wait_for_approval: false, job_types: ['Co-op'], unpaid_roles: true, recent_jobs: false, interests: [] },
            profile: { grad_year: 2027 },
          })
        }
        if (path.includes('/tasks')) return json([])
        return json({})
      }),
      post: vi.fn(async () => json({})),
      del: vi.fn(async () => json({})),
    },
  }
})

let contextStatus = 200
let contextThrows = false
let contextResume: { resume_text: string; search_terms: string[]; enrichment_status?: string } | null

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  contextStatus = 200
  contextThrows = false
  contextResume = { resume_text: 'Backend engineer.', search_terms: ['software'] }
})

const getPaths = (api: any): string[] => (api.get as any).mock.calls.map((c: any[]) => c[0] as string)

describe('the assembled profile replaces the startup fetches', () => {
  it('serves search terms and preferences from one /me/context call', async () => {
    const { api } = await import('../../../../lib/api')
    const { refreshSearchTerms } = await import('../searchTerms')
    const { loadUserPreferences, prefersRecentJobs, allowsUnpaidRoles } = await import('../preferences')
    const { getState } = await import('../automationStore')

    await refreshSearchTerms()
    const waitForApproval = await loadUserPreferences()

    expect(getState().searchTerms).toEqual(['software'])
    expect(waitForApproval).toBe(false)
    expect(prefersRecentJobs()).toBe(false)
    expect(allowsUnpaidRoles()).toBe(true)

    const paths = getPaths(api)
    expect(paths.filter(p => p.includes('/me/context'))).toHaveLength(1)
    expect(paths.some(p => p.includes('/resumes/primary') || p.includes('search-terms') || p.includes('/job-types'))).toBe(false)
  })

  it('refetches on a poll so enrichment that lands mid-run is picked up', async () => {
    const { api } = await import('../../../../lib/api')
    const { refreshSearchTerms } = await import('../searchTerms')

    await refreshSearchTerms()
    await refreshSearchTerms(true)

    expect(getPaths(api).filter(p => p.includes('/me/context'))).toHaveLength(2)
  })

})

describe('search terms that are not ready settle instead of staying unchecked', () => {
  const settle = async () => {
    const { refreshSearchTerms } = await import('../searchTerms')
    const { getState } = await import('../automationStore')
    await refreshSearchTerms()
    return getState()
  }

  it('blocks on no-resume when the context has a null resume', async () => {
    contextResume = null
    const state = await settle()

    expect(state.searchTermsReady).toBe(false)
    expect(state.searchTermsBlocker).toBe('no-resume')
    expect(state.logs.some(l => l.includes('No resume found'))).toBe(true)
  })

  it('blocks on preparing while the resume has no search terms yet', async () => {
    contextResume = { resume_text: 'Backend engineer.', search_terms: [] }
    const state = await settle()

    expect(state.searchTermsReady).toBe(false)
    expect(state.searchTermsBlocker).toBe('preparing')
  })

  it('blocks on enrichment-failed when enrichment failed or never started', async () => {
    for (const enrichment_status of ['failed', 'none']) {
      vi.resetModules()
      contextResume = { resume_text: 'Backend engineer.', search_terms: [], enrichment_status }
      const state = await settle()

      expect(state.searchTermsReady).toBe(false)
      expect(state.searchTermsBlocker).toBe('enrichment-failed')
      expect(state.logs.filter(l => l.includes("Couldn't prepare your job search"))).toHaveLength(1)
    }
  })

  it('logs a failed enrichment once across polls', async () => {
    contextResume = { resume_text: 'Backend engineer.', search_terms: [], enrichment_status: 'failed' }
    const { refreshSearchTerms } = await import('../searchTerms')
    const { getState } = await import('../automationStore')
    await refreshSearchTerms()
    await refreshSearchTerms(true)

    expect(getState().logs.filter(l => l.includes("Couldn't prepare your job search"))).toHaveLength(1)
  })

  it('keeps preparing while enrichment is pending', async () => {
    contextResume = { resume_text: 'Backend engineer.', search_terms: [], enrichment_status: 'pending' }
    const state = await settle()

    expect(state.searchTermsBlocker).toBe('preparing')
  })

  it('blocks on unavailable when the context request fails', async () => {
    contextStatus = 500
    const state = await settle()

    expect(state.searchTermsReady).toBe(false)
    expect(state.searchTermsBlocker).toBe('unavailable')
  })

  it('blocks on unavailable when the context request throws', async () => {
    contextThrows = true
    const state = await settle()

    expect(state.searchTermsReady).toBe(false)
    expect(state.searchTermsBlocker).toBe('unavailable')
  })

  it('clears the blocker once search terms arrive', async () => {
    contextResume = { resume_text: 'Backend engineer.', search_terms: [] }
    const { refreshSearchTerms } = await import('../searchTerms')
    const { getState } = await import('../automationStore')
    await refreshSearchTerms()

    contextResume = { resume_text: 'Backend engineer.', search_terms: ['software'] }
    await refreshSearchTerms(true)

    expect(getState().searchTermsReady).toBe(true)
    expect(getState().searchTermsBlocker).toBeNull()
  })
})
