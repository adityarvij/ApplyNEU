import { describe, it, expect } from '@jest/globals';
import { renderCandidateContext, candidateHash } from '../../src/services/candidateContext/candidateContext.service.ts';
import type { ResumedCandidateContext } from '../../src/types/candidateContext.ts';

const profile = (): ResumedCandidateContext => ({
    resume: {
        resume_text: 'Backend engineer. Node, Postgres, TypeScript.',
        search_terms: ['backend', 'platform'],
        enrichment_status: 'complete',
    },
    preferences: {
        job_match: 'low',
        wait_for_approval: true,
        job_types: ['co-op', 'internship'],
        unpaid_roles: false,
        recent_jobs: true,
        interests: ['distributed systems'],
    },
    profile: { grad_year: 2027 },
});

describe('renderCandidateContext', () => {
    it('renders byte-identical output for identical input', () => {
        expect(renderCandidateContext(profile())).toBe(renderCandidateContext(profile()));
    });

    it('omits sensitivity and filter preferences', () => {
        const rendered = renderCandidateContext(profile());
        expect(rendered).not.toMatch(/job_match|sensitivity|unpaid|recent/i);
        expect(rendered).not.toContain('low');
    });

    it('includes interests', () => {
        expect(renderCandidateContext(profile())).toContain('INTERESTS: distributed systems');
    });

    it('omits job types and search terms', () => {
        const rendered = renderCandidateContext(profile());
        expect(rendered).not.toMatch(/DESIRED JOB TYPES|SEARCH TERMS/);
        expect(rendered).not.toMatch(/co-op|internship|platform/);
    });
});

describe('candidateHash', () => {
    it('does not change when job_match changes', () => {
        const low = profile();
        const high: ResumedCandidateContext = {
            ...low,
            preferences: { ...low.preferences, job_match: 'high' },
        };
        expect(candidateHash(high)).toBe(candidateHash(low));
    });

    it('does not change when search terms or job types change', () => {
        const base = profile();
        const changed: ResumedCandidateContext = {
            ...base,
            resume: { ...base.resume, search_terms: ['frontend'] },
            preferences: { ...base.preferences, job_types: ['full-time'] },
        };
        expect(candidateHash(changed)).toBe(candidateHash(base));
    });

    it('changes when interests change', () => {
        const base = profile();
        const changed: ResumedCandidateContext = {
            ...base,
            preferences: { ...base.preferences, interests: ['compilers'] },
        };
        expect(candidateHash(changed)).not.toBe(candidateHash(base));
    });

    it('changes when the resume changes', () => {
        const base = profile();
        const changed: ResumedCandidateContext = {
            ...base,
            resume: { ...base.resume, resume_text: 'Frontend engineer. React.' },
        };
        expect(candidateHash(changed)).not.toBe(candidateHash(base));
    });
});
