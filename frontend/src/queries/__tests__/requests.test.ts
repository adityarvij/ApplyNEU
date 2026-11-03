import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { PENDING_POLL_MS, pendingRequestsQueryOptions, requestKeys, type HumanRequest } from '../requests'

const get = vi.fn()
vi.mock('../../lib/api', () => ({ api: { get: (...args: unknown[]) => get(...args), post: vi.fn() } }))

const pending: HumanRequest = {
  request_id: 'request-1',
  run_id: 'run-1',
  job_id: 'job-1',
  kind: 'apply_approval',
  status: 'pending',
  payload: { title: 'SWE', company: 'Acme' },
  answer: null,
  created_at: '2026-11-02T00:00:00Z',
  resolved_at: null,
  expires_at: null,
}

const respond = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body })

let queryClient: QueryClient

beforeEach(() => {
  get.mockReset()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

describe('pending requests query', () => {
  it('fetches only pending requests', async () => {
    get.mockResolvedValue(respond([pending]))

    const rows = await queryClient.fetchQuery(pendingRequestsQueryOptions)

    expect(get).toHaveBeenCalledWith('/me/requests?status=pending')
    expect(rows).toEqual([pending])
    expect(queryClient.getQueryData(requestKeys.pending)).toEqual([pending])
  })

  it('polls so a request asked while the page is open shows up', () => {
    expect(pendingRequestsQueryOptions.refetchInterval).toBe(PENDING_POLL_MS)
    expect(PENDING_POLL_MS).toBeLessThanOrEqual(5_000)
  })

  it('throws on a failed response', async () => {
    get.mockResolvedValue(respond({}, false))

    await expect(queryClient.fetchQuery(pendingRequestsQueryOptions)).rejects.toThrow('failed with 500')
  })
})
