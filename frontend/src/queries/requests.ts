import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'

export type HumanRequestKind = 'apply_approval' | 'submit_approval' | 'question' | 'handoff'

export type HumanRequestStatus = 'pending' | 'resolved' | 'expired' | 'cancelled'

export type HumanRequest = {
  request_id: string
  run_id: string
  job_id: string | null
  kind: HumanRequestKind
  status: HumanRequestStatus
  payload: Record<string, unknown>
  answer: unknown
  created_at: string
  resolved_at: string | null
  expires_at: string | null
}

export const requestKeys = {
  all: ['requests'] as const,
  pending: ['requests', 'pending'] as const,
}

// Agents ask from the backend while the user is looking at the page, so the pending list is
// polled until the backend pushes new requests itself (#186).
export const PENDING_POLL_MS = 3_000

export const pendingRequestsQueryOptions = {
  queryKey: requestKeys.pending,
  queryFn: async (): Promise<HumanRequest[]> => {
    const resp = await api.get('/me/requests?status=pending')
    if (!resp.ok) throw new Error(`GET /me/requests failed with ${resp.status}`)
    return resp.json() as Promise<HumanRequest[]>
  },
  refetchInterval: PENDING_POLL_MS,
}

export const usePendingRequests = () => useQuery(pendingRequestsQueryOptions)

export const useResolveRequest = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ request_id, answer }: { request_id: string; answer: unknown }) => {
      const resp = await api.post(`/me/requests/${request_id}/resolve`, { answer })
      if (!resp.ok) throw new Error(`POST /me/requests/${request_id}/resolve failed with ${resp.status}`)
      return resp.json() as Promise<HumanRequest>
    },
    onSuccess: (resolved) => {
      queryClient.setQueryData<HumanRequest[]>(requestKeys.pending, (pending) =>
        pending?.filter((request) => request.request_id !== resolved.request_id))
      void queryClient.invalidateQueries({ queryKey: requestKeys.all })
    },
  })
}
