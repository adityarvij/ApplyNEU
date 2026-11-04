import { supabase } from './supabase'
import { navigateTo } from './navigation'

export const SESSION_EXPIRED_MESSAGE = 'your session expired. please sign in again.'

// Pages that aren't worth coming back to after signing in again.
const NO_RETURN = ['/login', '/signup', '/onboarding', '/401', '/404', '/500', '/error']

let returnTo: string | null = null
let expiring = false
let showMessage: ((message: string) => void) | null = null

/** Lets App show the expiry message on the login screen. */
export const onSessionExpired = (fn: (message: string) => void) => {
  showMessage = fn
}

/**
 * Signs the user out and sends them to login with a message, remembering the page
 * they were on so signing back in returns there. A burst of failing requests all
 * call this; only the first one acts.
 */
export const expireSession = async () => {
  if (expiring) return
  expiring = true
  try {
    const path = window.location.hash.slice(1) || '/'
    // A late failure that lands on /login must not wipe the page an earlier one saved.
    if (!NO_RETURN.some((p) => path.startsWith(p))) returnTo = path
    showMessage?.(SESSION_EXPIRED_MESSAGE)
    await supabase.auth.signOut()
    navigateTo('/login', { replace: true })
  } finally {
    expiring = false
  }
}

/** The page to go back to after signing in again, once. */
export const takeReturnTo = () => {
  const path = returnTo
  returnTo = null
  return path
}

/**
 * Renews the session after the backend rejected its token.
 * @returns the new access token, or null when the session can't be renewed
 */
export const refreshAccessToken = async () => {
  try {
    const { data, error } = await supabase.auth.refreshSession()
    if (error) return null
    return data.session?.access_token ?? null
  } catch {
    return null
  }
}
