export type HumanRequestKind = 'apply_approval' | 'submit_approval' | 'question' | 'handoff';

export type HumanRequestStatus = 'pending' | 'resolved' | 'expired' | 'cancelled';

export const HUMAN_REQUEST_STATUSES: HumanRequestStatus[] = ['pending', 'resolved', 'expired', 'cancelled'];

export type HumanRequest = {
  request_id: string;
  run_id: string;
  job_id: string | null;
  kind: HumanRequestKind;
  status: HumanRequestStatus;
  payload: Record<string, unknown>;
  answer: unknown;
  created_at: string;
  resolved_at: string | null;
  expires_at: string | null;
};
