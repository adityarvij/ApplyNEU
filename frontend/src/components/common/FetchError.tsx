import { useEffect } from 'react'
import { navigateTo } from '../../lib/navigation'
import { isErrorRedirectSuppressed } from '../../lib/fetchErrorControl'
import { expireSession, refreshAccessToken } from '../../lib/session'

// Only our own backend calls get the global error handling. Third-party fetches
// (Supabase auth, external URLs) manage their own retries/errors, so a transient
// network blip during e.g. getUser() must not hijack the whole app to /error.
const API_BASE = 'http://localhost:8080'

const requestUrl = (input: unknown): string => {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return ''
}

// Avoid stacking duplicate redirects when a burst of requests all fail at once.
const isOnErrorPage = () => {
  const hash = window.location.hash
  return hash.startsWith('#/error')
}

type Fetch = typeof window.fetch

/**
 * Resends a request the backend rejected once, with a renewed token. A token can expire
 * in flight or while the laptop sleeps without the session being over.
 * @returns the retried response, or null when the session can't be renewed
 */
const retryWithFreshToken = async (originalFetch: Fetch, [input, init]: Parameters<Fetch>) => {
  const token = await refreshAccessToken()
  if (!token) return null
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set('Authorization', `Bearer ${token}`)
  return originalFetch(input, { ...init, headers })
}

/**
 * Wraps fetch so backend calls get the app's error handling: a 401 is retried once with a
 * renewed token and otherwise sends the user to login, and other failures show /error.
 */
export const wrapFetch = (originalFetch: Fetch): Fetch => async (...args) => {
  // Leave non-backend requests (Supabase, external) completely untouched.
  if (!requestUrl(args[0]).startsWith(API_BASE)) {
    return originalFetch(...args)
  }
  try {
    let res = await originalFetch(...args)
    if (res.status === 401) {
      res = (await retryWithFreshToken(originalFetch, args)) ?? res
      // The backend only answers 401 for a missing, invalid or expired token.
      if (res.status === 401) {
        await expireSession()
        return res
      }
    }
    if (!res.ok && !isOnErrorPage() && !isErrorRedirectSuppressed()) {
      // Show a full-page fallback with the received error instead of a banner.
      // Suppressed screens (e.g. Automation) handle/log their own errors.
      navigateTo('/error', { state: { status: res.status, statusText: res.statusText } })
    }
    return res
  } catch (err) {
    if (!isOnErrorPage() && !isErrorRedirectSuppressed()) {
      navigateTo('/error', { state: { message: 'Could not reach the server.' } })
    }
    throw err
  }
}

export const FetchErrorProvider = ({ children }: { children: React.ReactNode }) => {
  useEffect(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = wrapFetch(originalFetch)

    return () => {
      window.fetch = originalFetch
    }
  }, [])

  return <>{children}</>
}
