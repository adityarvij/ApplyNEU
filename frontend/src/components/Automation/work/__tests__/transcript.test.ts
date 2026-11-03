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

const runWith = async (transcriptAnswers: Answer[]) => {
  const { fakeWebview } = await import('./fakeWebview')
  const { reachesOneJob } = await import('./scenario')
  const { setAutomationWebview } = await import('../automationWebview')
  const { refreshSearchTerms } = await import('../searchTerms')
  const { start } = await import('../automationRun')
  const { api } = await import('../../../../lib/api')

  const view = fakeWebview([
    { match: 'quicksearch-field', result: true },
    ...transcriptAnswers,
    ...reachesOneJob(),
  ])
  setAutomationWebview(view)
  await refreshSearchTerms()
  await start()

  const taskPosts = (api.post as any).mock.calls.filter((c: any[]) => c[0].includes('/tasks'))
  return { view, taskPosts, unmatched: view.unmatched }
}

describe('transcript detection', () => {
  // The probe and the option-reader are two different scripts against the same
  // <select>, so a scenario has to answer them separately.
  const probe = (result: unknown): Answer => ({ match: 'hasSelect: !!sel, hasButton', result })
  const options = (result: unknown): Answer => ({ match: 'hasOptions: options.length', result })

  it('raises an upload task when only the "add a new transcript" button is present', async () => {
    const { taskPosts, unmatched } = await runWith([probe({ hasSelect: false, hasButton: true })])

    expect(unmatched).toEqual([])
    expect(taskPosts).toHaveLength(1)
    expect(taskPosts[0][1].text).toBe('Upload Acme transcript')
  })

  it('fills the dropdown and raises no task when a transcript is on file', async () => {
    const { taskPosts, unmatched } = await runWith([
      probe({ hasSelect: true, hasButton: false }),
      options({ found: true, hasOptions: true, options: [{ value: 't1', text: 'Transcript.pdf' }] }),
      { match: 'sel.options || [])[0]', result: true },
    ])

    expect(unmatched).toEqual([])
    expect(taskPosts).toEqual([])
  })

  it('raises a task when the dropdown exists but is empty', async () => {
    const { taskPosts } = await runWith([
      probe({ hasSelect: true, hasButton: false }),
      options({ found: true, hasOptions: false, options: [] }),
    ])

    expect(taskPosts).toHaveLength(1)
    expect(taskPosts[0][1].text).toBe('Upload Acme transcript')
  })

  it('raises no task when the job asks for no transcript at all', async () => {
    const { taskPosts } = await runWith([probe({ hasSelect: false, hasButton: false })])

    expect(taskPosts).toEqual([])
  })
})
