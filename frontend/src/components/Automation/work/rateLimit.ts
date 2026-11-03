import { api } from '../../../lib/api'
import { addLog } from './automationStore'
import { sleep } from './pacing'

export const MAX_WAIT_SECONDS = 300
const MAX_ATTEMPTS = 3
const DEFAULT_RETRY_AFTER_SECONDS = 60

export const retryAfterSeconds = (resp: Response) => {
  const header = resp.headers?.get('Retry-After')
  const seconds = header ? Number(header) : NaN
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS
}

export const formatWait = (seconds: number) => {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`
  return `${Math.ceil(seconds / 3600)}h`
}

/**
 * POSTs and waits out a short 429 before trying again. Returns the 429 itself when the
 * wait is too long to sit through (the daily limit) or the limit keeps tripping, so the
 * caller decides what to tell the user.
 */
export const postWithRateLimit = async (path: string, body: unknown): Promise<Response> => {
  for (let attempt = 1; ; attempt++) {
    const resp = await api.post(path, body)
    if (resp.status !== 429) return resp

    const wait = retryAfterSeconds(resp)
    if (wait > MAX_WAIT_SECONDS || attempt >= MAX_ATTEMPTS) return resp

    addLog(`Rate limited. Waiting ${formatWait(wait)} before retrying...`)
    await sleep(wait * 1000)
  }
}
