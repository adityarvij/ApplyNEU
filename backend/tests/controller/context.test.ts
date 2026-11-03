import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import { AppError } from '../../src/errors/AppError.ts';

jest.unstable_mockModule('../../src/services/candidateContext/candidateContext.service.ts', () => ({
  getCandidateContext: jest.fn(),
  renderCandidateContext: jest.fn(),
}));

jest.unstable_mockModule('../../src/controller/middleware/authenticate.ts', () => ({
  authenticate: jest.fn((req: { auth?: { userId: string } }, _res: unknown, next: () => void) => {
    req.auth = { userId: USER_ID };
    next();
  }),
}));

const { getCandidateContext } = await import('../../src/services/candidateContext/candidateContext.service.ts');
const { authenticate } = await import('../../src/controller/middleware/authenticate.ts');
const { app } = await import('../../src/app.ts');

const USER_ID = 'test-user-id';

type ServiceMock = jest.Mock<(...args: any[]) => Promise<any>>;
type MiddlewareMock = jest.Mock<(...args: any[]) => any>;

const mockGetCandidateContext = getCandidateContext as ServiceMock;
const mockAuthenticate = authenticate as MiddlewareMock;

const CONTEXT = {
  resume: {
    resume_text: 'Backend engineer. Node, Postgres, TypeScript.',
    search_terms: ['backend'],
    enrichment_status: 'complete',
  },
  preferences: {
    job_match: 'high',
    wait_for_approval: false,
    job_types: ['Co-op'],
    unpaid_roles: false,
    recent_jobs: true,
    interests: ['distributed systems'],
  },
  profile: { grad_year: 2027 },
};

beforeEach(() => {
  mockGetCandidateContext.mockReset();
  mockAuthenticate.mockReset();
  mockAuthenticate.mockImplementation(
    (req: { auth?: { userId: string } }, _res: unknown, next: () => void) => {
      req.auth = { userId: USER_ID };
      next();
    }
  );
});

describe('GET /me/context', () => {
  const url = '/me/context';

  it('returns the assembled profile for the authenticated caller', async () => {
    mockGetCandidateContext.mockResolvedValue(CONTEXT);

    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(CONTEXT);
    expect(mockGetCandidateContext).toHaveBeenCalledWith(USER_ID);
  });

  it('identifies the caller by the token rather than a url param', async () => {
    mockGetCandidateContext.mockResolvedValue(CONTEXT);
    mockAuthenticate.mockImplementation(
      (req: { auth?: { userId: string } }, _res: unknown, next: () => void) => {
        req.auth = { userId: 'someone-else' };
        next();
      }
    );

    await request(app).get(url);

    expect(mockGetCandidateContext).toHaveBeenCalledWith('someone-else');
  });

  it('returns 401 when the token is rejected', async () => {
    mockAuthenticate.mockImplementation(
      (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) =>
        res.status(401).json({ message: 'Unauthorized.' })
    );

    const res = await request(app).get(url);

    expect(res.status).toBe(401);
    expect(mockGetCandidateContext).not.toHaveBeenCalled();
  });

  it('returns 200 with a null resume when the caller has no finished resume', async () => {
    mockGetCandidateContext.mockResolvedValue({ ...CONTEXT, resume: null });

    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.body.resume).toBeNull();
    expect(res.body.preferences).toEqual(CONTEXT.preferences);
  });

  it('propagates a 404 when the caller has no candidate context', async () => {
    mockGetCandidateContext.mockRejectedValue(new AppError(404, 'Candidate context not found.'));

    const res = await request(app).get(url);

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Candidate context not found.');
  });

  it('returns 500 when the service throws a non-AppError', async () => {
    mockGetCandidateContext.mockRejectedValue(new Error('boom'));

    const res = await request(app).get(url);

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Internal server error.');
  });
});
