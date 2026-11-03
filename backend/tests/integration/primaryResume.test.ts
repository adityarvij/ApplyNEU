import { jest, it, expect, beforeEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { describeWithDatabase, useTestDatabase } from './support/db.ts';

const db = useTestDatabase();

jest.unstable_mockModule('../../src/db/index.ts', () => ({ pool: db.pool }));

class DeleteObjectCommand {
    constructor(public input: { Bucket: string; Key: string }) {}
}
const s3Deletes: { Bucket: string; Key: string }[] = [];
let failS3Deletes = false;

// completeResumeUpload re-extracts text from S3. An empty body short-circuits the parse,
// so the upload path runs end to end against Postgres without a bucket or a PDF.
jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
    S3Client: class {
        async send(command: unknown) {
            if (command instanceof DeleteObjectCommand) {
                if (failS3Deletes) throw new Error('S3 unavailable');
                s3Deletes.push(command.input);
                return {};
            }
            return { Body: (async function* () {})() };
        }
    },
    GetObjectCommand: class {},
    PutObjectCommand: class {},
    DeleteObjectCommand,
}));

// The enrichment worker's model call, so search terms can be generated without an API key.
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
    default: class {
        messages = {
            create: async () => ({ content: [{ type: 'text', text: '["Software Engineer"]' }] }),
        };
    },
}));

const { getPrimaryResume, completeResumeUpload, listResumes, setPrimaryResume, retryEnrichment, setEnrichmentStatus, deleteResume } = await import('../../src/services/resume/resume.service.ts');
const { getSearchTerms } = await import('../../src/services/user/user.ai.service.ts');
const { getCandidateContext } = await import('../../src/services/candidateContext/candidateContext.service.ts');
const { getInterests, updateInterests } = await import('../../src/services/preference.service.ts');

const createUser = async () => {
    const { rows } = await db.pool.query(
        `INSERT INTO auth.users (raw_user_meta_data)
         VALUES ('{"first_name":"Test","last_name":"User","graduation_year":"2027"}'::jsonb)
         RETURNING id`
    );
    return rows[0].id as string;
};

// Enriched by default: only an enriched resume can be made primary, which most of
// these cases need as a starting point.
const addResume = async (user_id: string, file_name: string, created_at: string, enriched = true) => {
    const resume_id = randomUUID();
    const tags = enriched ? '{ai}' : '{}';
    await db.pool.query(
        `INSERT INTO resumes (resume_id, key, created_at, user_id, file_name, file_size_bytes, resume_text, upload_complete, search_terms, enrichment_status)
         VALUES ($1, $2, $3, $4, $5, 1024, $6, true, $7, $8)`,
        [resume_id, `resumes/${resume_id}.pdf`, created_at, user_id, file_name, `text of ${file_name}`, tags, enriched ? 'complete' : 'none']
    );
    return resume_id;
};

const addUnfinishedResume = async (user_id: string) => {
    const resume_id = randomUUID();
    await db.pool.query(
        `INSERT INTO resumes (resume_id, key, created_at, user_id, file_name, file_size_bytes, resume_text, upload_complete, search_terms)
         VALUES ($1, $2, '2026-02-01T00:00:00Z', $3, 'uploaded.pdf', 1024, '', false, '{}')`,
        [resume_id, `resumes/${resume_id}.pdf`, user_id]
    );
    return resume_id;
};

const setPrimary = (user_id: string, resume_id: string | null) =>
    db.pool.query(`UPDATE preferences SET primary_resume_id = $1 WHERE user_id = $2`, [resume_id, user_id]);

const readPrimary = async (user_id: string) => {
    const { rows } = await db.pool.query(`SELECT primary_resume_id FROM preferences WHERE user_id = $1`, [user_id]);
    return rows[0]?.primary_resume_id ?? null;
};

describeWithDatabase('primary resume against Postgres', () => {
    let user: string;
    let older: string;
    let newer: string;

    beforeEach(async () => {
        user = await createUser();
        older = await addResume(user, 'older.pdf', '2026-01-01T00:00:00Z');
        newer = await addResume(user, 'newer.pdf', '2026-06-01T00:00:00Z');
    });

    it('rejects a primary that belongs to another user', async () => {
        const stranger = await createUser();
        const theirResume = await addResume(stranger, 'stranger.pdf', '2026-03-01T00:00:00Z');

        await expect(setPrimary(user, theirResume)).rejects.toMatchObject({ code: '23503' });
    });

    it('clears the pointer rather than failing when the chosen resume is deleted', async () => {
        await setPrimary(user, older);

        await db.pool.query(`DELETE FROM resumes WHERE resume_id = $1`, [older]);

        expect(await readPrimary(user)).toBeNull();
        const { rows } = await db.pool.query(`SELECT user_id FROM preferences WHERE user_id = $1`, [user]);
        expect(rows).toHaveLength(1);
    });

    it('getPrimaryResume prefers the chosen resume over a newer one', async () => {
        await setPrimary(user, older);

        expect((await getPrimaryResume(user)).resume_id).toBe(older);
    });

    it('getPrimaryResume falls back to the newest when no primary is set', async () => {
        expect(await readPrimary(user)).toBeNull();

        expect((await getPrimaryResume(user)).resume_id).toBe(newer);
    });

    it('getPrimaryResume returns null for a user with no resumes', async () => {
        expect(await getPrimaryResume(await createUser())).toBeNull();
    });

    it('getCandidateContext renders the chosen resume, not the newest', async () => {
        await setPrimary(user, older);

        const context = await getCandidateContext(user);

        expect(context.resume?.resume_text).toBe('text of older.pdf');
    });

    it("getCandidateContext returns the chosen resume's enrichment status", async () => {
        await setPrimary(user, older);
        await db.pool.query(`UPDATE resumes SET search_terms = '{}', enrichment_status = 'failed' WHERE resume_id = $1`, [older]);

        const context = await getCandidateContext(user);

        expect(context.resume).toMatchObject({ search_terms: [], enrichment_status: 'failed' });
    });

    it('getCandidateContext falls back to the newest when no primary is set', async () => {
        const context = await getCandidateContext(user);

        expect(context.resume?.resume_text).toBe('text of newer.pdf');
    });

    it('getCandidateContext returns a null resume when none has finished uploading', async () => {
        const fresh = await createUser();
        await addUnfinishedResume(fresh);

        const context = await getCandidateContext(fresh);

        expect(context.resume).toBeNull();
        expect(context.profile.grad_year).toBe(2027);
    });

    it('listResumes returns the resumes newest first, flagging the chosen one', async () => {
        await setPrimary(user, older);

        const rows = await listResumes(user);

        expect(rows.map((row) => row.resume_id)).toEqual([newer, older]);
        expect(rows.map((row) => row.is_primary)).toEqual([false, true]);
    });

    it('listResumes flags nothing when no primary is set', async () => {
        const rows = await listResumes(user);

        expect(rows.every((row) => row.is_primary === false)).toBe(true);
    });

    it('listResumes reports each resume\'s enrichment status', async () => {
        await db.pool.query(`UPDATE resumes SET search_terms = '{}', enrichment_status = 'pending' WHERE resume_id = $1`, [older]);
        const bare = await addResume(user, 'bare.pdf', '2026-03-01T00:00:00Z', false);

        const rows = await listResumes(user);
        const statusOf = (id: string) => rows.find((row) => row.resume_id === id)?.enrichment_status;

        expect(statusOf(older)).toBe('pending');
        expect(statusOf(newer)).toBe('complete');
        expect(statusOf(bare)).toBe('none');
    });

    it('setPrimaryResume rejects a complete resume that has no search terms', async () => {
        await db.pool.query(`UPDATE resumes SET search_terms = '{}' WHERE resume_id = $1`, [newer]);

        await expect(setPrimaryResume(newer, user)).rejects.toMatchObject({ status: 400 });
        expect(await readPrimary(user)).toBeNull();
    });

    it.each(['pending', 'failed'] as const)('setPrimaryResume rejects a resume whose enrichment is %s', async (status) => {
        await setEnrichmentStatus(newer, status);

        await expect(setPrimaryResume(newer, user)).rejects.toMatchObject({ status: 400 });
        expect(await readPrimary(user)).toBeNull();
    });

    it('rejects an enrichment status outside the enum', async () => {
        await expect(
            db.pool.query(`UPDATE resumes SET enrichment_status = 'sending' WHERE resume_id = $1`, [newer])
        ).rejects.toMatchObject({ code: '23514' });
    });

    it('updateInterests replaces the stored interests and leaves every resume and the pointer alone', async () => {
        await setPrimary(user, newer);
        const before = await listResumes(user);

        await updateInterests(user, ['Fintech', 'Data Science']);

        expect(await getInterests(user)).toEqual({ interests: ['Fintech', 'Data Science'] });
        expect(await listResumes(user)).toEqual(before);
        expect(await readPrimary(user)).toBe(newer);
    });

    it('updateInterests 404s for a user with no preferences row', async () => {
        await expect(updateInterests(randomUUID(), ['Fintech'])).rejects.toMatchObject({ status: 404 });
    });

    it('saving interests stores them on the user, so they follow a change of primary', async () => {
        await updateInterests(user, ['Fintech', 'Data Science']);
        await setPrimary(user, older);

        const context = await getCandidateContext(user);

        expect(context.resume?.resume_text).toBe('text of older.pdf');
        expect(context.preferences.interests).toEqual(['Fintech', 'Data Science']);
    });

    it('retryEnrichment moves a failed enrichment back to pending', async () => {
        await setEnrichmentStatus(newer, 'failed');

        expect(await retryEnrichment(newer, user)).toEqual({ resume_id: newer, enrichment_status: 'pending' });
    });

    it('retryEnrichment allows three retries, then refuses with 429 and stops offering one', async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            await setEnrichmentStatus(newer, 'failed');
            expect((await listResumes(user)).find((row) => row.resume_id === newer)?.can_retry).toBe(true);
            await retryEnrichment(newer, user);
        }
        await setEnrichmentStatus(newer, 'failed');

        await expect(retryEnrichment(newer, user)).rejects.toMatchObject({ status: 429 });
        expect((await listResumes(user)).find((row) => row.resume_id === newer)?.can_retry).toBe(false);
    });

    it('retryEnrichment starts a finished upload whose enrichment never started', async () => {
        await setEnrichmentStatus(newer, 'none');
        expect((await listResumes(user)).find((row) => row.resume_id === newer)?.can_retry).toBe(true);

        expect(await retryEnrichment(newer, user)).toEqual({ resume_id: newer, enrichment_status: 'pending' });
    });

    it('retryEnrichment refuses an unfinished upload', async () => {
        const uploaded = await addUnfinishedResume(user);

        await expect(retryEnrichment(uploaded, user)).rejects.toMatchObject({ status: 409 });
    });

    it.each(['pending', 'complete'] as const)('retryEnrichment refuses a resume whose enrichment is %s', async (status) => {
        await setEnrichmentStatus(newer, status);

        await expect(retryEnrichment(newer, user)).rejects.toMatchObject({ status: 409 });
    });

    it('retryEnrichment 404s on a resume the caller does not own, leaving it failed', async () => {
        const stranger = await createUser();
        const theirResume = await addResume(stranger, 'stranger.pdf', '2026-03-01T00:00:00Z');
        await setEnrichmentStatus(theirResume, 'failed');

        await expect(retryEnrichment(theirResume, user)).rejects.toMatchObject({ status: 404 });

        expect((await listResumes(stranger)).find((row) => row.resume_id === theirResume)?.enrichment_status).toBe('failed');
    });

    it('deleteResume removes the row', async () => {
        expect(await deleteResume(older, user)).toEqual({ resume_id: older });

        expect((await listResumes(user)).map((row) => row.resume_id)).toEqual([newer]);
    });

    it('deleteResume deletes the PDF from S3 after the row', async () => {
        s3Deletes.length = 0;

        await deleteResume(older, user);

        expect(s3Deletes).toEqual([{ Bucket: process.env.S3_BUCKET_NAME, Key: `resumes/${older}.pdf` }]);
    });

    it('deleteResume still removes the row when the S3 delete fails', async () => {
        failS3Deletes = true;
        try {
            expect(await deleteResume(older, user)).toEqual({ resume_id: older });
        } finally {
            failS3Deletes = false;
        }

        expect((await listResumes(user)).map((row) => row.resume_id)).toEqual([newer]);
    });

    it('deleteResume removes an unfinished upload and its object', async () => {
        s3Deletes.length = 0;
        const unfinished = await addUnfinishedResume(user);

        expect(await deleteResume(unfinished, user)).toEqual({ resume_id: unfinished });

        expect(s3Deletes.map((input) => input.Key)).toEqual([`resumes/${unfinished}.pdf`]);
    });

    it('deleteResume 404s on a resume the caller does not own, leaving it in place', async () => {
        const stranger = await createUser();
        const theirResume = await addResume(stranger, 'stranger.pdf', '2026-03-01T00:00:00Z');

        s3Deletes.length = 0;
        await expect(deleteResume(theirResume, user)).rejects.toMatchObject({ status: 404 });

        expect((await listResumes(stranger)).map((row) => row.resume_id)).toEqual([theirResume]);
        expect(s3Deletes).toEqual([]);
    });

    it('deleting the primary clears the pointer and falls back to the newest remaining resume', async () => {
        await setPrimary(user, older);

        await deleteResume(older, user);

        expect(await readPrimary(user)).toBeNull();
        expect((await getPrimaryResume(user))?.resume_id).toBe(newer);
    });

    it('setPrimaryResume moves the pointer', async () => {
        expect(await setPrimaryResume(older, user)).toEqual({ primary_resume_id: older });

        expect(await readPrimary(user)).toBe(older);
    });

    it('setPrimaryResume 404s on a resume the caller does not own, leaving the pointer alone', async () => {
        await setPrimary(user, older);
        const stranger = await createUser();
        const theirResume = await addResume(stranger, 'stranger.pdf', '2026-03-01T00:00:00Z');

        await expect(setPrimaryResume(theirResume, user)).rejects.toMatchObject({ status: 404 });

        expect(await readPrimary(user)).toBe(older);
    });

    it('setPrimaryResume rejects a resume whose upload never completed', async () => {
        const pending = randomUUID();
        await db.pool.query(
            `INSERT INTO resumes (resume_id, key, created_at, user_id, file_name, file_size_bytes, resume_text, upload_complete)
             VALUES ($1, $2, '2026-02-01T00:00:00Z', $3, 'pending.pdf', 1024, '', false)`,
            [pending, `resumes/${pending}.pdf`, user]
        );

        await expect(setPrimaryResume(pending, user)).rejects.toMatchObject({ status: 400 });

        expect(await readPrimary(user)).toBeNull();
    });

    it('completing an upload makes it the primary, replacing the one the user was running', async () => {
        await setPrimary(user, older);
        const uploaded = await addUnfinishedResume(user);

        await completeResumeUpload(uploaded, `resumes/${uploaded}.pdf`, user);

        expect(await readPrimary(user)).toBe(uploaded);
    });

    it('completing an upload marks enrichment pending', async () => {
        const uploaded = await addUnfinishedResume(user);

        await completeResumeUpload(uploaded, `resumes/${uploaded}.pdf`, user);

        expect((await listResumes(user)).find((row) => row.resume_id === uploaded)?.enrichment_status).toBe('pending');
    });

    it('saving interests leaves the pointer alone', async () => {
        await setPrimary(user, older);

        await updateInterests(user, ['Fintech']);

        expect(await readPrimary(user)).toBe(older);
    });

    it('finishing enrichment leaves the pointer alone', async () => {
        await setPrimary(user, older);
        await db.pool.query(`UPDATE resumes SET enrichment_status = 'pending' WHERE resume_id = $1`, [newer]);

        await getSearchTerms(newer);

        expect(await readPrimary(user)).toBe(older);
        expect((await listResumes(user)).find((row) => row.resume_id === newer)?.enrichment_status).toBe('complete');
    });
});
