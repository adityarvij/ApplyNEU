import { suppressErrorRedirect, releaseErrorRedirect } from '../../../lib/fetchErrorControl'

// The run's observable state, split out from the run itself so that everything the
// run delegates to -- symplicity/*, and whatever else moves out next -- can log and
// read status without importing automationRun and forming a cycle back into it.

export type RunStatus = 'idle' | 'running' | 'paused' | 'error'

export type SearchTermsBlocker = 'no-resume' | 'preparing' | 'enrichment-failed' | 'unavailable'

export type AutomationState = {
  status: RunStatus
  logs: string[]
  awaitingInput: boolean
  approvalPrompt: { jobTitle: string; company: string } | null
  handoffPrompt: { reason: string } | null
  searchTerms: string[]
  // null = still checking, false = blocked (see searchTermsBlocker), true = ready.
  searchTermsReady: boolean | null
  searchTermsBlocker: SearchTermsBlocker | null
}

// Held for as long as a run is active, so a background run's fetch failures can't
// hijack whatever page the user navigated to.
const RUN_SUPPRESSOR = 'automation-run'

let state: AutomationState = {
  status: 'idle',
  logs: [],
  awaitingInput: false,
  approvalPrompt: null,
  handoffPrompt: null,
  searchTerms: [],
  searchTermsReady: null,
  searchTermsBlocker: null,
}

const listeners = new Set<() => void>()

export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// useSyncExternalStore compares by reference, so setState must replace the object.
export const getState = () => state

export const setState = (patch: Partial<AutomationState>) => {
  state = { ...state, ...patch }
  listeners.forEach(listener => listener())
}

export const setStatus = (status: RunStatus) => {
  setState({ status })
  if (status === 'running' || status === 'paused') suppressErrorRedirect(RUN_SUPPRESSOR)
  else releaseErrorRedirect(RUN_SUPPRESSOR)
}

export const addLog = (message: string) => {
  const timestamp = new Date().toLocaleTimeString()
  setState({ logs: [...state.logs, `[${timestamp}] ${message}`] })
}
