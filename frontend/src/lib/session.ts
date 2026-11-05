import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { navigateTo } from './navigation'

export const SESSION_EXPIRED_MESSAGE = 'your session expired. please sign in again.'

let expiring = false
let showMessage: ((message: string) => void) | null = null

/** Lets App show the expiry message on the login screen. */
export const onSessionExpired = (fn: (message: string) => void) => {
  showMessage = fn
}

/**
 * Signs the user out and sends them to login with a message. A burst of failing
 * requests all call this; only the first one acts.
 */
export const expireSession = async () => {
  if (expiring) return
  expiring = true
  try {
    showMessage?.(SESSION_EXPIRED_MESSAGE)
    await supabase.auth.signOut()
    navigateTo('/login', { replace: true })
  } finally {
    expiring = false
  }
}

export type RefreshResult =
  | { status: 'renewed'; token: string }
  | { status: 'expired' }
  | { status: 'unreachable' }

/**
 * Renews the session after the backend rejected its token. Only a refresh Supabase
 * actually refused means the session is over; failing to reach Supabase doesn't.
 */
export const refreshAccessToken = async (): Promise<RefreshResult> => {
  try {
    const { data, error } = await supabase.auth.refreshSession()
    if (error) return isAuthRetryableFetchError(error) ? { status: 'unreachable' } : { status: 'expired' }
    const token = data.session?.access_token
    return token ? { status: 'renewed', token } : { status: 'expired' }
  } catch {
    return { status: 'unreachable' }
  }
}
