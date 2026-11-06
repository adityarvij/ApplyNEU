// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js'

const signOut = vi.fn(async () => ({ error: null }))
const refreshSession = vi.fn()
const navigateTo = vi.fn()

vi.mock('../../../lib/supabase', () => ({ supabase: { auth: { signOut, refreshSession } } }))
vi.mock('../../../lib/navigation', () => ({ navigateTo }))

const API = 'http://localhost:8080'
const response = (status: number) => ({ status, ok: status < 400, statusText: '' }) as Response

const renewsTo = (token: string | null) =>
  refreshSession.mockResolvedValue(
    token
      ? { data: { session: { access_token: token } }, error: null }
      : { data: { session: null }, error: new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found') }
  )

const setup = async (...statuses: number[]) => {
  const original = vi.fn<typeof fetch>()
  for (const status of statuses) original.mockResolvedValueOnce(response(status))
  const { wrapFetch } = await import('../FetchError')
  const { onSessionExpired } = await import('../../../lib/session')
  const shown: string[] = []
  onSessionExpired((message) => shown.push(message))
  return { fetch: wrapFetch(original), original, shown }
}

const authHeader = (call: Parameters<typeof fetch>) => new Headers(call[1]?.headers).get('Authorization')

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('a 401 from the backend', () => {
  it('retries once with a renewed token and keeps the user signed in', async () => {
    renewsTo('fresh-token')
    const { fetch, original } = await setup(401, 200)

    const res = await fetch(`${API}/me/context`, { headers: { Authorization: 'Bearer stale-token' } })

    expect(res.status).toBe(200)
    expect(original).toHaveBeenCalledTimes(2)
    expect(authHeader(original.mock.calls[1])).toBe('Bearer fresh-token')
    expect(signOut).not.toHaveBeenCalled()
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it('sends the user to login with a message when the session cannot be renewed', async () => {
    renewsTo(null)
    const { fetch, original, shown } = await setup(401)

    const res = await fetch(`${API}/me/context`)

    expect(res.status).toBe(401)
    expect(original).toHaveBeenCalledTimes(1)
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true })
    expect(shown).toEqual(['your session expired. please sign in again.'])
  })

  it('sends the user to login when the retry is rejected too', async () => {
    renewsTo('fresh-token')
    const { fetch, original } = await setup(401, 401)

    await fetch(`${API}/me/context`)

    expect(original).toHaveBeenCalledTimes(2)
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true })
  })

  it('signs out once when several requests fail together', async () => {
    renewsTo(null)
    const { fetch } = await setup(401, 401, 401)

    await Promise.all([fetch(`${API}/a`), fetch(`${API}/b`), fetch(`${API}/c`)])

    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it("keeps the user signed in when the refresh can't reach Supabase", async () => {
    refreshSession.mockResolvedValue({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) })
    const { fetch, original } = await setup(401)

    const res = await fetch(`${API}/me/context`)

    expect(res.status).toBe(401)
    expect(original).toHaveBeenCalledTimes(1)
    expect(signOut).not.toHaveBeenCalled()
  })

  it("keeps the user signed in when the retry can't be verified either", async () => {
    renewsTo('fresh-token')
    const { fetch } = await setup(401, 503)

    const res = await fetch(`${API}/me/context`)

    expect(res.status).toBe(503)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('leaves non-backend requests alone', async () => {
    const { fetch, original } = await setup(401)

    const res = await fetch('https://example.supabase.co/auth/v1/user')

    expect(res.status).toBe(401)
    expect(refreshSession).not.toHaveBeenCalled()
    expect(signOut).not.toHaveBeenCalled()
    expect(original).toHaveBeenCalledTimes(1)
  })
})
