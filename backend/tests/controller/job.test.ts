import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import { AppError } from '../../src/errors/AppError.ts';

const analyzeJob =
  jest.fn<(user_id: string, job_description: string, company?: string, title?: string) => Promise<any>>();
const getJobAnalysis = jest.fn<(run_id: string, user_id: string) => Promise<any>>();
const addJob = jest.fn<(company: string, title: string, description: string) => Promise<any>>();

const authenticate = jest.fn((req: any, _res: any, next: any) => {
  req.auth = { userId: USER_ID };
  next();
});

jest.unstable_mockModule('../../src/services/job.service.ts', () => ({
  addJob,
}));

jest.unstable_mockModule('../../src/services/jobRun/jobRun.service.ts', () => ({
  analyzeJob,
  getJobAnalysis,
}));

jest.unstable_mockModule('../../src/controller/middleware/authenticate.ts', () => ({
  authenticate: (req: any, res: any, next: any) => authenticate(req, res, next),
}));

const { app } = await import('../../src/app.ts');

const USER_ID = 'test-user-id';
const JOB_DESCRIPTION = 'We are hiring a Software Engineer to build great things.';
const COMPANY = 'Acme';
const TITLE = 'Software Engineer';

const rejectAuth = () =>
  authenticate.mockImplementation((_req: any, res: any) =>
    res.status(401).json({ message: 'Unauthorized.' })
  );

beforeEach(() => {
  analyzeJob.mockReset();
  getJobAnalysis.mockReset();
  addJob.mockReset();
  authenticate.mockReset();
  authenticate.mockImplementation((req: any, _res: any, next: any) => {
    req.auth = { userId: USER_ID };
    next();
  });
});

describe('POST /me/jobs/analyze', () => {
  const url = '/me/jobs/analyze';

  it('returns 202 and the queued run on valid input', async () => {
    const decision = { run_id: 'run-1', status: 'queued' };
    analyzeJob.mockResolvedValue(decision);

    const res = await request(app)
      .post(url)
      .send({ job_description: JOB_DESCRIPTION, company: COMPANY, title: TITLE });

    expect(res.status).toBe(202);
    expect(res.body).toEqual(decision);
    expect(analyzeJob).toHaveBeenCalledWith(USER_ID, JOB_DESCRIPTION, COMPANY, TITLE);
  });

  it('returns 400 when company is missing', async () => {
    const res = await request(app).post(url).send({ job_description: JOB_DESCRIPTION, title: TITLE });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('company is required.');
    expect(analyzeJob).not.toHaveBeenCalled();
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(app).post(url).send({ job_description: JOB_DESCRIPTION, company: COMPANY });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('title is required.');
    expect(analyzeJob).not.toHaveBeenCalled();
  });

  it.each([
    ['company', { job_description: JOB_DESCRIPTION, company: '', title: TITLE }, 'company is required.'],
    ['title', { job_description: JOB_DESCRIPTION, company: COMPANY, title: '' }, 'title is required.'],
    ['company (whitespace only)', { job_description: JOB_DESCRIPTION, company: '   ', title: TITLE }, 'company is required.'],
    ['title (whitespace only)', { job_description: JOB_DESCRIPTION, company: COMPANY, title: '   ' }, 'title is required.'],
  ])('returns 400 when %s is empty', async (_label, body, message) => {
    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    expect(analyzeJob).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from company and title before calling the service', async () => {
    analyzeJob.mockResolvedValue({ run_id: 'run-1', status: 'queued' });

    const res = await request(app)
      .post(url)
      .send({ job_description: JOB_DESCRIPTION, company: '  Acme  ', title: '  Software Engineer  ' });

    expect(res.status).toBe(202);
    expect(analyzeJob).toHaveBeenCalledWith(USER_ID, JOB_DESCRIPTION, COMPANY, TITLE);
  });

  it('ignores extra body fields and only forwards the known ones', async () => {
    analyzeJob.mockResolvedValue({ run_id: 'run-1', status: 'queued' });

    const res = await request(app)
      .post(url)
      .send({
        job_description: JOB_DESCRIPTION,
        company: COMPANY,
        title: TITLE,
        status: 'draft',
        salary: 123456,
      });

    expect(res.status).toBe(202);
    expect(analyzeJob).toHaveBeenCalledWith(USER_ID, JOB_DESCRIPTION, COMPANY, TITLE);
  });

  it('returns 400 when job_description is missing', async () => {
    const res = await request(app).post(url).send({ company: COMPANY, title: TITLE });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('job_description is required.');
    expect(analyzeJob).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is empty', async () => {
    const res = await request(app).post(url).send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('job_description is required.');
    expect(analyzeJob).not.toHaveBeenCalled();
  });

  it('returns 400 when job_description is an empty string', async () => {
    const res = await request(app).post(url).send({ job_description: '' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('job_description is required.');
    expect(analyzeJob).not.toHaveBeenCalled();
  });

  it('returns 400 when job_description is whitespace only', async () => {
    const res = await request(app).post(url).send({ job_description: '   ', company: COMPANY, title: TITLE });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('job_description is required.');
    expect(analyzeJob).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from job_description before calling the service', async () => {
    analyzeJob.mockResolvedValue({ run_id: 'run-1', status: 'queued' });

    const res = await request(app)
      .post(url)
      .send({ job_description: `  ${JOB_DESCRIPTION}  `, company: COMPANY, title: TITLE });

    expect(res.status).toBe(202);
    expect(analyzeJob).toHaveBeenCalledWith(USER_ID, JOB_DESCRIPTION, COMPANY, TITLE);
  });

  it('returns 401 when the token is rejected', async () => {
    rejectAuth();

    const res = await request(app)
      .post(url)
      .send({ job_description: JOB_DESCRIPTION, company: COMPANY, title: TITLE });

    expect(res.status).toBe(401);
    expect(analyzeJob).not.toHaveBeenCalled();
  });

  it('authenticates before validating the body (invalid body + rejected token -> 401)', async () => {
    rejectAuth();

    const res = await request(app).post(url).send({}); // missing job_description

    expect(res.status).toBe(401);
    expect(analyzeJob).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After when the service is rate limited', async () => {
    analyzeJob.mockRejectedValue(new AppError(429, 'Too many requests.', 38));

    const res = await request(app)
      .post(url)
      .send({ job_description: JOB_DESCRIPTION, company: COMPANY, title: TITLE });

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('38');
    expect(res.body.message).toBe('Too many requests.');
  });

  it('omits Retry-After on errors that do not set it', async () => {
    analyzeJob.mockRejectedValue(new AppError(404, 'Resume not found.'));

    const res = await request(app)
      .post(url)
      .send({ job_description: JOB_DESCRIPTION, company: COMPANY, title: TITLE });

    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('propagates an AppError status from the service (e.g. 404 resume not found)', async () => {
    analyzeJob.mockRejectedValue(new AppError(404, 'Resume not found.'));

    const res = await request(app)
      .post(url)
      .send({ job_description: JOB_DESCRIPTION, company: COMPANY, title: TITLE });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Resume not found.');
  });

  it('returns 500 when the service throws a non-AppError', async () => {
    analyzeJob.mockRejectedValue(new Error('boom'));

    const res = await request(app)
      .post(url)
      .send({ job_description: JOB_DESCRIPTION, company: COMPANY, title: TITLE });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Internal server error.');
  });
});

describe('GET /me/jobs/analyze/:run_id', () => {
  const RUN_ID = '3f1c2a4e-8b7d-4c6a-9e2f-1a2b3c4d5e6f';
  const url = `/me/jobs/analyze/${RUN_ID}`;

  it("returns 200 and the run's analysis for the caller", async () => {
    const analysis = { run_id: RUN_ID, status: 'done', decision: 'APPLY', match_score: 72, employer_instructions: [] };
    getJobAnalysis.mockResolvedValue(analysis);

    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(analysis);
    expect(getJobAnalysis).toHaveBeenCalledWith(RUN_ID, USER_ID);
  });

  it('returns 400 when run_id is not a UUID', async () => {
    const res = await request(app).get('/me/jobs/analyze/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('run_id must be a UUID.');
    expect(getJobAnalysis).not.toHaveBeenCalled();
  });

  it('propagates a 404 from the service', async () => {
    getJobAnalysis.mockRejectedValue(new AppError(404, 'Agent run not found.'));

    const res = await request(app).get(url);

    expect(res.status).toBe(404);
  });

  it('returns 401 when the token is rejected', async () => {
    rejectAuth();

    const res = await request(app).get(url);

    expect(res.status).toBe(401);
    expect(getJobAnalysis).not.toHaveBeenCalled();
  });
});

describe('POST /jobs/add', () => {
  const url = '/jobs/add';
  const validBody = { company: COMPANY, title: TITLE, description: 'A great role.' };

  it('returns 200 and the created job on valid input', async () => {
    const created = { job_id: 'job-1', ...validBody };
    addJob.mockResolvedValue(created);

    const res = await request(app).post(url).send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(created);
    expect(addJob).toHaveBeenCalledWith(validBody.company, validBody.title, validBody.description);
  });

  it('ignores extra body fields and only forwards company, title, description', async () => {
    addJob.mockResolvedValue({ job_id: 'job-1' });

    const res = await request(app)
      .post(url)
      .send({ ...validBody, user_id: USER_ID, status: 'draft' });

    expect(res.status).toBe(200);
    expect(addJob).toHaveBeenCalledWith(validBody.company, validBody.title, validBody.description);
  });

  it('returns 400 when company is missing', async () => {
    const res = await request(app).post(url).send({ title: TITLE, description: 'A great role.' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('company is required.');
    expect(addJob).not.toHaveBeenCalled();
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(app).post(url).send({ company: COMPANY, description: 'A great role.' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('title is required.');
    expect(addJob).not.toHaveBeenCalled();
  });

  it('returns 400 when description is missing', async () => {
    const res = await request(app).post(url).send({ company: COMPANY, title: TITLE });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('description is required.');
    expect(addJob).not.toHaveBeenCalled();
  });

  it('returns 400 with the first error (company) when the body is empty', async () => {
    const res = await request(app).post(url).send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('company is required.');
    expect(addJob).not.toHaveBeenCalled();
  });

  it('returns 400 when a required field is an empty string', async () => {
    const res = await request(app)
      .post(url)
      .send({ company: '', title: TITLE, description: 'A great role.' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('company is required.');
    expect(addJob).not.toHaveBeenCalled();
  });

  it.each([
    ['company', { company: '   ', title: TITLE, description: 'A great role.' }, 'company is required.'],
    ['title', { company: COMPANY, title: '   ', description: 'A great role.' }, 'title is required.'],
    ['description', { company: COMPANY, title: TITLE, description: '   ' }, 'description is required.'],
  ])('returns 400 when %s is whitespace only', async (_label, body, message) => {
    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    expect(addJob).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from all fields before calling the service', async () => {
    addJob.mockResolvedValue({ job_id: 'job-1' });

    const res = await request(app)
      .post(url)
      .send({ company: '  Acme  ', title: '  Software Engineer  ', description: '  A great role.  ' });

    expect(res.status).toBe(200);
    expect(addJob).toHaveBeenCalledWith(COMPANY, TITLE, 'A great role.');
  });

  it('propagates an AppError status from the service', async () => {
    addJob.mockRejectedValue(new AppError(409, 'Job already exists.'));

    const res = await request(app).post(url).send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Job already exists.');
  });

  it('returns 500 when the service throws a non-AppError', async () => {
    addJob.mockRejectedValue(new Error('boom'));

    const res = await request(app).post(url).send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Internal server error.');
  });
});

export { USER_ID };
