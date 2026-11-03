import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import './automation.css'
import { suppressErrorRedirect, releaseErrorRedirect } from '../../lib/fetchErrorControl'
import { getState, subscribe, type SearchTermsBlocker } from './work/automationStore'
import { approve, continueAfterHandoff } from './work/approval'
import { refreshSearchTerms } from './work/searchTerms'
import { ensureGreeted, pause, resume, start } from './work/automationRun'

// A run holds its own key for as long as it lasts (see automationRun).
const SCREEN_SUPPRESSOR = 'automation-screen'

const POLL_MIN_MS = 4000
const POLL_MAX_MS = 30000

const BLOCKED_TITLES: Record<SearchTermsBlocker, string> = {
  'no-resume': 'Upload a resume to start',
  preparing: 'Preparing your job search…',
  'enrichment-failed': "Couldn't prepare your job search",
  unavailable: "Couldn't load your job search. Retrying…",
}

/**
 * A view of a run, not its owner -- status, logs, prompts and the loop itself live
 * in the automationRun singleton, so navigating away leaves the run untouched.
 */
export default function Automation() {
  const { status, logs, approvalPrompt, handoffPrompt, searchTermsReady, searchTermsBlocker } =
    useSyncExternalStore(subscribe, getState)
  const navigate = useNavigate()
  const [isPanelOpen, setIsPanelOpen] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  // Screen-scoped: the search-term polling below logs to the console pane instead
  // of bouncing to /error.
  useEffect(() => {
    suppressErrorRedirect(SCREEN_SUPPRESSOR)
    return () => releaseErrorRedirect(SCREEN_SUPPRESSOR)
  }, [])

  useEffect(() => {
    ensureGreeted()
    refreshSearchTerms()
  }, [])

  // Until search terms exist, poll so the screen unlocks automatically once the
  // resume-enrichment worker finishes (a few seconds after onboarding submit).
  // Screen-scoped on purpose: a run already has the terms it started with.
  // Backs off and pauses while hidden so a stalled enrichment does not spin.
  useEffect(() => {
    // A failed enrichment won't fill the terms in by itself; the retry lives in Settings.
    if (searchTermsReady === true || searchTermsBlocker === 'enrichment-failed') return
    let timer: ReturnType<typeof setTimeout>
    let delay = POLL_MIN_MS
    let stopped = false

    const tick = async () => {
      if (stopped) return
      if (document.visibilityState === 'visible') {
        await refreshSearchTerms(true)
        delay = Math.min(delay * 1.5, POLL_MAX_MS)
      }
      if (!stopped) timer = setTimeout(tick, delay)
    }

    const onVisible = () => {
      if (document.visibilityState !== 'visible' || stopped) return
      clearTimeout(timer)
      delay = POLL_MIN_MS
      tick()
    }

    timer = setTimeout(tick, delay)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [searchTermsReady, searchTermsBlocker])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const togglePanel = () => setIsPanelOpen(!isPanelOpen)

  return (
    <div className="automation-container">
      <div className="automation-header-row">
        {logs.length > 0 ? (
          <h1 className="automation-title">{logs[logs.length - 1].replace(/\[\d+:\d+:\d+ [AP]M\] /, '')}</h1>
        ) : (
          <h1 className="automation-title">automation</h1>
        )}
        <div className="header-controls">
          {status === 'running' ? (
            <button className="automation-pause-btn" title="Pause" onClick={pause}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="4" width="4" height="16"></rect>
                <rect x="14" y="4" width="4" height="16"></rect>
              </svg>
            </button>
          ) : status === 'paused' ? (
            <button className="automation-play-btn" title="Resume" onClick={resume}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </button>
          ) : (
            <button
              className="automation-play-btn"
              title={searchTermsReady === true ? 'Play' : BLOCKED_TITLES[searchTermsBlocker ?? 'preparing']}
              onClick={start}
              disabled={searchTermsReady !== true}
              style={searchTermsReady !== true ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </button>
          )}
          <button className="automation-menu-btn" title="Menu" onClick={togglePanel}>
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="8" x2="20" y2="8" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="16" x2="14" y2="16" />
            </svg>
          </button>
        </div>
      </div>
      {searchTermsReady === null && (
        <div className="automation-loading-screen" role="status" aria-label="loading">
          <div className="automation-loading-spinner" aria-hidden="true" />
        </div>
      )}
      {searchTermsBlocker === 'enrichment-failed' && (
        <div className="handoff-banner" role="alert">
          <div className="approval-text">
            <p className="approval-label">job search not ready</p>
            <p className="approval-job">Couldn't prepare your job search</p>
            <p className="approval-company">We couldn't get search terms from your resume. Retry it to start.</p>
          </div>
          <button
            type="button"
            className="handoff-btn"
            onClick={() => navigate('/settings/resumes')}
          >
            retry
          </button>
        </div>
      )}
      {handoffPrompt && (
        <div className="handoff-banner" role="alert" aria-live="assertive">
          <div className="approval-text">
            <p className="approval-label">your help needed</p>
            <p className="approval-job">Page not recognized</p>
            <p className="approval-company">{handoffPrompt.reason}</p>
          </div>
          <button
            type="button"
            className="handoff-btn"
            onClick={continueAfterHandoff}
          >
            continue
          </button>
        </div>
      )}
      {approvalPrompt && (
        <div className="approval-banner" role="alert" aria-live="assertive">
          <div className="approval-text">
            <p className="approval-label">approval needed</p>
            <p className="approval-job">{approvalPrompt.jobTitle || 'Untitled job'}</p>
            <p className="approval-company">{approvalPrompt.company || 'Unknown company'}</p>
          </div>
          <div className="approval-actions">
            <button
              type="button"
              className="approval-btn approval-btn--yes"
              onClick={() => approve(true)}
              aria-label="Approve applying to this job"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </button>
            <button
              type="button"
              className="approval-btn approval-btn--no"
              onClick={() => approve(false)}
              aria-label="Skip this job"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
      )}
      {/* The browser and its interaction blocker are <AutomationBrowser>, positioned
          over this screen's content box from above the route tree. */}
      <div className={`right-panel ${isPanelOpen ? 'open' : ''}`}>
        <div className="panel-header">
          <button className="panel-close-btn" onClick={togglePanel}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div className="panel-content">
          <div className="console-logs">
            {logs.map((log, index) => (
              <div key={index} className="console-log-entry">
                {log}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>
    </div>
  )
}
