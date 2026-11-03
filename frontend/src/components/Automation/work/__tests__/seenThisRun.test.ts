import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../lib/supabase', () => ({ getUserId: async () => 'user-1' }))
vi.mock('../../../../lib/api', () => {
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' })
  return {
    api: {
      get: vi.fn(async (path: string) => {
        if (path.includes('/me/context')) return json({
          resume: { resume_text: 'Backend engineer.', search_terms: ['software', 'backend'] },
          preferences: { job_match: 'medium', wait_for_approval: false, job_types: ['Co-op'], unpaid_roles: false, recent_jobs: true, interests: [] },
          profile: { grad_year: 2027 },
        })
        if (path.includes('/jobs/analyze/')) return json({ run_id: 'r1', status: 'done', decision: 'APPLY', employer_instructions: [] })
        if (path.includes('/tasks')) return json([])
        return json({})
      }),
      post: vi.fn(async (path: string) => {
        if (path.includes('/jobs/add')) return json({ job_id: 'j1' })
        if (path.includes('/jobs/analyze')) return json({ run_id: 'r1', status: 'queued' })
        if (path.includes('/applications')) return json({ application_id: 'a1' })
        return json({})
      }),
      del: vi.fn(async () => json({})),
    },
  }
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  ;(globalThis as any).AudioContext = class {
    currentTime = 0
    destination = {}
    createOscillator() { return { connect() {}, frequency: {}, type: '', start() {}, stop() {} } }
    createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } } }
  }
})

// Both search terms surface the same single card, so the second pass is a repeat.
const run = async () => {
  const { fakeWebview } = await import('./fakeWebview')
  const { reachesOneJob } = await import('./scenario')
  const { setAutomationWebview } = await import('../automationWebview')
  const { refreshSearchTerms } = await import('../searchTerms')
  const { start } = await import('../automationRun')
  const { getState } = await import('../automationStore')
  const { api } = await import('../../../../lib/api')

  const view = fakeWebview([
    { match: 'quicksearch-field', result: true },
    { match: 'hasLabel: !!label', result: { hasLabel: true, hasSelect: false, hasButton: true } },
    { match: 'button[id*="formfield"][id*="resume"]', result: true },
    { match: "'save') && !b.disabled && visible", result: true },
    { match: 'hasSelect: !!sel, hasButton', result: { hasSelect: false, hasButton: false } },
    ...reachesOneJob(),
  ])
  setAutomationWebview(view)
  await refreshSearchTerms()
  await start()

  return {
    view,
    logs: getState().logs,
    analyzed: (api.post as any).mock.calls.filter((c: any[]) => c[0].includes('/jobs/analyze')).length,
  }
}

describe('a posting that surfaces under two search terms', () => {
  it('clicks it once and skips the repeat before the detail page loads', async () => {
    const { view, logs, analyzed } = await run()

    expect(view.unmatched).toEqual([])
    expect(view.hits.get('const cardIndex =')).toBe(1)
    expect(analyzed).toBe(1)
    expect(logs.filter(l => l.includes('ALREADY SEEN THIS RUN'))).toHaveLength(1)
  })
})
