import type { JobMatchSensitivity } from "../services/jobMatch/jobMatch.service.ts";
import type { EnrichmentStatus } from "./resumes.ts";

export interface CandidateContextResponse {
  resume: {
    resume_text: string;
    search_terms: string[];
    enrichment_status: EnrichmentStatus;
  } | null;
  preferences: {
    job_match: JobMatchSensitivity;
    wait_for_approval: boolean;
    job_types: string[];
    unpaid_roles: boolean;
    recent_jobs: boolean;
    interests: string[];
  };
  profile: {
    grad_year: number;
  };
}

export type ResumedCandidateContext = CandidateContextResponse & {
  resume: NonNullable<CandidateContextResponse['resume']>;
};
