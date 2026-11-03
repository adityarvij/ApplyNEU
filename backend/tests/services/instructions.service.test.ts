import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const query = jest.fn<(text: string, params?: any[]) => Promise<any>>();

const redisStore = new Map<string, string>();
const redisGet = jest.fn<(key: string) => Promise<string | null>>();
const redisSet = jest.fn<(key: string, value: string, ...args: unknown[]) => Promise<string>>();

jest.unstable_mockModule('../../src/db/redis.ts', () => ({
    redis: { get: redisGet, set: redisSet },
}));

jest.unstable_mockModule('../../src/db/index.ts', () => ({
    pool: { query },
}));

const { destinationDomain, getInstructionIds, getInstructions, getInstructionsByIds, saveInstructions } = await import('../../src/services/instructions/instructions.service.ts');
const { EXTRACTION_VERSION } = await import('../../src/services/instructions/instructions.prompt.ts');

const HASH = 'abc123';
const INSTRUCTIONS = [
    { kind: 'external_application' as const, instruction: 'Apply through Acme careers portal', description: 'https://acme.com/jobs/1' },
];

const MODEL = 'claude-haiku-4-5-20251001';

/** The memo read's rows: one per stored step, or one all-null row for an empty extraction. */
const extracted = (instructions: unknown[]) => ({
    rows: instructions.length ? instructions : [{ kind: null, instruction: null, description: null }],
});

const lastCall = () => query.mock.calls[query.mock.calls.length - 1]!;

beforeEach(() => {
    query.mockReset();
    redisStore.clear();
    redisGet.mockReset().mockImplementation(async (key) => redisStore.get(key) ?? null);
    redisSet.mockReset().mockImplementation(async (key, value) => {
        redisStore.set(key, value);
        return 'OK';
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('destinationDomain', () => {
    it.each([
        ['https://www.Acme.com/jobs/1', 'acme.com'],
        ['Apply at http://careers.acme.com:8443/apply?id=1', 'careers.acme.com'],
        ['https://acme.wd5.myworkdayjobs.com#apply', 'acme.wd5.myworkdayjobs.com'],
        ['Email jobs@Acme.example with your transcript', 'acme.example'],
        ['https://ats.rippling.com/tive or recruiting@tive.com', 'ats.rippling.com'],
    ])('reads %s as %s', (text, domain) => {
        expect(destinationDomain(text)).toBe(domain);
    });

    it('returns null when the text has no URL or email', () => {
        expect(destinationDomain('Complete the HackerRank assessment')).toBeNull();
    });
});

describe('getInstructions', () => {
    it('looks up the posting hash under the current extraction version, in extraction order', async () => {
        query.mockResolvedValue({ rows: [] });

        await getInstructions(HASH);

        const [text, params] = lastCall();
        expect(text).toContain('FROM instruction_extractions');
        expect(text).toContain('LEFT JOIN job_instructions');
        expect(text).toContain('ORDER BY i.source, i.position');
        expect(params).toEqual([HASH, EXTRACTION_VERSION]);
    });

    it('returns null when the posting has no extraction header', async () => {
        query.mockResolvedValue({ rows: [] });

        await expect(getInstructions(HASH)).resolves.toBeNull();
    });

    it('returns the stored steps on a hit', async () => {
        query.mockResolvedValue(extracted(INSTRUCTIONS));

        await expect(getInstructions(HASH)).resolves.toEqual(INSTRUCTIONS);
    });

    it('returns an empty array, not null, for a header with no steps', async () => {
        query.mockResolvedValue(extracted([]));

        await expect(getInstructions(HASH)).resolves.toEqual([]);
    });

    it('serves a repeat hit from redis', async () => {
        query.mockResolvedValue(extracted(INSTRUCTIONS));

        await getInstructions(HASH);
        await expect(getInstructions(HASH)).resolves.toEqual(INSTRUCTIONS);

        expect(query).toHaveBeenCalledTimes(1);
        expect(redisSet).toHaveBeenCalledWith(`instructions:${EXTRACTION_VERSION}:${HASH}`, JSON.stringify(INSTRUCTIONS), 'EX', 7 * 24 * 3600);
    });

    it('keeps an empty extraction in redis too', async () => {
        query.mockResolvedValue(extracted([]));

        await getInstructions(HASH);
        await expect(getInstructions(HASH)).resolves.toEqual([]);

        expect(query).toHaveBeenCalledTimes(1);
    });

    it('does not cache a miss', async () => {
        query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(extracted(INSTRUCTIONS));

        await getInstructions(HASH);
        await expect(getInstructions(HASH)).resolves.toEqual(INSTRUCTIONS);
    });

    it('falls back to postgres when redis is down', async () => {
        redisGet.mockRejectedValueOnce(new Error('redis down'));
        query.mockResolvedValue(extracted(INSTRUCTIONS));

        await expect(getInstructions(HASH)).resolves.toEqual(INSTRUCTIONS);
    });

    it('treats a read failure as a miss', async () => {
        query.mockRejectedValue(new Error('connection lost'));

        await expect(getInstructions(HASH)).resolves.toBeNull();
    });
});

describe('getInstructionIds', () => {
    it('looks up the posting hash under the current extraction version, in extraction order', async () => {
        query.mockResolvedValue({ rows: [] });

        await getInstructionIds(HASH);

        const [text, params] = lastCall();
        expect(text).toContain('FROM instruction_extractions');
        expect(text).toContain('ORDER BY i.source, i.position');
        expect(params).toEqual([HASH, EXTRACTION_VERSION]);
    });

    it('returns null when the posting has no extraction header', async () => {
        query.mockResolvedValue({ rows: [] });

        await expect(getInstructionIds(HASH)).resolves.toBeNull();
    });

    it('returns the stored ids in order', async () => {
        query.mockResolvedValue({ rows: [{ instruction_id: 'instruction-1' }, { instruction_id: 'instruction-2' }] });

        await expect(getInstructionIds(HASH)).resolves.toEqual(['instruction-1', 'instruction-2']);
    });

    it('returns an empty array, not null, for a header with no steps', async () => {
        query.mockResolvedValue({ rows: [{ instruction_id: null }] });

        await expect(getInstructionIds(HASH)).resolves.toEqual([]);
    });

    it('reads postgres even when redis has the instructions', async () => {
        redisStore.set(`instructions:${EXTRACTION_VERSION}:${HASH}`, JSON.stringify(INSTRUCTIONS));
        query.mockResolvedValue({ rows: [{ instruction_id: 'instruction-1' }] });

        await getInstructionIds(HASH);

        expect(query).toHaveBeenCalledTimes(1);
    });

    it('throws a read failure instead of treating it as a miss', async () => {
        query.mockRejectedValue(new Error('connection lost'));

        await expect(getInstructionIds(HASH)).rejects.toThrow('connection lost');
    });
});

describe('getInstructionsByIds', () => {
    it('loads the instructions in the order of the ids', async () => {
        const rows = [{ instruction_id: 'instruction-2', ...INSTRUCTIONS[0] }];
        query.mockResolvedValue({ rows });

        await expect(getInstructionsByIds(['instruction-2', 'instruction-1'])).resolves.toEqual(rows);

        const [text, params] = lastCall();
        expect(text).toContain('WITH ORDINALITY');
        expect(text).toContain('ORDER BY wanted.position');
        expect(text).not.toContain('extraction_version');
        expect(params).toEqual([['instruction-2', 'instruction-1']]);
    });

    it('skips the query when there are no ids', async () => {
        await expect(getInstructionsByIds([])).resolves.toEqual([]);

        expect(query).not.toHaveBeenCalled();
    });
});

describe('saveInstructions', () => {
    it('writes the header and the steps in one statement, keeping the first write', async () => {
        query.mockResolvedValue({ rows: [{ won: true }] });

        await saveInstructions(HASH, INSTRUCTIONS, MODEL);

        expect(query).toHaveBeenCalledTimes(1);
        const [text] = lastCall();
        expect(text).toContain('INSERT INTO instruction_extractions');
        expect(text).toContain('ON CONFLICT (description_hash, extraction_version) DO NOTHING');
        expect(text).toContain('INSERT INTO job_instructions');
        expect(text).toContain('FROM header');
    });

    it('sends each step as parallel arrays with its destination domain', async () => {
        query.mockResolvedValue({ rows: [{ won: true }] });

        await saveInstructions(HASH, INSTRUCTIONS, MODEL);

        expect(lastCall()[1]).toEqual([
            HASH,
            EXTRACTION_VERSION,
            MODEL,
            ['external_application'],
            ['Apply through Acme careers portal'],
            ['https://acme.com/jobs/1'],
            ['acme.com'],
        ]);
    });

    it('stores an empty extraction as a header with no steps', async () => {
        query.mockResolvedValue({ rows: [{ won: true }] });

        await saveInstructions(HASH, [], MODEL);

        expect(lastCall()[1]!.slice(3)).toEqual([[], [], [], []]);
    });

    it('writes redis when this request won the insert', async () => {
        query.mockResolvedValue({ rows: [{ won: true }] });

        await saveInstructions(HASH, INSTRUCTIONS, MODEL);

        expect(redisStore.get(`instructions:${EXTRACTION_VERSION}:${HASH}`)).toBe(JSON.stringify(INSTRUCTIONS));
    });

    it('leaves redis alone when another request already stored the posting', async () => {
        query.mockResolvedValue({ rows: [{ won: false }] });

        await saveInstructions(HASH, INSTRUCTIONS, MODEL);

        expect(redisSet).not.toHaveBeenCalled();
    });

    it('does not throw when the write fails', async () => {
        query.mockRejectedValue(new Error('connection lost'));

        await expect(saveInstructions(HASH, INSTRUCTIONS, MODEL)).resolves.toBeUndefined();
    });
});
