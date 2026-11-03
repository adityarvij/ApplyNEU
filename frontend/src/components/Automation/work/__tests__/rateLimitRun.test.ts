import { beforeEach, describe, expect, it, vi } from 'vitest'

const polls = vi.hoisted(() => ({ queue: [] as Record<string, unknown>[] }))

vi.mock('../../../../lib/supabase', () => ({ getUserId: async () => 'user-1' }))
vi.mock('../../../../lib/api', () => {
  const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => '' })
  return {
    api: {
      get: vi.fn(async (path: string) => {
        if (path.includes('/me/context')) return json({
          resume: { resume_text: 'Backend engineer.', search_terms: ['software', 'backend'] },
          preferences: { job_match: 'medium', wait_for_approval: false, job_types: ['Co-op'], unpaid_roles: false, recent_jobs: true, interests: [] },
          profile: { grad_year: 2027 },
        })
        if (path.includes('/jobs/analyze/')) return json({ run_id: 'r1', ...(polls.queue.shift() ?? { status: 'done', decision: 'APPLY', employer_instructions: [] }) })
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
  polls.queue = []
  ;(globalThis as any).AudioContext = class {
    currentTime = 0
    destination = {}
    createOscillator() { return { connect() {}, frequency: {}, type: '', start() {}, stop() {} } }
    createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } } }
  }
})

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

  const calls = (api.post as any).mock.calls as any[][]
  return {
    logs: getState().logs,
    status: getState().status,
    analyzed: calls.filter(c => c[0].includes('/jobs/analyze')).length,
    cancelled: calls.filter(c => c[0].includes('/me/agents/r1/cancel')).length,
    applications: calls.filter(c => c[0].includes('/applications')).length,
  }
}

describe('model call rate limit during a run', () => {
  it('cancels the run and stops with a clear message when the daily limit is hit', async () => {
    polls.queue = [{ status: 'queued', retry_after: 32400 }]

    const { logs, status, analyzed, applications, cancelled } = await run()

    expect(analyzed).toBe(1)
    expect(cancelled).toBe(1)
    expect(applications).toBe(0)
    expect(status).toBe('idle')
    expect(logs.some(l => l.includes('Daily review limit reached. Stopping run. You can start again in about 9h.'))).toBe(true)
    expect(logs.some(l => l.includes('Decision request failed'))).toBe(false)
    expect(logs.some(l => l.includes('Completed running search terms.'))).toBe(false)
  })

  it('waits out a short limit on the same run instead of skipping the job', async () => {
    polls.queue = [{ status: 'queued', retry_after: 30 }]

    const { logs, analyzed, applications, cancelled } = await run()

    expect(analyzed).toBe(1)
    expect(cancelled).toBe(0)
    expect(applications).toBeGreaterThan(0)
    expect(logs.some(l => l.includes('Rate limited. Waiting 30s before retrying...'))).toBe(true)
    expect(logs.some(l => l.includes('Decision request failed'))).toBe(false)
  })
})

describe('agent slots during a run', () => {
  it('stalls the sweep while the run is queued and applies once it finishes', async () => {
    polls.queue = [{ status: 'queued', retry_after: null }, { status: 'running' }]

    const { logs, analyzed, applications } = await run()

    expect(analyzed).toBe(1)
    expect(applications).toBeGreaterThan(0)
    expect(logs.filter(l => l.includes('All your agents are busy. Waiting for one to free up...'))).toHaveLength(1)
  })

  it('skips the job when its run fails', async () => {
    polls.queue = [{ status: 'failed' }]

    const { logs, applications } = await run()

    expect(applications).toBe(0)
    expect(logs.some(l => l.includes('Decision request failed; skipping.'))).toBe(true)
  })
})
