// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
      : { data: { session: null }, error: new Error('refresh token expired') }
  )

const setup = async (...statuses: number[]) => {
  const original = vi.fn<typeof fetch>()
  for (const status of statuses) original.mockResolvedValueOnce(response(status))
  const { wrapFetch } = await import('../FetchError')
  const session = await import('../../../lib/session')
  const shown: string[] = []
  session.onSessionExpired((message) => shown.push(message))
  return { fetch: wrapFetch(original), original, session, shown }
}

const authHeader = (call: Parameters<typeof fetch>) => new Headers(call[1]?.headers).get('Authorization')

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  window.location.hash = '#/automation'
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

  it('remembers the page to return to after signing in, once', async () => {
    renewsTo(null)
    const { fetch, session } = await setup(401)

    await fetch(`${API}/me/context`)

    expect(session.takeReturnTo()).toBe('/automation')
    expect(session.takeReturnTo()).toBeNull()
  })

  it('keeps the saved page when a later request fails from the login screen', async () => {
    renewsTo(null)
    const { fetch, session } = await setup(401, 401)

    await fetch(`${API}/a`)
    window.location.hash = '#/login'
    await fetch(`${API}/b`)

    expect(session.takeReturnTo()).toBe('/automation')
  })

  it("doesn't return to an auth or error page", async () => {
    renewsTo(null)
    window.location.hash = '#/onboarding'
    const { fetch, session } = await setup(401)

    await fetch(`${API}/me/context`)

    expect(session.takeReturnTo()).toBeNull()
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
