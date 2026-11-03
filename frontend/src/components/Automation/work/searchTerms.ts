import { getUserId } from '../../../lib/supabase'
import { api } from '../../../lib/api'
import { loadCandidateContext } from './candidateContext'
import { addLog, getState, setState, type SearchTermsBlocker } from './automationStore'
import { setExistingTasks } from '../symplicity/tasks'

const refreshExistingTasks = async () => {
  try {
    const tasksResp = await api.get('/me/tasks')
    if (!tasksResp.ok) return
    const tasksData = await tasksResp.json().catch(() => [])
    const taskKeys = Array.isArray(tasksData)
      ? tasksData
          .map((t: any) => {
            const text = String(t?.text ?? '').trim()
            const appId = t?.application_id ? String(t.application_id) : 'global'
            if (!text) return null
            return `${appId}::${text.toLowerCase()}`
          })
          .filter(Boolean) as string[]
      : []
    setExistingTasks(taskKeys)
  } catch (_err) {
    // ignore
  }
}

const setSearchTerms = (terms: string[], blocker: SearchTermsBlocker | null) => {
  const ready = blocker === null
  const current = getState()
  if (
    current.searchTermsReady === ready &&
    current.searchTermsBlocker === blocker &&
    current.searchTerms.join('\u0000') === terms.join('\u0000')
  ) return
  setState({ searchTerms: terms, searchTermsReady: ready, searchTermsBlocker: blocker })
}

/**
 * Search terms plus the existing-task index a run dedupes against. The screen owns
 * the polling; the data lives here because a run keeps using it once the screen is
 * gone.
 */
export const refreshSearchTerms = async (isPoll = false) => {
  try {
    const userId = await getUserId()
    if (!userId) {
      if (!isPoll) addLog('Error occured: no user found. Retrying...')
      setSearchTerms([], 'unavailable')
      return
    }
    // Polls only need the search terms: the task index is a run-start concern.
    if (!isPoll) await refreshExistingTasks()

    const result = await loadCandidateContext(isPoll)
    if (!result.ok) {
      if (!isPoll) addLog('Error occured. Could not fetch search terms. Retrying...')
      setSearchTerms([], 'unavailable')
      return
    }

    const { resume } = result.context
    if (!resume) {
      if (!isPoll) addLog('No resume found. Upload one to start.')
      setSearchTerms([], 'no-resume')
      return
    }

    const terms: string[] = Array.isArray(resume.search_terms) ? resume.search_terms : []
    if (terms.length > 0) {
      setSearchTerms(terms, null)
      return
    }
    // Only a pending enrichment is still going to fill the terms in. A failed one, or one
    // that never started, waits on a retry from Settings → Resumes.
    const stuck = resume.enrichment_status === 'failed' || resume.enrichment_status === 'none'
    if (stuck && getState().searchTermsBlocker !== 'enrichment-failed') {
      addLog("Couldn't prepare your job search from your resume. Retry it in Settings → Resumes.")
    }
    setSearchTerms([], stuck ? 'enrichment-failed' : 'preparing')
  } catch (_error) {
    if (!isPoll) addLog('Error occured. Could not get search terms.')
    setSearchTerms([], 'unavailable')
  }
}

