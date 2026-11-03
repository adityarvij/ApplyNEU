import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { normalizeAndHash } from '../../src/utils/hash.ts';
import { AppError } from '../../src/errors/AppError.ts';
import type { CandidateContextResponse } from '../../src/types/candidateContext.ts';

const query = jest.fn<(text: string, params?: any[]) => Promise<any>>();
const create = jest.fn<(args: any) => Promise<any>>();
const getCandidateContext = jest.fn<(user_id: string) => Promise<CandidateContextResponse>>();
const consumeModelCall = jest.fn<(userId: string, kind: string) => Promise<void>>();

jest.unstable_mockModule('../../src/db/index.ts', () => ({
    pool: { query },
}));

jest.unstable_mockModule('../../src/services/rateLimit/rateLimit.service.ts', () => ({
    consumeModelCall,
}));

const redisStore = new Map<string, string>();
const redisGet = jest.fn<(key: string) => Promise<string | null>>();
const redisSet = jest.fn<(key: string, value: string, ...args: unknown[]) => Promise<string>>();

jest.unstable_mockModule('../../src/db/redis.ts', () => ({
    redis: { get: redisGet, set: redisSet },
}));

jest.unstable_mockModule('../../src/services/candidateContext/candidateContext.service.ts', () => ({
    getCandidateContext,
    renderCandidateContext: (context: { profile: { grad_year: number }; resume: { resume_text: string } }) =>
        `GRADUATION YEAR: ${context.profile.grad_year}\nRESUME:\n${context.resume.resume_text}`,
}));

class TransientError extends Error {}

jest.unstable_mockModule('@anthropic-ai/sdk', () => {
    class Anthropic {
        messages = { create };
        static APIConnectionError = TransientError;
        static RateLimitError = TransientError;
        static InternalServerError = TransientError;
    }
    return { default: Anthropic };
});

const { sendJobDescription, MATCH_THRESHOLDS, decideFromScore } = await import('../../src/services/jobMatch/jobMatch.service.ts');
const { SCORING_RULES, SCORING_VERSION } = await import('../../src/services/jobMatch/jobMatch.prompt.ts');
const { EXTRACTION_RULES, EXTRACTION_VERSION } = await import('../../src/services/instructions/instructions.prompt.ts');

const COMPANY = 'Acme';
const TITLE = 'Software Engineer';
const DESCRIPTION = 'We are hiring a Software Engineer to build great things.';

const USER_ID = 'user-1';
const GRAD_YEAR = 2027;

const candidateContext = (
    overrides: Partial<CandidateContextResponse> = {}
): CandidateContextResponse => ({
    resume: {
        resume_text: 'Backend engineer. Node, Postgres, TypeScript.',
        search_terms: ['backend'],
        enrichment_status: 'complete',
    },
    preferences: {
        job_match: 'high',
        wait_for_approval: true,
        job_types: ['co-op'],
        unpaid_roles: false,
        recent_jobs: true,
        interests: ['distributed systems'],
    },
    profile: { grad_year: GRAD_YEAR },
    ...overrides,
});

const aiResponse = (payload: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
});

type Rows = { rows: unknown[] };

/** Routes each query to the memo read or the score read by its SQL; everything else succeeds empty. */
const db = ({ memo, score }: { memo?: (params: unknown[]) => Rows; score?: (params: unknown[]) => Rows }) =>
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (memo && sql.includes('FROM instruction_extractions')) return memo(params!);
        if (score && sql.includes('SELECT m.match_score')) return score(params!);
        return { rows: [] };
    });

const memoHit = (instructions: unknown[]) => () => ({
    rows: instructions.length ? instructions : [{ kind: null, instruction: null, description: null }],
});
const scoreHit = (match_score: number, rationale: string | null = 'Stored rationale.') => () => ({ rows: [{ match_score, rationale }] });

const lastRequest = () => create.mock.calls[create.mock.calls.length - 1]![0];
const systemText = () => (lastRequest().system as { text: string }[]).map((block) => block.text).join('\n');
const messageText = () => lastRequest().messages.map((m: { content: string }) => m.content).join('\n');

beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    create.mockReset();
    getCandidateContext.mockReset();
    consumeModelCall.mockReset();
    consumeModelCall.mockResolvedValue(undefined);
    redisStore.clear();
    redisGet.mockReset().mockImplementation(async (key) => redisStore.get(key) ?? null);
    redisSet.mockReset().mockImplementation(async (key, value) => {
        redisStore.set(key, value);
        return 'OK';
    });
});

describe('sendJobDescription', () => {
    const analyze = () => sendJobDescription(USER_ID, DESCRIPTION, COMPANY, TITLE);

    const fit = () => aiResponse({ match_score: 80, rationale: 'Good fit.', employer_instructions: [] });

    it('sources the candidate from getCandidateContext', async () => {
        getCandidateContext.mockResolvedValue(candidateContext());
        create.mockResolvedValue(fit());

        await analyze();

        expect(getCandidateContext).toHaveBeenCalledWith(USER_ID);
    });

    describe('rate limit', () => {
        it('charges a job_match call before calling the model on a miss', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            create.mockResolvedValue(fit());

            await analyze();

            expect(consumeModelCall).toHaveBeenCalledWith(USER_ID, 'job_match');
            expect(consumeModelCall.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]!);
        });

        it('does not charge a cache hit', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            db({ memo: memoHit([]), score: scoreHit(72) });

            await analyze();

            expect(consumeModelCall).not.toHaveBeenCalled();
        });

        it('propagates a 429 with retryAfter and skips the model', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            consumeModelCall.mockRejectedValue(new AppError(429, 'Too many requests.', 42));

            await expect(analyze()).rejects.toMatchObject({ status: 429, retryAfter: 42 });
            expect(create).not.toHaveBeenCalled();
        });
    });

    describe('match cache', () => {
        const cacheRead = () => query.mock.calls.find(([sql]) => sql.includes('SELECT m.match_score'))!;
        const cacheWrite = () => query.mock.calls.find(([sql]) => sql.includes('INSERT INTO job_matches'));
        const memoWrite = () => query.mock.calls.find(([sql]) => sql.includes('INSERT INTO instruction_extractions'));
        const candidateHashSent = () => cacheRead()[1]![4];

        it('returns a cached score and instructions without calling the model', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            const instructions = [{ kind: 'external_application', instruction: 'Apply through Acme portal', description: 'https://acme.example/jobs' }];
            db({ memo: memoHit(instructions), score: scoreHit(72) });

            const result = await analyze();

            expect(create).not.toHaveBeenCalled();
            expect(cacheWrite()).toBeUndefined();
            expect(memoWrite()).toBeUndefined();
            expect(result).toEqual({ decision: 'APPLY', match_score: 72, rationale: 'Stored rationale.', employer_instructions: instructions });
        });

        it('keys the lookup on the posting, the user, the rendered candidate and SCORING_VERSION', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            create.mockResolvedValue(fit());

            await analyze();

            expect(cacheRead()[1]).toEqual([
                COMPANY, TITLE, normalizeAndHash(DESCRIPTION), USER_ID, expect.any(String), SCORING_VERSION,
            ]);
        });

        it('looks up a different candidate hash when the resume changes', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            create.mockResolvedValue(fit());
            await analyze();
            const before = candidateHashSent();

            query.mockClear();
            getCandidateContext.mockResolvedValue(
                candidateContext({ resume: { resume_text: 'Frontend engineer. React.', search_terms: [], enrichment_status: 'complete' } })
            );
            await analyze();

            expect(candidateHashSent()).not.toBe(before);
        });

        it('rescores and overwrites the row when the resume changed since it was scored', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            create.mockResolvedValue(fit());
            await analyze();
            const oldHash = candidateHashSent();

            const instructions = [{ kind: 'other', instruction: 'Email Acme recruiting', description: 'jobs@acme.example' }];
            query.mockReset();
            db({
                memo: memoHit(instructions),
                score: (params) => (params[4] === oldHash ? { rows: [{ match_score: 30 }] } : { rows: [] }),
            });
            create.mockClear();

            await analyze();
            expect(create).not.toHaveBeenCalled();

            getCandidateContext.mockResolvedValue(
                candidateContext({ resume: { resume_text: 'Frontend engineer. React.', search_terms: [], enrichment_status: 'complete' } })
            );
            const result = await analyze();

            expect(create).toHaveBeenCalledTimes(1);
            expect(result).toMatchObject({ match_score: 80, decision: 'APPLY' });
            const newHash = query.mock.calls.filter(([sql]) => sql.includes('SELECT m.match_score')).at(-1)![1]![4];
            const [, params] = cacheWrite()!;
            expect(newHash).not.toBe(oldHash);
            expect(params![4]).toBe(newHash);
            expect(params![6]).toBe(80);
        });

        it('saves the fresh score on a miss', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            create.mockResolvedValue(fit());

            await analyze();

            const [sql, params] = cacheWrite()!;
            expect(sql).not.toContain('employer_instructions');
            expect(params).toEqual([
                COMPANY, TITLE, normalizeAndHash(DESCRIPTION), USER_ID, candidateHashSent(), SCORING_VERSION, 80, 'Good fit.',
            ]);
        });

        it('calls the model when the score is cached but the posting has no memo row', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            db({ score: scoreHit(72) });
            create.mockResolvedValue(fit());

            await analyze();

            expect(create).toHaveBeenCalledTimes(1);
            expect(systemText()).toContain(EXTRACTION_RULES);
        });

        it('falls through to the model when the cache read fails', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            query.mockRejectedValueOnce(new Error('connection refused'));
            create.mockResolvedValue(fit());

            await expect(analyze()).resolves.toMatchObject({ match_score: 80 });
            expect(create).toHaveBeenCalledTimes(1);
        });

        it('still returns the score when the cache write fails', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            query.mockImplementation(async (sql: string) => {
                if (sql.includes('INSERT INTO')) throw new Error('connection refused');
                return { rows: [] };
            });
            create.mockResolvedValue(fit());

            await expect(analyze()).resolves.toMatchObject({ decision: 'APPLY', match_score: 80 });
        });
    });

    it('puts the rules and the rendered candidate in system and the job in messages', async () => {
        getCandidateContext.mockResolvedValue(candidateContext());
        create.mockResolvedValue(fit());

        await analyze();

        expect(systemText()).toContain(SCORING_RULES);
        expect(systemText()).toContain(`GRADUATION YEAR: ${GRAD_YEAR}`);
        expect(systemText()).toContain('Backend engineer. Node, Postgres, TypeScript.');
        expect(systemText()).toContain(EXTRACTION_RULES);
        for (const jobDetail of [COMPANY, TITLE, DESCRIPTION]) {
            expect(systemText()).not.toContain(jobDetail);
            expect(messageText()).toContain(jobDetail);
        }
    });

    it('orders system as scoring rules, candidate, extraction rules with breakpoints after the candidate and at the end', async () => {
        getCandidateContext.mockResolvedValue(candidateContext());
        create.mockResolvedValue(fit());

        await analyze();

        const blocks = lastRequest().system as { text: string; cache_control?: unknown }[];
        expect(blocks.map((block) => block.text)).toEqual([
            SCORING_RULES,
            expect.stringContaining('CANDIDATE:'),
            EXTRACTION_RULES,
        ]);
        expect(blocks.map((block) => block.cache_control)).toEqual([undefined, { type: 'ephemeral' }, { type: 'ephemeral' }]);
    });

    it('sends the same system block whatever the job_match sensitivity, and never mentions it', async () => {
        const systemFor = async (job_match: 'low' | 'high') => {
            getCandidateContext.mockResolvedValue(
                candidateContext({ preferences: { ...candidateContext().preferences, job_match } })
            );
            create.mockResolvedValue(fit());
            await analyze();
            return { system: systemText(), messages: messageText() };
        };

        const low = await systemFor('low');
        const high = await systemFor('high');

        expect(low.system).toBe(high.system);
        for (const text of [low.system, low.messages]) {
            expect(text).not.toMatch(/sensitivity|strict|lenient|DO_NOT_APPLY/i);
        }
    });

    it('throws 404 Resume not found when the candidate has no context', async () => {
        getCandidateContext.mockRejectedValue(new AppError(404, 'Candidate context not found.'));

        await expect(analyze()).rejects.toMatchObject({ status: 404, message: 'Resume not found.' });
        expect(create).not.toHaveBeenCalled();
    });

    it('throws 404 Resume not found when the candidate has no resume', async () => {
        getCandidateContext.mockResolvedValue(candidateContext({ resume: null }));

        await expect(analyze()).rejects.toMatchObject({ status: 404, message: 'Resume not found.' });
        expect(create).not.toHaveBeenCalled();
    });

    it('throws 404 Resume not found when the resume text is empty', async () => {
        getCandidateContext.mockResolvedValue(
            candidateContext({ resume: { resume_text: '', search_terms: [], enrichment_status: 'complete' } })
        );

        await expect(analyze()).rejects.toMatchObject({ status: 404, message: 'Resume not found.' });
        expect(create).not.toHaveBeenCalled();
    });

    it('propagates a non-404 candidate context failure as a 500', async () => {
        getCandidateContext.mockRejectedValue(new AppError(500, 'Error fetching candidate context.'));

        await expect(analyze()).rejects.toMatchObject({ status: 500 });
    });

    it('normalizes the employer instructions returned by the model', async () => {
        getCandidateContext.mockResolvedValue(candidateContext());
        create.mockResolvedValue(
            aiResponse({
                match_score: 80,
                rationale: 'Good fit.',
                employer_instructions: [
                    { kind: 'external_application', instruction: 'Apply through Acme portal', description: 'https://acme.example/jobs' },
                    { kind: 'external_application', instruction: 'Apply through Acme portal', description: 'https://acme.example/jobs' },
                    { kind: 'other', instruction: 'Disable your ad blocker', description: 'The form needs pop-ups enabled' },
                ],
            })
        );

        const result = await analyze();

        expect(result).toEqual({
            decision: 'APPLY',
            match_score: 80,
            rationale: 'Good fit.',
            employer_instructions: [
                { kind: 'external_application', instruction: 'Apply through Acme portal', description: 'https://acme.example/jobs' },
            ],
        });
    });

    it('keeps cover_letter kinds and turns unknown or missing kinds into other', async () => {
        getCandidateContext.mockResolvedValue(candidateContext());
        create.mockResolvedValue(
            aiResponse({
                match_score: 80,
                rationale: 'Good fit.',
                employer_instructions: [
                    { kind: 'cover_letter', instruction: 'Submit a cover letter to Acme', description: 'Required with the application' },
                    { kind: 'assessment', instruction: 'Complete Acme coding test', description: 'https://acme.example/test' },
                    { instruction: 'Email Acme recruiting', description: 'jobs@acme.example' },
                ],
            })
        );

        const result = await analyze();

        expect(result.employer_instructions.map((i: { kind: string }) => i.kind)).toEqual(['cover_letter', 'other', 'other']);
    });

    it('asks Haiku 4.5 for schema-constrained output without effort, which it rejects', async () => {
        getCandidateContext.mockResolvedValue(candidateContext());
        create.mockResolvedValue(aiResponse({ match_score: 80, rationale: 'Good fit.', employer_instructions: [] }));

        await analyze();

        const request = create.mock.calls[0]![0];
        expect(request.model).toBe('claude-haiku-4-5-20251001');
        expect(request.output_config).not.toHaveProperty('effort');
        expect(request.output_config.format.type).toBe('json_schema');
        expect(request.output_config.format.schema.properties.employer_instructions.items.properties.kind.enum)
            .toEqual(['external_application', 'cover_letter', 'other']);
    });

    it('reads the text block when a thinking block comes first', async () => {
        getCandidateContext.mockResolvedValue(candidateContext());
        create.mockResolvedValue({
            content: [
                { type: 'thinking', thinking: '', signature: 'sig' },
                { type: 'text', text: JSON.stringify({ match_score: 30, rationale: 'Different field.', employer_instructions: [] }) },
            ],
        });

        await expect(analyze()).resolves.toEqual({
            decision: 'DO_NOT_APPLY',
            match_score: 30,
            rationale: 'Different field.',
            employer_instructions: [],
        });
    });

    it('throws 502 when the response has no text block', async () => {
        getCandidateContext.mockResolvedValue(candidateContext());
        create.mockResolvedValue({ content: [{ type: 'thinking', thinking: '', signature: 'sig' }] });

        await expect(analyze()).rejects.toMatchObject({ status: 502 });
    });

    describe('redis cache', () => {
        const scoreReads = () => query.mock.calls.filter(([sql]) => sql.includes('SELECT m.match_score')).length;
        const memoReads = () => query.mock.calls.filter(([sql]) => sql.includes('FROM instruction_extractions')).length;
        const scoreKeys = () => [...redisStore.keys()].filter((key) => key.startsWith('job_match:'));

        it('serves a repeat request from redis without touching postgres or the model', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            db({ memo: memoHit([]), score: scoreHit(80) });

            await analyze();
            const result = await analyze();

            expect(scoreReads()).toBe(1);
            expect(memoReads()).toBe(1);
            expect(create).not.toHaveBeenCalled();
            expect(result).toMatchObject({ match_score: 80, employer_instructions: [] });
        });

        it('keys scores by scoring version and user, with a TTL', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            db({ memo: memoHit([]), score: scoreHit(80) });

            await analyze();

            const [key, value, ...ttl] = redisSet.mock.calls.find(([k]) => k.startsWith('job_match:'))!;
            expect(key).toMatch(new RegExp(`^job_match:v${SCORING_VERSION}:rationale:${USER_ID}:[0-9a-f]{64}$`));
            expect(JSON.parse(value)).toEqual({ match_score: 80, rationale: 'Stored rationale.' });
            expect(ttl).toEqual(['EX', 3600]);
        });

        it('does not cache a miss', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            create.mockResolvedValue(fit());

            await analyze();

            expect(scoreKeys()).toEqual([]);
        });

        it('writes a fresh score to redis once postgres stores it, so the next request skips the model', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            create.mockResolvedValue(fit());
            query.mockImplementation(async (sql: string) =>
                sql.includes('INSERT INTO') ? { rows: [{ won: true }], rowCount: 1 } : { rows: [] });

            await analyze();
            await analyze();

            expect(create).toHaveBeenCalledTimes(1);
            expect(scoreReads()).toBe(1);
        });

        it('misses when the candidate changes', async () => {
            db({ memo: memoHit([]), score: scoreHit(80) });
            getCandidateContext.mockResolvedValue(candidateContext());
            await analyze();

            getCandidateContext.mockResolvedValue(candidateContext({ profile: { grad_year: GRAD_YEAR + 1 } }));
            await analyze();

            expect(scoreReads()).toBe(2);
        });

        it('falls back to postgres when redis is down', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            db({ memo: memoHit([]), score: scoreHit(80) });
            redisGet.mockRejectedValue(new Error('redis down'));
            redisSet.mockRejectedValue(new Error('redis down'));

            const result = await analyze();

            expect(result).toMatchObject({ match_score: 80 });
            expect(create).not.toHaveBeenCalled();
        });
    });

    describe('instruction memo', () => {
        const memoRead = () => query.mock.calls.find(([sql]) => sql.includes('FROM instruction_extractions'))!;
        const memoWrite = () => query.mock.calls.find(([sql]) => sql.includes('INSERT INTO instruction_extractions'));
        const stored = [{ kind: 'external_application', instruction: 'Apply through Acme portal', description: 'https://acme.example/jobs' }];
        const scoreOnly = () => aiResponse({ match_score: 80, rationale: 'Good fit.' });

        it('looks up the posting hash under the current extraction version', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            create.mockResolvedValue(fit());

            await analyze();

            expect(memoRead()[1]).toEqual([normalizeAndHash(DESCRIPTION), EXTRACTION_VERSION]);
        });

        it('extracts on a miss and saves the instructions for the next user', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            create.mockResolvedValue(aiResponse({ match_score: 80, rationale: 'Good fit.', employer_instructions: stored }));

            await analyze();

            expect(systemText()).toContain(EXTRACTION_RULES);
            expect(memoWrite()![1]).toEqual([
                normalizeAndHash(DESCRIPTION),
                EXTRACTION_VERSION,
                'claude-haiku-4-5-20251001',
                ['external_application'],
                ['Apply through Acme portal'],
                ['https://acme.example/jobs'],
                ['acme.example'],
            ]);
        });

        it('gives a second user on the same posting one scoring-only call and the stored instructions', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            db({ memo: memoHit(stored) });
            create.mockResolvedValue(scoreOnly());

            const result = await analyze();

            expect(create).toHaveBeenCalledTimes(1);
            expect(systemText()).not.toContain(EXTRACTION_RULES);
            expect(lastRequest().output_config.format.schema.properties).not.toHaveProperty('employer_instructions');
            expect(memoWrite()).toBeUndefined();
            expect(result).toEqual({ decision: 'APPLY', match_score: 80, rationale: 'Good fit.', employer_instructions: stored });
        });

        it('ends the scoring-only system at the candidate breakpoint', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            db({ memo: memoHit(stored) });
            create.mockResolvedValue(scoreOnly());

            await analyze();

            const blocks = lastRequest().system as { text: string; cache_control?: unknown }[];
            expect(blocks.map((block) => block.text)).toEqual([SCORING_RULES, expect.stringContaining('CANDIDATE:')]);
            expect(blocks.map((block) => block.cache_control)).toEqual([undefined, { type: 'ephemeral' }]);
        });

        it('reuses an empty extraction instead of extracting again', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            db({ memo: memoHit([]) });
            create.mockResolvedValue(scoreOnly());

            const result = await analyze();

            expect(systemText()).not.toContain(EXTRACTION_RULES);
            expect(memoWrite()).toBeUndefined();
            expect(result.employer_instructions).toEqual([]);
        });

        it('falls back to the full prompt when the memo read fails', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            query.mockImplementation(async (sql: string) => {
                if (sql.includes('FROM instruction_extractions')) throw new Error('connection refused');
                return { rows: [] };
            });
            create.mockResolvedValue(fit());

            await expect(analyze()).resolves.toMatchObject({ match_score: 80 });
            expect(systemText()).toContain(EXTRACTION_RULES);
        });

        it('re-extracts a posting stored only under an older extraction version', async () => {
            getCandidateContext.mockResolvedValue(candidateContext());
            db({ memo: (params) => (params[1] === EXTRACTION_VERSION - 1 ? memoHit(stored)() : { rows: [] }) });
            create.mockResolvedValue(fit());

            await analyze();

            expect(systemText()).toContain(EXTRACTION_RULES);
            expect(memoWrite()![1]![1]).toBe(EXTRACTION_VERSION);
        });
    });

    describe('thresholds', () => {
        const withJobMatch = (job_match: 'low' | 'medium' | 'high') =>
            candidateContext({ preferences: { ...candidateContext().preferences, job_match } });

        it.each(['low', 'medium', 'high'] as const)('passes a %s score exactly at its threshold and fails one below', (job_match) => {
            expect(decideFromScore(MATCH_THRESHOLDS[job_match], job_match)).toBe('APPLY');
            expect(decideFromScore(MATCH_THRESHOLDS[job_match] - 1, job_match)).toBe('DO_NOT_APPLY');
        });

        it('orders the thresholds low < medium < high', () => {
            expect(MATCH_THRESHOLDS.low).toBeLessThan(MATCH_THRESHOLDS.medium);
            expect(MATCH_THRESHOLDS.medium).toBeLessThan(MATCH_THRESHOLDS.high);
        });

        it('falls back to the medium threshold for an unrecognized preference', () => {
            expect(decideFromScore(MATCH_THRESHOLDS.medium, 'unknown' as never)).toBe('APPLY');
            expect(decideFromScore(MATCH_THRESHOLDS.medium - 1, 'unknown' as never)).toBe('DO_NOT_APPLY');
        });

        it("applies the caller's job_match threshold to a fresh score", async () => {
            const score = MATCH_THRESHOLDS.medium;
            create.mockResolvedValue(aiResponse({ match_score: score, rationale: '', employer_instructions: [] }));

            getCandidateContext.mockResolvedValue(withJobMatch('medium'));
            await expect(analyze()).resolves.toMatchObject({ decision: 'APPLY', match_score: score });

            getCandidateContext.mockResolvedValue(withJobMatch('high'));
            await expect(analyze()).resolves.toMatchObject({ decision: 'DO_NOT_APPLY', match_score: score });
        });

        it('re-reads a cached score under a new preference without calling the model', async () => {
            const score = MATCH_THRESHOLDS.medium;
            db({ memo: memoHit([]), score: scoreHit(score) });

            getCandidateContext.mockResolvedValue(withJobMatch('low'));
            await expect(analyze()).resolves.toMatchObject({ decision: 'APPLY' });

            getCandidateContext.mockResolvedValue(withJobMatch('high'));
            await expect(analyze()).resolves.toMatchObject({ decision: 'DO_NOT_APPLY' });

            expect(create).not.toHaveBeenCalled();
        });
    });

    it.each([[101], [-1], [72.5], ['80'], [null]])('throws 502 for an invalid match score of %p', async (match_score) => {
        getCandidateContext.mockResolvedValue(candidateContext());
        create.mockResolvedValue(aiResponse({ match_score, rationale: '', employer_instructions: [] }));

        await expect(analyze()).rejects.toMatchObject({ status: 502, message: 'Invalid match score.' });
    });

    it('throws 502 when the model refuses', async () => {
        getCandidateContext.mockResolvedValue(candidateContext());
        create.mockResolvedValue({ stop_reason: 'refusal', content: [] });

        await expect(analyze()).rejects.toMatchObject({ status: 502 });
    });

    it('leaves integer bounds out of the schema, which structured output rejects', async () => {
        getCandidateContext.mockResolvedValue(candidateContext());
        create.mockResolvedValue(aiResponse({ match_score: 80, rationale: '', employer_instructions: [] }));

        await analyze();

        expect(create.mock.calls[0]![0].output_config.format.schema.properties.match_score)
            .toEqual({ type: 'integer' });
    });
});
