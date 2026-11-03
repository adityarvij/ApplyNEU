import {
  waitForSelector, playAlertSound,
  HOME_URL, isHome, waitForHome, waitForWebViewLoad, isInAuthFlow, currentUrl,
  normalizeEmployerInstructions,
} from './automationHelpers'
import { applyPanelFilters } from '../symplicity/filters'
import {
  closeModalIfPresent, waitForDividerSubmissionAndClose, waitForModalOpen,
} from '../symplicity/submission'
import { scrapeJobDescription } from '../symplicity/description'
import { getUserId } from '../../../lib/supabase'
import { api } from '../../../lib/api'
import { ApplicationStatus } from '../../../lib/types'
import { addLog, getState, setState, setStatus } from './automationStore'
import { getAutomationWebview } from './automationWebview'
import type { AutomationWebview } from './automationWebview'
import {
  handleNoCoverLetter, handleNoWorkSample, handleNoPortfolio, handleNoTranscript,
} from '../symplicity/documents'
import { addEmployerTasks, clearTasksForApplication } from '../symplicity/tasks'
import { requestApprovalForJob, withHumanFallback } from './approval'
import { retry, sleep, waitForResume } from './pacing'
import { loadUserPreferences, prefersRecentJobs, allowsUnpaidRoles } from './preferences'
import { loadCandidateContext } from './candidateContext'
import { formatWait, postWithRateLimit } from './rateLimit'
import { analyzeJob } from './analyzeJob'

const jobKey = (company: unknown, title: unknown) =>
  `${String(company ?? '').trim().toLowerCase()}::${String(title ?? '').trim().toLowerCase()}`

let currentJobApplicationId: string | null = null
let clearedTasksForApplication = false
let greeted = false

const logInstructionsLimit = (title: string) =>
  addLog(`Instruction limit reached, so the extra application steps for ${title} were not saved. Check the posting for anything else it asks for.`)

/** StrictMode mounts twice in dev; greet once. */
export const ensureGreeted = () => {
  if (greeted) return
  greeted = true
  addLog('Bot connected...')
}

const runFromDashboard = async (webview: AutomationWebview) => {
  // Saving API calls when search terms overlap
  const seenJobs = new Set<string>()

  const jobCardCount = (): Promise<number> => webview.executeJavaScript(`
    (() => Array.from(document.querySelectorAll('div[id^="list-item-"]')).length)();
  `)
  const waitForJobCards = () => retry(async () => (await jobCardCount()) > 0)

  // Wait for and click the top-nav "Jobs" link
  await withHumanFallback('could not find the Jobs link', async () => {
    const clicked = await webview.executeJavaScript(`
      (() => {
        const link = Array.from(document.querySelectorAll('a'))
          .find(a => (a.textContent || '').trim() === 'Jobs');
        if (!link) return 'missing';
        link.click();
        return 'clicked';
      })();
    `)
    return clicked === 'clicked'
  })

  // Select "Jobs I Qualify For" in the Show Me filter before applying job types
  await retry(async () => {
    const result = await webview.executeJavaScript(`
      (() => {
        const sel =
          document.querySelector('select#single-select-filter') ||
          document.querySelector('select[id*="single-select-filter"]') ||
          document.querySelector('select[name*="show_me"]') ||
          document.querySelector('select[aria-label*="Show Me"]');
        if (!sel) return 'missing';
        sel.scrollIntoView({ behavior: 'instant', block: 'center' });
        const options = Array.from(sel.options || []);
        const target = options.find(o => ((o.innerText || o.textContent || '').trim().toLowerCase().includes('jobs i qualify for')));
        if (!target) return 'no-option';
        sel.value = target.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return 'set';
      })();
    `)
    // 'no-option' means the filter exists but the choice does not; retrying cannot help.
    return result === 'set' || result === 'no-option'
  })

  // Open job type dropdown before searches
  await retry(async () => {
    const result = await webview.executeJavaScript(`
      (() => {
        const btn = document.querySelector('button#listFilter-category-job_type');
        if (!btn) return 'missing';
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        btn.click();
        return 'clicked';
      })();
    `)
    return result === 'clicked'
  })

  // Apply saved job type filters from backend
  await (async () => {
    const userId = await getUserId();
    if (!userId) { addLog('Unable to fetch job types (no user).'); return }
    try {
      const result = await loadCandidateContext()
      if (!result.ok) { addLog('Failed to fetch job types.'); return }
      const jobTypes: string[] = Array.isArray(result.context.preferences?.job_types)
        ? result.context.preferences.job_types
        : []
      if (!jobTypes.length) {
        addLog('No job types set; skipping filters.')
        return
      }
      addLog(`Saved job types: ${jobTypes.join(', ')}`)

      await retry(
        () => webview.executeJavaScript(`!!document.querySelector('input[type="checkbox"][id^="job_type"]')`),
        { attempts: 20, interval: 10 }
      )

      await webview.executeJavaScript(`
        (() => {
          const selections = ${JSON.stringify(jobTypes.map(t => t.toLowerCase()))};
          const cbs = Array.from(document.querySelectorAll('input[type="checkbox"][id^="job_type"]'));
          let matched = 0;
          cbs.forEach(cb => {
            const labelText = (
              (cb.closest('label')?.innerText) ||
              (cb.parentElement?.innerText) ||
              ''
            ).trim().toLowerCase();
            const hit = selections.find(sel => labelText.includes(sel));
            if (hit) {
              if (!cb.checked) cb.click();
              matched++;
            }
          });
          const applyBtn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim().toLowerCase() === 'apply');
          if (applyBtn) {
            applyBtn.click();
          }
          return { matched, applied: !!applyBtn };
        })();
      `)
    } catch (_err) {
      addLog('Error applying job type filters.')
    }
  })()

  // Ensure preferences (e.g., recent jobs) are loaded before filters.
  await loadUserPreferences().catch(() => { })

  // Click "More Filters", then click "Exclude jobs I've applied for", then click Apply.
  const moreFiltersClicked = await webview.executeJavaScript(`
    (() => {
      const el = Array.from(document.querySelectorAll('span.filter-text, button, a')).find(node => {
        const text = (node.innerText || node.textContent || '').trim().toLowerCase();
        return text === 'more filters';
      });
      if (!el) return false;
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      if (typeof el.click === 'function') el.click();
      else el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })();
  `)
  if (moreFiltersClicked) {
    // Wait for more-filters panel to render
    for (let i = 0; i < 60; i++) {
      const panelVisible = await webview.executeJavaScript(`
        (() => {
          const panel = document.querySelector('div#cfEmployersAdvFilters') || document.querySelector('div[id*="EmployersAdvFilters"]');
          if (!panel) return false;
          const style = window.getComputedStyle(panel);
          return style && style.display !== 'none' && style.visibility !== 'hidden';
        })();
      `)
      if (panelVisible) {
        break
      }
      await sleep(100)
    }
    // Wait for and click exclude applied jobs checkbox
    for (let j = 0; j < 60; j++) {
      const checkboxResult = await webview.executeJavaScript(`
        (() => {
          const cb =
            document.querySelector('input[type="checkbox"][id*="exclude_applied_jobs"]') ||
            Array.from(document.querySelectorAll('input[type="checkbox"]')).find(el =>
              ((el.getAttribute('aria-label') || '').toLowerCase().includes("exclude jobs i've applied for"))
            );
          if (!cb) return { found: false, clicked: false, already: false };
          const box = cb;
          const already = !!box.checked;
          if (!box.checked) {
            if (typeof box.click === 'function') box.click();
            else box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return { found: true, clicked: true, already };
          }
          return { found: true, clicked: false, already };
        })();
      `)
      if (checkboxResult?.found) {
        break
      }
      await sleep(100)
    }
    // If user prefers recent jobs, select the "last 7 days" post date filter before applying.
    if (prefersRecentJobs()) {
      for (let j = 0; j < 60; j++) {
        const radioResult = await webview.executeJavaScript(`
          (() => {
            const radios = Array.from(document.querySelectorAll('input[type="radio"][name="postdate"]'));
            const target =
              radios.find(r => (r.getAttribute('value') || '').trim() === '7') ||
              radios.find(r => (r.getAttribute('ng-reflect-value') || '').trim() === '7') ||
              radios.find(r => {
                const id = (r.id || '').toLowerCase();
                const val = (r.getAttribute('value') || '').trim();
                const ngVal = (r.getAttribute('ng-reflect-value') || '').trim();
                return id.includes('postdate') && (val === '7' || ngVal === '7');
              }) ||
              radios.find(r => {
                const labelText = (r.closest('label')?.innerText || '').toLowerCase();
                return labelText.includes('7') || labelText.includes('last 7') || labelText.includes('week');
              });
            if (!target) return { found: false, clicked: false, already: false };
            const already = !!target.checked;
            if (!target.checked) {
              if (typeof target.click === 'function') target.click();
              else target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return { found: true, clicked: true, already };
            }
            return { found: true, clicked: false, already };
          })();
        `)
        if (radioResult?.found) {
          if (radioResult.clicked) {
            addLog('Selected recent jobs filter (last 7 days).')
          } else if (radioResult.already) {
            addLog('Recent jobs filter already selected.')
          }
          break
        }
        if (j === 59) {
          addLog('Recent jobs filter not found; continuing without it.')
        }
        await sleep(100)
      }
    }
    for (let k = 0; k < 120; k++) {
      const applied = await webview.executeJavaScript(`
        (() => {
          const panel = document.querySelector('div#cfEmployersAdvFilters') || document.querySelector('div[id*="EmployersAdvFilters"]');
          const scope = panel || document;
          const btn = Array.from(scope.querySelectorAll('button')).find(b => {
            const text = (b.textContent || '').trim().toLowerCase();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const enabled = !b.disabled && !!b.offsetParent;
            return enabled && (text === 'apply' || aria === 'apply');
          });
          if (!btn) return 'missing';
          btn.scrollIntoView({ behavior: 'instant', block: 'center' });
          if (typeof btn.click === 'function') btn.click();
          else btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return 'clicked';
        })();
      `)
      if (applied === 'clicked') {
        addLog('Applied filters.')
        break
      }
      await sleep(100)
    }
  }

  // Search
  await retry(() => webview.executeJavaScript(`!!document.querySelector('input#jobs-keyword-input')`))

  if (!getState().searchTerms.length) {
    addLog('Error occured. Please try again later.')
    setStatus('idle')
    return
  }

  const normalizedTerms = getState().searchTerms
    .map(term => String(term ?? '').trim())
    .filter(Boolean)

  termLoop: for (const term of normalizedTerms) {
    await waitForResume()
    addLog(`Searching for "${term}"...`)

    await webview.executeJavaScript(`
      (() => {
        const input = document.querySelector('input#jobs-keyword-input');
        if (!input) return { found: false };
        return {
          found: true,
          value: input.value || '',
          placeholder: input.placeholder || ''
        };
      })();
    `)

    const typeResult = await webview.executeJavaScript(`
      (async () => {
        const input = document.querySelector('input#jobs-keyword-input');
        if (!input) return 'missing-input';

        const clearBtn = input.parentElement?.querySelector('button, .clear, .close') || null;
        if (clearBtn && typeof clearBtn.click === 'function') {
          clearBtn.click();
        } else {
          input.value = '';
        }

        input.focus();
        const chars = ${JSON.stringify(term)}.split('');
        for (const ch of chars) {
          input.value = input.value + ch;
          input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: ch }));
          input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          await new Promise(r => setTimeout(r, 40));
        }
        return 'typed';
      })();
    `)

    if (typeResult === 'missing-input') { continue termLoop }

    await webview.executeJavaScript(`
      (() => {
        const input = document.querySelector('input#jobs-keyword-input');
        if (!input) return { found: false };
        return { found: true, value: input.value || '' };
      })();
    `)

    const enterResult = await webview.executeJavaScript(`
      (() => {
        const input = document.querySelector('input#jobs-keyword-input');
        if (!input) return 'missing-input';
        const eventInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true };
        input.dispatchEvent(new KeyboardEvent('keydown', eventInit));
        input.dispatchEvent(new KeyboardEvent('keypress', eventInit));
        input.dispatchEvent(new KeyboardEvent('keyup', eventInit));
        return 'enter-dispatched';
      })();
    `)

    if (enterResult === 'missing-input') {
      continue termLoop
    }

    for (let attempt = 0; attempt < 40; attempt++) {
      const clickResult = await webview.executeJavaScript(`
        (() => {
          const btn =
            document.querySelector('button.btn.btn_alt-default') ||
            document.querySelector('button[type="submit"]') ||
            document.querySelector('button[aria-label="Search"]') ||
            document.querySelector('button:not([disabled])#search-btn') ||
            document.querySelector('button:not([disabled]).btn-search') ||
            Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim().toLowerCase() === 'search');
          if (!btn) return 'missing';
          btn.scrollIntoView({ behavior: 'instant', block: 'center' });
          btn.click();
          return 'clicked';
        })();
      `)

      if (clickResult === 'clicked') {
        break
      }
      await sleep(100)
    }

    await sleep(100)

    let pageIndex = 1
    while (true) {
      await waitForResume()
      await waitForJobCards()

      let jobCount = await jobCardCount()

      if (!jobCount || jobCount <= 0) {
        break
      }

      // Apply panel filters only on first page
      if (pageIndex === 1) {
        await withHumanFallback(
          'could not apply the "exclude jobs I have applied for" filter',
          () => applyPanelFilters(webview)
        )
      }

      // Recount after panel filters
      await waitForJobCards()
      jobCount = await jobCardCount()

      if (!jobCount || jobCount <= 0) {
        addLog(`No job cards found for "${term}".`)
        break
      }

      let consecutiveDoNotApply = 0
      addLog(`${jobCount} jobs found for "${term}" on page ${pageIndex}.`)
      for (let idx = 0; idx < jobCount; idx++) {
        await waitForResume()
        const cardResult = await webview.executeJavaScript(`
          (() => {
            const skipUnpaid = ${JSON.stringify(!allowsUnpaidRoles())};
            const cards = Array.from(document.querySelectorAll('div[id^="list-item-"]'));
            const card = cards[${idx}];
            if (!card) return { status: 'missing' };
            const rawText = card.innerText || card.textContent || '';
            const normalized = rawText.toLowerCase();
            if (skipUnpaid && (normalized.includes('unpaid') || normalized.includes('volunteer'))) {
              return { status: 'skipped', reason: 'unpaid' };
            }
            if (normalized.includes('not qualified')) {
              return { status: 'skipped', reason: 'not qualified' };
            }
            if (normalized.includes('applied')) {
              return { status: 'skipped', reason: 'applied' };
            }
            const pickTitle = () => {
              const preferred =
                card.querySelector('[data-testid="job-title"]') ||
                card.querySelector('.job-title') ||
                card.querySelector('h3, h4') ||
                card.querySelector('[role="link"]');
              const raw = preferred && preferred.textContent ? preferred.textContent : card.innerText || card.textContent || '';
              // Use first non-empty line, then trim common joiners.
              const firstLine = raw
                .split('\\n')
                .map(t => t.trim())
                .find(t => t.length > 0) || '';
              if (!firstLine) return '';
              // If the line contains multiple fields jammed together, split on two or more spaces.
              const splitSpaces = firstLine.split(/\\s{2,}/).find(t => t.length > 0);
              return (splitSpaces || firstLine).trim();
            };
            const title = pickTitle();
            const shortTitle = title.length > 140 ? title.slice(0, 140) + '…' : title;

            const lines = (card.innerText || card.textContent || '')
              .split('\\n')
              .map(t => t.trim())
              .filter(t => t.length > 0);
            const rawCompany = lines.find(l => l !== title) || '';
            const companyName = rawCompany.includes(' - ')
              ? rawCompany.split(' - ')[0].trim()
              : rawCompany;
            const displayTitle = companyName ? \`\${shortTitle} @ \${companyName}\` : shortTitle;

            return { status: 'eligible', title: shortTitle, company: companyName, displayTitle };
          })();
        `)

        let clickJobResult = cardResult

        if (cardResult?.status === 'eligible') {
          const key = jobKey(cardResult.company, cardResult.title)
          if (seenJobs.has(key)) {
            clickJobResult = { status: 'skipped', reason: 'seen this run', displayTitle: cardResult.displayTitle }
          } else {
            seenJobs.add(key)
            const clicked = await webview.executeJavaScript(`
              (() => {
                const cardIndex = ${idx};
                const cards = Array.from(document.querySelectorAll('div[id^="list-item-"]'));
                const card = cards[cardIndex];
                if (!card) return 'missing';
                card.scrollIntoView({ behavior: 'instant', block: 'center' });
                if (typeof card.click === 'function') {
                  card.click();
                } else {
                  card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                }
                return 'clicked';
              })();
            `)
            clickJobResult = clicked === 'clicked'
              ? { ...cardResult, status: 'clicked' }
              : { status: 'missing' }
          }
        }

        if (clickJobResult?.status === 'clicked') {
          currentJobApplicationId = null
          clearedTasksForApplication = false
          const titleStr = clickJobResult.displayTitle || clickJobResult.title || 'Untitled job';
          const companyLower = (clickJobResult.company || (() => {
            const atIdx = titleStr.indexOf('@');
            if (atIdx !== -1) return titleStr.slice(atIdx + 1);
            return '';
          })()).toString().toLowerCase().trim();
          await sleep(100)
          const descResult = await scrapeJobDescription(webview)

          // Send description to backend for decision and optionally apply
          try {
            const companyName = (clickJobResult.company || '').trim()
            const jobTitle = (clickJobResult.title || '').trim()
            const jobDescription = (descResult || '').toString()

            if (!companyName || !jobTitle || !jobDescription.trim()) {
              consecutiveDoNotApply = 0
              addLog('Error: missing information. Skipping...')
              continue
            }

            const addJobResp = await api.post(`/jobs/add`, {
              company: companyName,
              title: jobTitle,
              description: jobDescription
            })
            let addedJobId: string | null = null
            if (!addJobResp.ok) {
              addLog('Server error.')
            } else {
              const addedJob = await addJobResp.json().catch(() => null)
              addedJobId = addedJob?.job_id ?? addedJob?.id ?? null
            }
            const userId = await getUserId()
            if (!userId) {
              addLog('Decision skipped (no user).')
            } else {
              addLog(`Reviewing ${titleStr}...`)
              const analysis = await analyzeJob({
                job_description: descResult || '',
                company: companyName,
                title: jobTitle
              })
              if (analysis.ok) {
                const { data } = analysis
                const instructions = normalizeEmployerInstructions(data?.employer_instructions)
                void instructions
                if (data.decision === 'APPLY') {
                  consecutiveDoNotApply = 0
                  addLog(`Decision: apply.`)
                  let applicationRecordedStatus: ApplicationStatus | null = null
                  let pendingModalInstructionText: string | null = null
                  const recordApplication = async (status: ApplicationStatus) => {
                    const userIdForApplication = await getUserId()
                    if (!userIdForApplication) return currentJobApplicationId
                    if (applicationRecordedStatus === status && currentJobApplicationId) {
                      return currentJobApplicationId
                    }
                    if (!addedJobId) {
                      addLog('Unable to record application (missing job).')
                      return currentJobApplicationId
                    }
                    const applicationPayload = {
                      job_id: addedJobId,
                      status
                    }
                    try {
                      const resp = await api.post('/me/applications/new', applicationPayload)
                      if (resp.ok) {
                        const data = await resp.json().catch(() => ({}))
                        const applicationId =
                          data?.application_id ??
                          data?.id ??
                          data?.jobApplicationId ??
                          null
                        if (applicationId) {
                          currentJobApplicationId = String(applicationId)
                        }
                        applicationRecordedStatus = status
                        if (currentJobApplicationId && !clearedTasksForApplication) {
                          await clearTasksForApplication(currentJobApplicationId)
                          clearedTasksForApplication = true
                        }
                      }
                    } catch (_err) {
                      // ignore
                    }
                    return currentJobApplicationId
                  }
                  await recordApplication(ApplicationStatus.DRAFT)
                  const waitForApproval = await loadUserPreferences()
                  if (waitForApproval) {
                    addLog(`Waiting for approval before applying to ${titleStr}...`)
                    const approved = await requestApprovalForJob(clickJobResult.title || 'Untitled job', companyName || 'Unknown company')
                    if (!approved) {
                      addLog('Skipped applying (user declined).')
                      continue
                    }
                    addLog('User approved. Applying now...')
                  }
                  let documentsMissing = false
                  const applyClicked = await webview.executeJavaScript(`
                    (() => {
                      const btn = Array.from(document.querySelectorAll('button')).find(b => {
                        const text = (b.textContent || '').trim().toLowerCase();
                        const visible = !!(b.offsetParent);
                        return text === 'apply' && !b.disabled && visible;
                      });
                      if (!btn) return false;
                      btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                      btn.click();
                      return true;
                    })();
                  `)
                  if (applyClicked) {
                    // Delay inline-instructions check until after resume UI is present.
                    const dividerExists = await webview.executeJavaScript(`
                      (() => {
                        const divider = document.querySelector('div.vr.ng-star-inserted');
                        const heading = Array.from(document.querySelectorAll('h4')).find(
                          el => (el.textContent || '').toLowerCase().includes('how to apply')
                        );
                        return !!(divider || heading);
                      })();
                    `)
                    // defer instruction/task creation until after document checks below
                    await webview.executeJavaScript(`
                      (() => {
                        const btn = Array.from(document.querySelectorAll('button')).find(b => {
                          const text = (b.textContent || '').trim().toLowerCase();
                          const visible = !!(b.offsetParent);
                          return (text === 'submit' || text === 'save') && !b.disabled && visible;
                        });
                        const isRed = !!(btn && (btn.className || '').toLowerCase().includes('btn_primary'));
                        return { hasSubmit: !!btn, hasRed: isRed };
                      })();
                    `)
                    void dividerExists
                    let seenResume = false
                    let skipJob = false
                    let coverLetterTaskAdded = false
                    let workSampleChecked = false
                    let portfolioChecked = false
                    let transcriptChecked = false
                    let preferHeadlessClose = false
                    let docFieldFound = false
                    let needsExternalAction = false
                    let submitClickedForApplication = false

                    if (dividerExists) {
                      await withHumanFallback(
                        'the job application modal did not open',
                        () => waitForModalOpen(webview)
                      )
                      const { text } = await webview.executeJavaScript(`
                        (() => {
                          const modals = Array.from(document.querySelectorAll('div.modal-content, div[role="dialog"], .modal, .job-success-modal'));
                          // Prefer a modal that has the how-to-apply node and is not the success modal
                          const preferIndex = modals.findIndex(m =>
                            !m.classList.contains('job-success-modal') &&
                            m.querySelector('p#how-to-apply, #how-to-apply, .text-overflow.column, .p-group')
                          );
                          const modal = preferIndex >= 0
                            ? modals[preferIndex]
                            : (modals.find(m => !m.classList.contains('job-success-modal')) || modals[0] || null);
                          const scope = modal || document;
                          const lowerMatch = (id) => (id || '').toLowerCase().includes('how-to-apply');
                          const el =
                            scope.querySelector('p#how-to-apply') ||
                            scope.querySelector('#how-to-apply') ||
                            Array.from(scope.querySelectorAll('[id]')).find(node => lowerMatch(node.id)) ||
                            Array.from(scope.querySelectorAll('p')).find(p => lowerMatch(p.id || ''));
                          const container =
                            el ||
                            (el && el.parentElement) ||
                            scope.querySelector('.text-overflow.column') ||
                            scope.querySelector('.p-group') ||
                            modal ||
                            scope;

                          const extractInstruction = (node) => {
                            if (!node) return '';
                            const anchors = Array.from(node.querySelectorAll('a')).map(a => {
                              const t = (a.innerText || a.textContent || '').trim();
                              const href = (a.getAttribute('href') || '').trim();
                              if (href && t) {
                                // Prefer the href to avoid UI-truncated anchor text; include text when distinct.
                                return href.includes(t) ? href : (t + ' ' + href).trim();
                              }
                              return href || t;
                            }).filter(Boolean);

                            const rawLines = (node.innerText || node.textContent || '')
                              .split(/\\n+/)
                              .map(s => s.trim())
                              .filter(Boolean);
                            const applyLines = rawLines.filter(s => s.toLowerCase().includes('apply'));

                            const candidates = [...anchors, ...applyLines];
                            const first = candidates.find(Boolean);
                            if (first) return first;

                            const combined = [...rawLines, ...anchors].filter(Boolean);
                            return Array.from(new Set(combined)).join(' ').trim();
                          };

                          const txt = extractInstruction(container);
                          return {
                            text: txt,
                            elHtml: el ? el.outerHTML : '',
                            modalHtml: modal ? modal.innerHTML : '',
                            appliedModalIndex: preferIndex >= 0 ? preferIndex : (modals.length ? 0 : -1)
                          };
                        })();
                      `)

                      if (text) {
                        pendingModalInstructionText = text
                      }
                    }
                    for (let i = 0; i < 10; i++) { // faster resume/doc detection
                      const found = await webview.executeJavaScript(`
                        (() => {
                          const resumeSelect =
                            document.querySelector('select[id*="formfield"][id*="resume"]') ||
                            document.querySelector('select[ng-reflect-name="resume"]');
                          const label = Array.from(document.querySelectorAll('label'))
                            .find(l => (l.textContent || '').toLowerCase().includes('resume'));
                          const resumeButton =
                            document.querySelector('button[id*="formfield"][id*="resume"]') ||
                            Array.from(document.querySelectorAll('button')).find(b =>
                              (b.textContent || '').toLowerCase().includes('resume')
                            );
                          return {
                            hasLabel: !!label,
                            hasSelect: !!resumeSelect,
                            hasButton: !!resumeButton
                          };
                        })();
                      `)
                      if (found?.hasLabel || found?.hasSelect || found?.hasButton) {
                        seenResume = true
                        docFieldFound = true
                        if (!transcriptChecked) {
                          const transcriptInfo = await webview.executeJavaScript(`
                            (() => {
                              const sel = document.querySelector('select[id*="transcript"]');
                              const btn =
                                document.querySelector('button[id*="transcript"]') ||
                                Array.from(document.querySelectorAll('button')).find(b =>
                                  (b.textContent || '').toLowerCase().includes('transcript')
                                );
                              return { hasSelect: !!sel, hasButton: !!btn };
                            })();
                          `)
                          // Both can render together; the select is the only one that
                          // can be filled, so it wins when present.
                          if (transcriptInfo?.hasSelect) {
                            docFieldFound = true
                            let transcriptHandled = false
                            for (let t = 0; t < 10; t++) { // shorter wait to avoid long gaps
                              const selectResult = await webview.executeJavaScript(`
                                (() => {
                                  const sel = document.querySelector('select[id*="transcript"]');
                                  if (!sel) return { found: false };
                                  sel.scrollIntoView({ behavior: 'instant', block: 'center' });
                                  if (typeof sel.click === 'function') sel.click();
                                  else sel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                                  const options = Array.from(sel.options || []).map(o => ({
                                    value: o.value,
                                    text: (o.innerText || o.textContent || '').trim()
                                  })).filter(o => o.text || o.value);
                                  return { found: true, hasOptions: options.length > 0, options };
                                })();
                              `)
                              if (selectResult?.found) {
                                transcriptHandled = true
                                if (selectResult.hasOptions && selectResult.options?.length) {
                                  await webview.executeJavaScript(`
                                    (() => {
                                      const sel = document.querySelector('select[id*="transcript"]');
                                      if (!sel) return false;
                                      const target = Array.from(sel.options || [])[0];
                                      if (!target) return false;
                                      sel.value = target.value;
                                      sel.dispatchEvent(new Event('change', { bubbles: true }));
                                      sel.dispatchEvent(new Event('input', { bubbles: true }));
                                      return true;
                                    })();
                                  `)
                                } else {
                                  documentsMissing = true
                                  await handleNoTranscript(clickJobResult.company, userId, currentJobApplicationId, titleStr)
                                  skipJob = true
                                }
                                break
                              }
                              await sleep(50)
                            }
                            if (!transcriptHandled) {
                              documentsMissing = true
                              await handleNoTranscript(clickJobResult.company, userId, currentJobApplicationId, titleStr)
                              skipJob = true
                            }
                          } else if (transcriptInfo?.hasButton) {
                            docFieldFound = true
                            documentsMissing = true
                            await handleNoTranscript(clickJobResult.company, userId, currentJobApplicationId, titleStr)
                            skipJob = true
                          }
                          transcriptChecked = true
                        }
                        if (found?.hasSelect) {
                          await webview.executeJavaScript(`
                            (() => {
                              const btn = Array.from(document.querySelectorAll('button')).find(b => {
                                const text = (b.textContent || '').trim().toLowerCase();
                                const visible = !!(b.offsetParent);
                                return (text === 'submit' || text === 'save') && !b.disabled && visible;
                              });
                              const isRed = !!(btn && (btn.className || '').toLowerCase().includes('btn_primary'));
                              return { hasSubmit: !!btn, hasRed: isRed };
                            })();
                          `)
                          const coverLetterExists = await webview.executeJavaScript(`
                            (() => {
                              const addBtn = document.querySelector('button[id*="formfield"][id*="cover_let"]');
                              const sel = document.querySelector('select[id*="formfield"][id*="cover_letter"]');
                              const textBtn = Array.from(document.querySelectorAll('button')).find(b =>
                                (b.textContent || '').toLowerCase().includes('cover letter')
                              );
                              const input = document.querySelector('input[id*="cover"]') || document.querySelector('textarea[id*="cover"]');
                              return { hasSelect: !!sel, hasAdd: !!addBtn, hasAny: !!(sel || addBtn || textBtn || input) };
                            })();
                          `)
                          if (coverLetterExists?.hasAny) {
                            docFieldFound = true
                            if (coverLetterExists.hasSelect) {

                              const coverOpenResult = await webview.executeJavaScript(`
                                (() => {
                                  const sel = document.querySelector('select[id*="formfield"][id*="cover_letter"]');
                                  if (!sel) return { status: 'missing', options: [] };
                                  sel.scrollIntoView({ behavior: 'instant', block: 'center' });
                                  if (typeof sel.click === 'function') {
                                    sel.click();
                                  } else {
                                    sel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                                  }
                                  const opts = Array.from(sel.querySelectorAll('option')).map(o => (o.innerText || o.textContent || '').trim()).filter(Boolean);
                                  return { status: 'clicked', options: opts };
                                })();
                              `)
                              if (coverOpenResult?.status === 'clicked') {
                                if (Array.isArray(coverOpenResult.options) && coverOpenResult.options.length) {
                                  const hasCompany = companyLower
                                    ? coverOpenResult.options.some((o: string) => o.toLowerCase().includes(companyLower))
                                    : false;
                                  if (!hasCompany) {
                                    if (!coverLetterTaskAdded) {
                                      documentsMissing = true
                                      await handleNoCoverLetter(clickJobResult.company, userId, currentJobApplicationId, titleStr);
                                      coverLetterTaskAdded = true
                                    }
                                    skipJob = true
                                  }
                                }
                              }
                            } else {
                              if (!coverLetterTaskAdded) {
                                documentsMissing = true
                                await handleNoCoverLetter(clickJobResult.company, userId, currentJobApplicationId, titleStr)
                                coverLetterTaskAdded = true
                              }
                              skipJob = true
                            }
                          }

                          if (!workSampleChecked) {
                            const workSampleInfo = await webview.executeJavaScript(`
                              (() => {
                                const sel = document.querySelector('select[id*="writing_sample"]');
                                const opts = sel
                                  ? Array.from(sel.querySelectorAll('option')).map(o => ({
                                      text: (o.innerText || o.textContent || '').trim(),
                                      value: o.value
                                    })).filter(o => o.text)
                                  : [];
                                const btn =
                                  document.querySelector('button[id*="writing_sample"]') ||
                                  Array.from(document.querySelectorAll('button')).find(b =>
                                    (b.textContent || '').toLowerCase().includes('work sample')
                                  );
                                return { hasSelect: !!sel, options: opts, hasButton: !!btn };
                              })();
                            `)
                            const workSampleVisible = !!(workSampleInfo?.hasSelect || workSampleInfo?.hasButton)
                            if (workSampleVisible && workSampleInfo?.hasSelect) {
                              docFieldFound = true
                              const match = companyLower
                                ? workSampleInfo.options.find((o: any) => o.text.toLowerCase().includes(companyLower))
                                : null
                              if (match) {
                                await webview.executeJavaScript(`
                                  (() => {
                                    const sel = document.querySelector('select[id*="writing_sample"]');
                                    if (!sel) return false;
                                    const target = Array.from(sel.options).find(o =>
                                      (o.innerText || o.textContent || '').toLowerCase().includes(${JSON.stringify(
                                  companyLower || ''
                                )})
                                    );
                                    if (!target) return false;
                                    sel.value = target.value;
                                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                                    return true;
                                  })();
                                `)
                              } else {
                                documentsMissing = true
                                await handleNoWorkSample(clickJobResult.company, userId, currentJobApplicationId, titleStr)
                                skipJob = true
                              }
                            } else if (workSampleVisible && workSampleInfo?.hasButton) {
                              docFieldFound = true
                              documentsMissing = true
                              await handleNoWorkSample(clickJobResult.company, userId, currentJobApplicationId, titleStr)
                              skipJob = true
                            }
                            workSampleChecked = true
                          }

                          if (!portfolioChecked) {
                            const portfolioInfo = await webview.executeJavaScript(`
                              (() => {
                                const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"][id*="other_documents"]'));
                                const btn =
                                  document.querySelector('button[id*="other_documents"]') ||
                                  Array.from(document.querySelectorAll('button')).find(b =>
                                    (b.textContent || '').toLowerCase().includes('portfolio')
                                  );
                                return { hasCheckboxes: checkboxes.length > 0, hasButton: !!btn };
                              })();
                            `)
                            const portfolioVisible = !!(portfolioInfo?.hasCheckboxes || portfolioInfo?.hasButton)
                            if (portfolioVisible && portfolioInfo?.hasCheckboxes) {
                              docFieldFound = true
                              await webview.executeJavaScript(`
                              (() => {
                                const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"][id*="other_documents"]'));
                                checkboxes.forEach(cb => {
                                  if (!cb.checked) {
                                    cb.click();
                                  }
                                });
                                return true;
                              })();
                            `)
                            } else if (portfolioVisible && portfolioInfo?.hasButton) {
                              docFieldFound = true
                              documentsMissing = true
                              await handleNoPortfolio(clickJobResult.company, userId, currentJobApplicationId, titleStr)
                              skipJob = true
                            }
                            portfolioChecked = true
                          }
                          if (skipJob) {
                            await recordApplication(ApplicationStatus.DRAFT)
                            await closeModalIfPresent(webview)
                            break
                          }

                          // Wait for red submit/save to appear; if it never turns red, close modal and continue.
                          let submitClicked = false
                          preferHeadlessClose = false
                          for (let attempt = 0; attempt < 20; attempt++) { // ~0.2s
                            const redNow = await webview.executeJavaScript(`
                              (() => {
                                const btn = Array.from(document.querySelectorAll('button')).find(b => {
                                  const text = (b.textContent || '').trim().toLowerCase();
                                  const visible = !!(b.offsetParent);
                                  const isRed = (b.className || '').toLowerCase().includes('btn_primary');
                                  return text === 'submit' && !b.disabled && visible && isRed;
                                });
                                if (btn) {
                                  const hasDivider = !!document.querySelector('div.vr.ng-star-inserted');
                                  return { clicked: (() => { btn.scrollIntoView({ behavior: 'instant', block: 'center' }); btn.click(); return true; })(), hasDivider };
                                }
                                return { clicked: false, hasDivider: false };
                              })();
                            `)
                            if (redNow?.clicked) {
                              submitClicked = true
                              submitClickedForApplication = true
                              preferHeadlessClose = !!redNow?.hasDivider
                              break
                            }
                            await sleep(10)
                          }
                          if (!submitClicked) {
                            await closeModalIfPresent(webview, preferHeadlessClose)
                            skipJob = true
                            break
                          }
                          let submitGone = false
                          for (let attempt = 0; attempt < 20; attempt++) { // ~0.2s
                            const submitStillThere = await webview.executeJavaScript(`
                              (() => {
                                const btn = Array.from(document.querySelectorAll('button')).find(b => {
                                  const text = (b.textContent || '').trim().toLowerCase();
                                  const visible = !!(b.offsetParent);
                                  return (text === 'submit' || text === 'save') && visible;
                                });
                                return !!btn;
                              })();
                            `)
                            if (!submitStillThere) {
                              await closeModalIfPresent(webview, preferHeadlessClose)
                              submitGone = true
                              break
                            }
                            await sleep(10)
                          }
                          if (!submitGone) {
                            await closeModalIfPresent(webview, preferHeadlessClose)
                          }
                          setStatus('running')
                          await waitForDividerSubmissionAndClose(webview)
                          if (skipJob) {
                            await recordApplication(ApplicationStatus.DRAFT)
                            await closeModalIfPresent(webview, preferHeadlessClose)
                            break
                          }
                        } else if (found?.hasButton) {
                          await webview.executeJavaScript(`
                            (() => {
                              const btn =
                                document.querySelector('button[id*="formfield"][id*="resume"]') ||
                                Array.from(document.querySelectorAll('button')).find(b =>
                                  (b.textContent || '').toLowerCase().includes('resume')
                                );
                              if (!btn) return false;
                              btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                              btn.click();
                              return true;
                            })();
                          `)

                          // Wait for submit/save button to appear, then for it to be clicked (disappear)
                          while (true) {
                            const submitVisible = await webview.executeJavaScript(`
                              (() => {
                                const btn = Array.from(document.querySelectorAll('button')).find(b => {
                                  const text = (b.textContent || '').trim().toLowerCase();
                                  const visible = !!(b.offsetParent);
                                  return (text === 'submit' || text === 'save') && !b.disabled && visible;
                                });
                                return !!btn;
                              })();
                            `)
                            if (submitVisible) { break }
                            await sleep(10)
                          }

                          const coverLetterExists = await webview.executeJavaScript(`
                            (() => {
                              const addBtn = document.querySelector('button[id*="formfield"][id*="cover_let"]');
                              const sel = document.querySelector('select[id*="formfield"][id*="cover_letter"]');
                              const textBtn = Array.from(document.querySelectorAll('button')).find(b =>
                                (b.textContent || '').toLowerCase().includes('cover letter')
                              );
                              const input = document.querySelector('input[id*="cover"]') || document.querySelector('textarea[id*="cover"]');
                              return { hasSelect: !!sel, hasAdd: !!addBtn, hasAny: !!(sel || addBtn || textBtn || input) };
                            })();
                          `)
                          if (coverLetterExists?.hasAny) {
                            // Try to open the cover letter selector/dropdown for the user.
                            const coverOpenResult = await webview.executeJavaScript(`
                              (() => {
                                const sel =
                                  document.querySelector('select[id*="formfield"][id*="cover_letter"]') ||
                                  document.querySelector('button[id*="formfield"][id*="cover_let"]');
                                if (!sel) return { status: 'missing', options: [] };
                                sel.scrollIntoView({ behavior: 'instant', block: 'center' });
                                if (typeof sel.click === 'function') {
                                  sel.click();
                                } else {
                                  sel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                                }
                                const opts = sel.tagName === 'SELECT'
                                  ? Array.from(sel.querySelectorAll('option')).map(o => (o.innerText || o.textContent || '').trim()).filter(Boolean)
                                  : [];
                                return { status: 'clicked', options: opts };
                              })();
                            `)
                            if (coverOpenResult?.status === 'clicked') {
                              if (Array.isArray(coverOpenResult.options) && coverOpenResult.options.length) {
                                const hasCompany = companyLower
                                  ? coverOpenResult.options.some((o: string) => o.toLowerCase().includes(companyLower))
                                  : false;
                                if (!hasCompany) {
                                  await webview.executeJavaScript(`
                                    (() => {
                                      const btn =
                                        document.querySelector('button.modal-close') ||
                                        document.querySelector('button.headless-close-btn') ||
                                        Array.from(document.querySelectorAll('button')).find(b => {
                                          const cls = (b.className || '').toLowerCase();
                                          return cls.includes('modal-close') || cls.includes('headless-close-btn');
                                        });
                                      if (btn) {
                                        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                                        if (typeof btn.click === 'function') btn.click();
                                        else btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                                        return true;
                                      }
                                      return false;
                                    })();
                                  `)
                                  continue
                                }
                              }
                            }
                            if (!coverLetterExists.hasSelect) {
                              if (!coverLetterTaskAdded) {
                                documentsMissing = true
                                await handleNoCoverLetter(clickJobResult.company, userId, currentJobApplicationId, titleStr);
                                coverLetterTaskAdded = true
                              }
                              await webview.executeJavaScript(`
                                (() => {
                                  const btn =
                                    document.querySelector('button.modal-close') ||
                                    document.querySelector('button.headless-close-btn') ||
                                    Array.from(document.querySelectorAll('button')).find(b => {
                                      const cls = (b.className || '').toLowerCase();
                                      return cls.includes('modal-close') || cls.includes('headless-close-btn');
                                    });
                                  if (btn) {
                                    btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                                    if (typeof btn.click === 'function') btn.click();
                                    else btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                                    return true;
                                  }
                                  return false;
                                })();
                              `)
                              skipJob = true
                            }
                          }

                          if (!workSampleChecked) {
                            const workSampleInfo = await webview.executeJavaScript(`
                              (() => {
                                const sel = document.querySelector('select[id*="writing_sample"]');
                                const opts = sel
                                  ? Array.from(sel.querySelectorAll('option')).map(o => ({
                                      text: (o.innerText || o.textContent || '').trim(),
                                      value: o.value
                                    })).filter(o => o.text)
                                  : [];
                                const btn =
                                  document.querySelector('button[id*="writing_sample"]') ||
                                  Array.from(document.querySelectorAll('button')).find(b =>
                                    (b.textContent || '').toLowerCase().includes('work sample')
                                  );
                                return { hasSelect: !!sel, options: opts, hasButton: !!btn };
                              })();
                            `)
                            if (workSampleInfo?.hasSelect) {
                              const match = companyLower
                                ? workSampleInfo.options.find((o: any) => o.text.toLowerCase().includes(companyLower))
                                : null
                              if (match) {
                                await webview.executeJavaScript(`
                                  (() => {
                                    const sel = document.querySelector('select[id*="writing_sample"]');
                                    if (!sel) return false;
                                    const target = Array.from(sel.options).find(o =>
                                      (o.innerText || o.textContent || '').toLowerCase().includes(${JSON.stringify(
                                  companyLower || ''
                                )})
                                    );
                                    if (!target) return false;
                                    sel.value = target.value;
                                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                                    return true;
                                  })();
                                `)
                              } else {
                                documentsMissing = true
                                await handleNoWorkSample(clickJobResult.company, userId, currentJobApplicationId, titleStr)
                                skipJob = true
                              }
                              workSampleChecked = true
                            } else if (workSampleInfo?.hasButton) {
                              documentsMissing = true
                              await handleNoWorkSample(clickJobResult.company, userId, currentJobApplicationId, titleStr)
                              skipJob = true
                              workSampleChecked = true
                            } else {
                              // Neither control present: the employer never asked for a
                              // work sample, so there is nothing missing.
                              workSampleChecked = true
                            }
                          }

                          if (!portfolioChecked) {
                            const portfolioInfo = await webview.executeJavaScript(`
                              (() => {
                                const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"][id*="other_documents"]'));
                                const btn =
                                  document.querySelector('button[id*="other_documents"]') ||
                                  Array.from(document.querySelectorAll('button')).find(b =>
                                    (b.textContent || '').toLowerCase().includes('portfolio')
                                  );
                                return { hasCheckboxes: checkboxes.length > 0, hasButton: !!btn };
                              })();
                            `)
                            if (portfolioInfo?.hasCheckboxes) {
                              await webview.executeJavaScript(`
                                (() => {
                                  const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"][id*="other_documents"]'));
                                  checkboxes.forEach(cb => {
                                    if (!cb.checked) {
                                      cb.click();
                                    }
                                  });
                                  return true;
                                })();
                              `)
                              portfolioChecked = true
                            } else if (portfolioInfo?.hasButton) {
                              documentsMissing = true
                              await handleNoPortfolio(clickJobResult.company, userId, currentJobApplicationId, titleStr)
                              skipJob = true
                              portfolioChecked = true
                            } else {
                              portfolioChecked = true
                            }
                          }
                          if (skipJob) {
                            await recordApplication(ApplicationStatus.DRAFT)
                            await closeModalIfPresent(webview)
                            break
                          }

                          // Wait specifically for red submit/save to appear
                          let submitClicked = false
                          preferHeadlessClose = false
                          for (let attempt = 0; attempt < 20; attempt++) { // ~0.2s
                            const redNow = await webview.executeJavaScript(`
                              (() => {
                                const btn = Array.from(document.querySelectorAll('button')).find(b => {
                                  const text = (b.textContent || '').trim().toLowerCase();
                                  const visible = !!(b.offsetParent);
                                  const isRed = (b.className || '').toLowerCase().includes('btn_primary');
                                  return text === 'submit' && !b.disabled && visible && isRed;
                                });
                                if (btn) {
                                  const hasDivider = !!document.querySelector('div.vr.ng-star-inserted');
                                  btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                                  btn.click();
                                  return { clicked: true, hasDivider };
                                }
                                return { clicked: false, hasDivider: false };
                              })();
                            `)
                            if (redNow?.clicked) {
                              submitClicked = true
                              submitClickedForApplication = true
                              preferHeadlessClose = !!redNow?.hasDivider
                              break
                            }
                            await sleep(10)
                          }
                          if (!submitClicked) {
                            await closeModalIfPresent(webview, preferHeadlessClose)
                            skipJob = true
                            break
                          }
                          // Wait for submit to disappear
                          let submitGone = false
                          for (let attempt = 0; attempt < 20; attempt++) { // ~0.2s
                            const submitStillThere = await webview.executeJavaScript(`
                              (() => {
                                const btn = Array.from(document.querySelectorAll('button')).find(b => {
                                  const text = (b.textContent || '').trim().toLowerCase();
                                  const visible = !!(b.offsetParent);
                                  return (text === 'submit' || text === 'save') && visible;
                                });
                                return !!btn;
                              })();
                            `)
                            if (!submitStillThere) {
                              await closeModalIfPresent(webview, preferHeadlessClose)
                              setStatus('running')
                              submitGone = true
                              break
                            }
                            await sleep(10)
                          }
                          if (!submitGone) {
                            await closeModalIfPresent(webview, preferHeadlessClose)
                            setStatus('running')
                            skipJob = true
                          }
                          await waitForDividerSubmissionAndClose(webview)
                          if (skipJob) {
                            await recordApplication(ApplicationStatus.DRAFT)
                            await closeModalIfPresent(webview, preferHeadlessClose)
                            break
                          }
                        }
                        break
                      }
                      if (skipJob) {
                        await recordApplication(ApplicationStatus.DRAFT)
                        await closeModalIfPresent(webview, preferHeadlessClose)
                        break
                      }
                      await sleep(50)
                    }
                    if (skipJob) {
                      await recordApplication(ApplicationStatus.DRAFT)
                      await closeModalIfPresent(webview, preferHeadlessClose)
                      continue
                    }
                    if (!docFieldFound && !documentsMissing) {
                      try {
                        const instructionsText = await webview.executeJavaScript(`
                          (() => {
                            const collectAnchors = (scope) =>
                              Array.from((scope && scope.querySelectorAll) ? scope.querySelectorAll('a') : []).map(a => {
                                const label = (a.innerText || a.textContent || '').trim();
                                const href = (a.getAttribute && a.getAttribute('href')) ? a.getAttribute('href').trim() : '';
                                if (label && href) return label + ' ' + href;
                                return href || label;
                              }).filter(Boolean);
                            const el = document.querySelector('#how-to-apply') || document.querySelector('p#how-to-apply');
                            const primary = el ? (el.innerText || el.textContent || '').trim() : '';
                            const anchorBits = collectAnchors(el || document);
                            if (primary || anchorBits.length) {
                              return [primary, ...anchorBits].filter(Boolean).join('\\n').trim();
                            }
                            const paragraphs = Array.from(document.querySelectorAll('p'))
                              .map(p => (p.innerText || p.textContent || '').trim())
                              .filter(Boolean);
                            const moreAnchors = collectAnchors(document);
                            return [...paragraphs, ...moreAnchors].filter(Boolean).join('\\n').trim();
                          })();
                        `)
                        const userId = await getUserId()
                        if (instructionsText && userId) {
                          needsExternalAction = true
                          const instructionsResp = await postWithRateLimit('/me/tasks/add-instructions', {
                            employer_instructions: instructionsText,
                            application_id: currentJobApplicationId ?? undefined,
                            company: (clickJobResult.company || '').trim() || 'company unknown',
                            title: (titleStr || '').trim() || 'title unknown'
                          })
                          if (instructionsResp.status === 429) logInstructionsLimit(titleStr)
                        }
                      } catch (_err) {
                        // ignore
                      }
                      await recordApplication(submitClickedForApplication && needsExternalAction ? ApplicationStatus.EXTERNAL : ApplicationStatus.DRAFT)
                      await closeModalIfPresent(webview, preferHeadlessClose)
                      // Wait for the "One more thing..." modal to appear, click through, then continue.
                      for (let m = 0; m < 20; m++) {
                        const modalVisible = await webview.executeJavaScript(`
                          (() => {
                            const text = Array.from(document.querySelectorAll('div, h1, h2, h3, h4, p')).find(el =>
                              (el.innerText || el.textContent || '').trim().toLowerCase().includes('one more thing')
                            );
                            const yesNo = Array.from(document.querySelectorAll('button')).some(b => {
                              const t = (b.textContent || '').trim().toLowerCase();
                              return t === 'yes' || t === 'no';
                            });
                            return !!(text || yesNo);
                          })();
                        `)
                        if (modalVisible) {
                          for (let y = 0; y < 30; y++) {
                            const clicked = await webview.executeJavaScript(`
                              (() => {
                                const btn = Array.from(document.querySelectorAll('button')).find(b => {
                                  const txt = (b.textContent || '').trim().toLowerCase();
                                  const cls = (b.className || '').toLowerCase();
                                  return txt === 'yes' || cls.includes('yes');
                                });
                                if (!btn) return false;
                                btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                                if (typeof btn.click === 'function') btn.click();
                                else btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                                return true;
                              })();
                            `)
                            if (clicked) break
                            await sleep(100)
                          }
                          // Wait for the modal to disappear before continuing.
                          for (let z = 0; z < 30; z++) {
                            const stillVisible = await webview.executeJavaScript(`
                              (() => {
                                const text = Array.from(document.querySelectorAll('div, h1, h2, h3, h4, p')).find(el =>
                                  (el.innerText || el.textContent || '').trim().toLowerCase().includes('one more thing')
                                );
                                const yesNo = Array.from(document.querySelectorAll('button')).some(b => {
                                  const t = (b.textContent || '').trim().toLowerCase();
                                  return t === 'yes' || t === 'no';
                                });
                                return !!(text || yesNo);
                              })();
                            `)
                            if (!stillVisible) break
                            await sleep(100)
                          }
                          break
                        }
                        await sleep(100)
                      }
                      continue
                    }
                    if (!documentsMissing && dividerExists) {
                      // instructions already collected pre-submit
                    }
                    if (!documentsMissing && pendingModalInstructionText && userId) {
                      try {
                        needsExternalAction = true
                        const instructionsResp = await postWithRateLimit('/me/tasks/add-instructions', {
                          employer_instructions: pendingModalInstructionText,
                          application_id: currentJobApplicationId ?? undefined,
                          company: (clickJobResult.company || '').trim() || 'company unknown',
                          title: (titleStr || '').trim() || 'title unknown'
                        })
                        if (instructionsResp.status === 429) logInstructionsLimit(titleStr)
                      } catch (_err) { /* ignore */ }
                    }
                    if (!documentsMissing && instructions.length) {
                      await addEmployerTasks(instructions, currentJobApplicationId, titleStr)
                    }
                    if (!seenResume) {
                      addLog('Waiting for user resume upload...')
                      playAlertSound()
                      setStatus('paused')
                      return
                    }
                    const hasExternalTasks = (needsExternalAction || instructions.length > 0)
                    for (let i = 0; i < instructions.length; i++) {
                      addLog(instructions[i].text)
                    }
                    const statusToRecord =
                      !submitClickedForApplication
                        ? ApplicationStatus.DRAFT
                        : (hasExternalTasks ? ApplicationStatus.EXTERNAL : ApplicationStatus.APPLIED)
                    await recordApplication(statusToRecord)
                  }
                } else if (data.decision === 'DO_NOT_APPLY') {
                  consecutiveDoNotApply += 1
                  addLog(`Decision: skip.`)
                  if (consecutiveDoNotApply >= 4) {
                    addLog('Moving to next search term...')
                    continue termLoop
                  }
                } else {
                  consecutiveDoNotApply = 0
                  addLog('Decision unknown; skipping.')
                }
              } else if (analysis.status === 429) {
                const wait = analysis.retryAfter ?? 0
                addLog(`${wait > 3600 ? 'Daily review' : 'Review'} limit reached. Stopping run. You can start again in about ${formatWait(wait)}.`)
                setStatus('idle')
                return
              } else if (analysis.status === 400) {
                consecutiveDoNotApply = 0
                addLog('Error: missing information. Skipping...')
              } else {
                consecutiveDoNotApply = 0
                addLog('Decision request failed; skipping.')
              }
            }
          } catch (_e) {
            consecutiveDoNotApply = 0
          }
        } else if (clickJobResult?.status === 'skipped' && clickJobResult.reason === 'seen this run') {
          consecutiveDoNotApply = 0
          addLog(`Skipped job #${idx + 1} (ALREADY SEEN THIS RUN): ${clickJobResult.displayTitle || 'Untitled job'}.`)
        } else if (clickJobResult?.status === 'skipped') {
          consecutiveDoNotApply = 0
          const reason = clickJobResult.reason
            ? ` (${String(clickJobResult.reason).toUpperCase()})`
            : ''
          addLog(`Skipped job #${idx + 1}${reason}.`)
        } else {
          consecutiveDoNotApply = 0
          addLog(`Job card #${idx + 1} missing or not clickable.`)
        }
      }

      const nextResult = await webview.executeJavaScript(`
        (() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => {
            const text = (b.textContent || '').trim().toLowerCase();
            const visible = !!(b.offsetParent);
            return visible && (text === 'next' || text === 'next >' || text.includes('next'));
          });
          if (!btn) return { exists: false };
          const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true' || (btn.className || '').toLowerCase().includes('disabled');
          if (disabled) return { exists: true, disabled: true, clicked: false };
          btn.scrollIntoView({ behavior: 'instant', block: 'center' });
          if (typeof btn.click === 'function') btn.click();
          else btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { exists: true, disabled: false, clicked: true };
        })();
      `)

      if (nextResult?.exists && nextResult.clicked && !nextResult.disabled) {
        addLog(`Moving to page ${pageIndex + 1})...`)
        pageIndex += 1
        await sleep(400)
        continue
      }

      if (nextResult?.exists && nextResult.clicked && !nextResult.disabled) {
        addLog(`Moving to page ${pageIndex + 1})...`)
        pageIndex += 1
        await sleep(400)
        continue
      }

      continue termLoop
    }
  }

  addLog('Completed running search terms.')

  setStatus('idle')
}

const runFromHome = async (webview: AutomationWebview) => {
  if (await isHome(webview)) {
    addLog('Already signed in.')
    await runFromDashboard(webview)
    return
  }
  if (!isInAuthFlow(currentUrl(webview))) {
    webview.src = HOME_URL
    await waitForWebViewLoad(webview)

    if (await isHome(webview)) {
      addLog('Already signed in.')
      await runFromDashboard(webview)
      return
    }
  }

  const signInClicked = await waitForSelector(
    webview,
    'input.input-button.btn.btn_primary.full_width.btn_multi_line',
    5000
  )
  if (signInClicked) {
    await webview.executeJavaScript(`document.querySelector('input.input-button.btn.btn_primary.full_width.btn_multi_line').click()`)
    addLog('Navigating to login...')
  }

  playAlertSound()
  setState({ awaitingInput: true })
  addLog('Waiting for user to sign in...')
  await waitForHome(webview)

  addLog('Continuing...')
  setState({ awaitingInput: false })
  await runFromDashboard(webview)
}

// -- actions --------------------------------------------------------------

export const start = async () => {
  // Guards a double-click and, in dev, a StrictMode double-mount re-firing this.
  if (getState().status === 'running' || getState().status === 'paused') return
  if (getState().searchTermsReady !== true) {
    addLog('Setting up your job search. Please wait a moment...')
    return
  }
  const webview = getAutomationWebview()
  if (!webview) {
    addLog('Error: webview not found')
    setStatus('error')
    return
  }

  setState({ awaitingInput: false })
  setStatus('running')
  addLog('Beginning automation...')

  // Nothing awaits the run, so an uncaught throw would be an unhandled rejection
  // that leaves the UI stuck on "running".
  try {
    await runFromHome(webview)
  } catch (err) {
    addLog(`Error: ${err instanceof Error ? err.message : String(err)}`)
    setStatus('error')
  }
}

export const pause = () => setStatus('paused')

export const resume = () => setStatus('running')

