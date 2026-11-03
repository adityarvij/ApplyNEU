# ApplyNEU

A desktop app that applies to co-op jobs on NUWorks for Northeastern students.

You upload your resume, pick your interests and how picky the bot should be, and press
play. The app opens NUWorks inside its own window, you sign in like normal, and it works
through job searches built from your resume. Each posting gets scored against your resume,
and the ones above your threshold get applied to, with your approval first if you want it.
Extra steps an employer asks for (apply on our site, send a cover letter) end up on a task
list so nothing gets missed.

## How it fits together

- **Electron + React** (`electron/`, `frontend/`): the app window. The bot runs here,
  driving NUWorks in an embedded browser with injected JavaScript. Your NUWorks login never
  leaves that browser.
- **Express API** (`backend/src`): auth, resumes, job scoring, applications and tasks.
- **Worker** (`backend/src/workers`): a BullMQ worker that turns a new resume into NUWorks
  search terms in the background.
- **Postgres** on Supabase for data and auth, **Redis** for caching, the job queue and rate
  limits, and **S3** for resume PDFs.
- **Claude Haiku 4.5** scores each posting and generates search terms.

[ARCHITECTURE.md](ARCHITECTURE.md) has the full design and the reasoning behind it.

## Running it locally

You need Node 20+, Docker, a Supabase project, an S3 bucket and an Anthropic API key.

### 1. Backend

Create `backend/.env`:

```
DB_HOST=
DB_PORT=
DB_NAME=
DB_USER=
DB_PASSWORD=
DEV_SUPABASE_URL=
ANTHROPIC_API_KEY=
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET_NAME=
```

Apply `backend/db/schema.sql` to your Supabase database, then start the API, worker and
Redis:

```
docker compose up -d --build
```

The API listens on `localhost:8080`. `GET /healthz` and `GET /readyz` tell you whether it's
up and whether it can reach Postgres. Swagger docs are at `/api-docs`.

To run the backend without Docker instead, start Redis yourself and run `npm run dev` and
`npm run worker` from `backend/`.

### 2. App

Create `frontend/.env`:

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

`VITE_API_URL` is optional and defaults to `http://localhost:8080`.

Then from the repo root:

```
npm install
cd frontend && npm install && cd ..
npm run dev
```

That starts Vite and opens the Electron window once it's ready.

## Tests

```
cd backend
npm test                      # unit tests, no database needed
npm run typecheck
npm run lint
```

Integration tests run against a throwaway Postgres in Docker:

```
docker compose --profile test up -d postgres-test
cd backend && npm run test:integration
```

See [backend/tests/integration/README.md](backend/tests/integration/README.md) for how they
stay isolated. Frontend tests run with `npm test` from `frontend/`.

## Configuration worth knowing about

| Variable | What it does |
|---|---|
| `PORT` | API port, defaults to 8080 |
| `TRUST_PROXY` | Set to `1` behind a load balancer so the API reads the real client IP |
| `JOB_MATCH_LIMIT_PER_MINUTE` / `_PER_DAY` | Per-user scoring limits, default 20 and 200 |
| `INSTRUCTIONS_LIMIT_PER_MINUTE` / `_PER_DAY` | Per-user limits on instruction extraction, default 10 and 100 |
| `PROD_SUPABASE_URL` | Supabase project used when `NODE_ENV=production` |
