import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Answer } from './fakeWebview'

vi.mock('../../../../lib/supabase', () => ({ getUserId: async () => 'user-1' }))
vi.mock('../../../../lib/api', () => {
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' })
  return {
    api: {
      get: vi.fn(async (path: string) => {
        if (path.includes('/me/context')) return json({
          resume: { resume_text: 'Backend engineer.', search_terms: ['software'] },
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

// NUWorks offers "add a new resume" instead of a resume picker, which routes the
// loop down the hasButton branch.
const noResumeOnFile: Answer[] = [
  { match: 'hasLabel: !!label', result: { hasLabel: true, hasSelect: false, hasButton: true } },
  { match: 'button[id*="formfield"][id*="resume"]', result: true },
  { match: "'save') && !b.disabled && visible", result: true },
  { match: 'hasSelect: !!sel, hasButton', result: { hasSelect: false, hasButton: false } },
]

const run = async (extra: Answer[] = []) => {
  const { fakeWebview } = await import('./fakeWebview')
  const { reachesOneJob } = await import('./scenario')
  const { setAutomationWebview } = await import('../automationWebview')
  const { refreshSearchTerms } = await import('../searchTerms')
  const { start } = await import('../automationRun')
  const { api } = await import('../../../../lib/api')

  const view = fakeWebview([
    { match: 'quicksearch-field', result: true },
    ...extra,
    ...noResumeOnFile,
    ...reachesOneJob(),
  ])
  setAutomationWebview(view)
  await refreshSearchTerms()
  await start()

  return {
    view,
    tasks: (api.post as any).mock.calls
      .filter((c: any[]) => c[0].includes('/tasks'))
      .map((c: any[]) => c[1].text),
    applications: (api.post as any).mock.calls
      .filter((c: any[]) => c[0].includes('/applications'))
      .map((c: any[]) => c[1].status),
  }
}

describe('no resume on file (the add-a-new-resume branch)', () => {
  it('raises no document tasks for a job that asks for no extra documents', async () => {
    const { tasks, view } = await run()

    expect(view.unmatched).toEqual([])
    expect(tasks).toEqual([])
  })

  it('raises a task and records a draft when no work sample matches the company', async () => {
    const { tasks, applications } = await run([
      {
        match: 'hasSelect: !!sel, options: opts',
        result: { hasSelect: true, options: [{ text: 'OtherCorp writing sample', value: 'w1' }], hasButton: false },
      },
      { match: 'hasCheckboxes: checkboxes.length', result: { hasCheckboxes: false, hasButton: false } },
    ])

    expect(tasks).toEqual(['Upload Acme work sample'])
    expect(applications).toEqual(['draft'])
  })

  it('still raises tasks for documents the employer does ask for', async () => {
    const { tasks } = await run([
      { match: 'hasSelect: !!sel, options: opts', result: { hasSelect: false, options: [], hasButton: true } },
      { match: 'hasCheckboxes: checkboxes.length', result: { hasCheckboxes: false, hasButton: true } },
    ])

    expect(tasks).toEqual(['Upload Acme work sample', 'Upload Acme portfolio'])
  })
})
