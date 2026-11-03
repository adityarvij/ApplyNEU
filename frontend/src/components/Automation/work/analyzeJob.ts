import { api } from '../../../lib/api'
import { addLog } from './automationStore'
import { sleep } from './pacing'
import { formatWait, MAX_WAIT_SECONDS, retryAfterSeconds } from './rateLimit'

const POLL_MS = 2000
const SETTLED = ['done', 'waiting_for_you']
const ENDED = ['failed', 'cancelled', 'handed_off']

export type JobAnalysis =
  | { ok: true; data: { decision?: string; employer_instructions?: unknown; [key: string]: unknown } }
  | { ok: false; status: number; retryAfter?: number }

/**
 * Queues the posting's analysis and waits until the backend's agent has run it. The run waits
 * for one of the user's agent slots, so the sweep stalls here while their agents are busy. A
 * rate limit short enough to sit through is waited out; a longer one cancels the run and comes
 * back as a 429 so the caller can stop.
 */
export const analyzeJob = async (body: { job_description: string; company: string; title: string }): Promise<JobAnalysis> => {
  const resp = await api.post('/me/jobs/analyze', body)
  if (!resp.ok) return { ok: false, status: resp.status, retryAfter: retryAfterSeconds(resp) }
  const { run_id } = await resp.json()

  let loggedBusy = false
  let loggedLimit = false
  while (true) {
    const poll = await api.get(`/me/jobs/analyze/${run_id}`)
    if (!poll.ok) return { ok: false, status: poll.status }
    const data = await poll.json()
    if (SETTLED.includes(data.status)) return { ok: true, data }
    if (ENDED.includes(data.status)) return { ok: false, status: 500 }

    if (typeof data.retry_after === 'number') {
      if (data.retry_after > MAX_WAIT_SECONDS) {
        await api.post(`/me/agents/${run_id}/cancel`).catch(() => null)
        return { ok: false, status: 429, retryAfter: data.retry_after }
      }
      if (!loggedLimit) addLog(`Rate limited. Waiting ${formatWait(data.retry_after)} before retrying...`)
      loggedLimit = true
    } else if (data.status === 'queued' && !loggedBusy) {
      addLog('All your agents are busy. Waiting for one to free up...')
      loggedBusy = true
    }
    await sleep(POLL_MS)
  }
}
