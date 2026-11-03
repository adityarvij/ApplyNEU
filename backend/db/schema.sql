-- ApplyNEU schema

CREATE TYPE public.application_status AS ENUM (
    'draft',
    'pending',
    'external',
    'external action needed',
    'applied',
    'interview',
    'offer',
    'rejected'
);

CREATE TYPE public.job_match_sensitivity AS ENUM (
    'low',
    'medium',
    'high'
);

CREATE TYPE public.agent_run_type AS ENUM (
    'sweep',
    'job',
    'external_apply',
    'cover_letter'
);

CREATE TYPE public.instruction_kind AS ENUM (
    'external_application',
    'cover_letter',
    'other'
);

CREATE TYPE public.instruction_source AS ENUM (
    'description',
    'nuworks_modal'
);

CREATE TYPE public.agent_run_status AS ENUM (
    'queued',
    'running',
    'waiting_for_you',
    'done',
    'failed',
    'handed_off',
    'cancelled'
);

CREATE TYPE public.human_request_kind AS ENUM (
    'apply_approval',
    'submit_approval',
    'question',
    'handoff'
);

CREATE TYPE public.human_request_status AS ENUM (
    'pending',
    'resolved',
    'expired',
    'cancelled'
);

CREATE TABLE public.job_applications (
    job_id uuid NOT NULL,
    user_id uuid NOT NULL,
    applied_at timestamp without time zone DEFAULT LOCALTIMESTAMP NOT NULL,
    application_id uuid DEFAULT gen_random_uuid() NOT NULL,
    status public.application_status DEFAULT 'draft'::public.application_status NOT NULL
);

CREATE TABLE public.jobs (
    job_id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    company text NOT NULL,
    description_hash text NOT NULL
);

-- Instructions depend only on the posting text, so they are keyed by its hash and shared by
-- every user and every job row with that description. A header with no job_instructions
-- means "extracted, nothing required"; no header means "not extracted yet".
CREATE TABLE public.instruction_extractions (
    description_hash text NOT NULL,
    extraction_version smallint NOT NULL,
    model text NOT NULL,
    extracted_at timestamp with time zone DEFAULT now() NOT NULL
);

-- One row per required step, so each can be routed and tracked by id. position keeps the
-- order the steps were extracted in.
CREATE TABLE public.job_instructions (
    instruction_id uuid DEFAULT gen_random_uuid() NOT NULL,
    description_hash text NOT NULL,
    extraction_version smallint NOT NULL,
    kind public.instruction_kind NOT NULL,
    instruction text NOT NULL,
    description text NOT NULL,
    destination_domain text,
    source public.instruction_source NOT NULL,
    position smallint NOT NULL
);

CREATE TABLE public.job_matches (
    user_id uuid NOT NULL,
    job_id uuid NOT NULL,
    candidate_hash text NOT NULL,
    scoring_version smallint NOT NULL,
    match_score smallint NOT NULL,
    rationale text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- One row per agent run, whatever the agent: the place the homepage, the inbox and per-user
-- limits read from. A sweep is one press of Play in the desktop app and has no LangGraph
-- thread; every other run does, under a thread_id generated when the run is created.
-- A run waiting for a slot is in the user's line: queued, or paused with the user's answer in
-- resume ({ step, value }). queued_at is when it last joined the line, and stays null for runs
-- that never went through it.
CREATE TABLE public.agent_runs (
    run_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type public.agent_run_type NOT NULL,
    parent_run_id uuid,
    job_id uuid,
    thread_id uuid,
    status public.agent_run_status DEFAULT 'queued'::public.agent_run_status NOT NULL,
    title text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    queued_at timestamp with time zone,
    resume jsonb,
    CONSTRAINT agent_runs_thread_unless_sweep CHECK (type = 'sweep' OR thread_id IS NOT NULL),
    CONSTRAINT agent_runs_job_has_job_id CHECK (type <> 'job' OR job_id IS NOT NULL)
);

-- One row per time an agent stops to wait on the user: an approval, a question, or a hand-off
-- of the browser. payload is what the agent shows the user and answer is what the user sent
-- back, which resumes the run's thread. A run has at most one pending request at a time.
CREATE TABLE public.human_requests (
    request_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    run_id uuid NOT NULL,
    job_id uuid,
    kind public.human_request_kind NOT NULL,
    status public.human_request_status DEFAULT 'pending'::public.human_request_status NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    answer jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    expires_at timestamp with time zone
);

CREATE TABLE public.preferences (
    user_id uuid CONSTRAINT preferences_user_id_not_null1 NOT NULL,
    job_types text[] DEFAULT '{}'::text[] NOT NULL,
    wait_for_approval boolean DEFAULT true NOT NULL,
    recent_jobs boolean DEFAULT true NOT NULL,
    job_match public.job_match_sensitivity DEFAULT 'low'::public.job_match_sensitivity NOT NULL,
    email_notifications boolean DEFAULT true NOT NULL,
    unpaid_roles boolean DEFAULT false NOT NULL,
    primary_resume_id uuid,
    interests text[] DEFAULT '{}'::text[] NOT NULL,
    num_agents smallint DEFAULT 15 NOT NULL,
    CONSTRAINT preferences_num_agents_range CHECK (num_agents BETWEEN 1 AND 15)
);

CREATE TABLE public.profile (
    user_id uuid CONSTRAINT preferences_user_id_not_null NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    grad_year smallint NOT NULL
);

CREATE TABLE public.resumes (
    resume_id uuid NOT NULL,
    key text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    user_id uuid NOT NULL,
    file_name text NOT NULL,
    file_size_bytes integer NOT NULL,
    resume_text text NOT NULL,
    upload_complete boolean DEFAULT false,
    search_terms text[] DEFAULT '{}'::text[] NOT NULL,
    enrichment_status text DEFAULT 'none'::text NOT NULL,
    enrichment_retries integer DEFAULT 0 NOT NULL,
    CONSTRAINT resumes_enrichment_status_check CHECK (enrichment_status = ANY (ARRAY['none'::text, 'pending'::text, 'failed'::text, 'complete'::text]))
);

CREATE TABLE public.tasks (
    task_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT LOCALTIMESTAMP NOT NULL,
    completed boolean DEFAULT false,
    text text NOT NULL,
    description text,
    application_id uuid NOT NULL
);

CREATE TABLE public.users (
    user_id uuid NOT NULL
);

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_pkey PRIMARY KEY (application_id);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_company_title_hash_uniq UNIQUE (company, title, description_hash);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (job_id);

ALTER TABLE ONLY public.instruction_extractions
    ADD CONSTRAINT instruction_extractions_pkey PRIMARY KEY (description_hash, extraction_version);

ALTER TABLE ONLY public.job_instructions
    ADD CONSTRAINT job_instructions_pkey PRIMARY KEY (instruction_id);

ALTER TABLE ONLY public.job_instructions
    ADD CONSTRAINT job_instructions_position_uniq UNIQUE (description_hash, extraction_version, source, position);

ALTER TABLE ONLY public.job_matches
    ADD CONSTRAINT job_matches_pkey PRIMARY KEY (user_id, job_id);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_thread_id_key UNIQUE (thread_id);

ALTER TABLE ONLY public.human_requests
    ADD CONSTRAINT human_requests_pkey PRIMARY KEY (request_id);

ALTER TABLE ONLY public.job_matches
    ADD CONSTRAINT job_matches_score_range CHECK (match_score BETWEEN 0 AND 100);

ALTER TABLE ONLY public.preferences
    ADD CONSTRAINT preferences_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.profile
    ADD CONSTRAINT profile_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.resumes
    ADD CONSTRAINT resumes_pkey PRIMARY KEY (resume_id);

-- Logically redundant given resumes_pkey, but a foreign key can only reference columns
-- carrying a unique constraint of exactly that shape, and preferences points at both.
ALTER TABLE ONLY public.resumes
    ADD CONSTRAINT resumes_id_user_uniq UNIQUE (resume_id, user_id);

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (task_id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);

CREATE INDEX idx_resumes_user_id ON public.resumes USING btree (user_id);

-- The primary key leads with user_id, so it cannot serve lookups by job_id alone; without
-- this, every job delete would scan the whole table to cascade.
CREATE INDEX idx_job_matches_job_id ON public.job_matches USING btree (job_id);

-- At most one unfinished job run per user and posting, so two analyze calls for the same job
-- can't start two threads. Finished runs don't count, so a repost seen later starts fresh.
CREATE UNIQUE INDEX agent_runs_one_active_job ON public.agent_runs USING btree (user_id, job_id)
    WHERE type = 'job' AND status IN ('queued', 'running', 'waiting_for_you');

-- Serves the homepage list, newest activity first.
CREATE INDEX idx_agent_runs_user_updated ON public.agent_runs USING btree (user_id, updated_at DESC);

-- Serves picking the next run in a user's line.
CREATE INDEX idx_agent_runs_line ON public.agent_runs USING btree (user_id, queued_at)
    WHERE status IN ('queued', 'waiting_for_you');

CREATE INDEX idx_agent_runs_parent ON public.agent_runs USING btree (parent_run_id);

-- Serves the inbox: the caller's requests by status, newest first.
CREATE INDEX idx_human_requests_user_status ON public.human_requests USING btree (user_id, status, created_at DESC);

-- A run asks one thing at a time, so an answer always resumes the pause it was asked for.
CREATE UNIQUE INDEX human_requests_one_pending_per_run ON public.human_requests USING btree (run_id)
    WHERE status = 'pending';

-- Serves the sweep that expires pending requests.
CREATE INDEX idx_human_requests_expiry ON public.human_requests USING btree (expires_at)
    WHERE status = 'pending' AND expires_at IS NOT NULL;

CREATE UNIQUE INDEX unique_user_job ON public.job_applications USING btree (job_id, user_id);

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(job_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_instructions
    ADD CONSTRAINT job_instructions_extraction_fkey FOREIGN KEY (description_hash, extraction_version) REFERENCES public.instruction_extractions(description_hash, extraction_version) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_matches
    ADD CONSTRAINT job_matches_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(job_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_matches
    ADD CONSTRAINT job_matches_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;

-- A deleted parent leaves its children as standalone runs rather than erasing their history.
ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_parent_run_id_fkey FOREIGN KEY (parent_run_id) REFERENCES public.agent_runs(run_id) ON DELETE SET NULL;

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(job_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.human_requests
    ADD CONSTRAINT human_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.human_requests
    ADD CONSTRAINT human_requests_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.agent_runs(run_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.human_requests
    ADD CONSTRAINT human_requests_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(job_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.preferences
    ADD CONSTRAINT preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;

-- Carrying user_id into the reference is what keeps a user's primary pointed at their own
-- resume: preferences.user_id is the primary key, so the two user ids have to agree.
--
-- The column list on SET NULL is required, not decoration: a bare SET NULL nulls every
-- referencing column, and user_id is this table's NOT NULL primary key, so deleting a
-- resume someone had chosen would fail outright instead of clearing their pointer.
ALTER TABLE ONLY public.preferences
    ADD CONSTRAINT preferences_primary_resume_fkey FOREIGN KEY (primary_resume_id, user_id) REFERENCES public.resumes(resume_id, user_id) ON DELETE SET NULL (primary_resume_id);

ALTER TABLE ONLY public.profile
    ADD CONSTRAINT profile_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.resumes
    ADD CONSTRAINT resumes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.job_applications(application_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;

-- Deleting a user in Supabase Auth now cascades through profile, preferences, resumes,
-- tasks, job_applications and job_matches, which all cascade off public.users. Without this the rows would orphan silently.
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_user_id_auth_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.human_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instruction_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- Give every new signup their starter rows: the users record every other table points
-- at, a profile from the signup form values, and a preferences row so the defaults apply.
--
-- This runs in the database rather than the backend because Supabase's auth service
-- creates the auth.users row, not our API -- so the API can only react afterwards via a
-- second HTTP call, which needs a token the browser does not have yet during signup.
-- Doing it here means the auth user and the app rows are created in one transaction and
-- cannot disagree.
--
-- security definer: the auth service inserts as a restricted role that cannot write to
-- public; the function runs as its owner (postgres) instead. search_path is pinned as the
-- standard hardening for definer functions.
--
-- graduation_year arrives as a string from the signup form. It is guarded rather than
-- cast directly: a bad value would raise inside the trigger and fail the whole signup.
CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
    AS $$
BEGIN
    INSERT INTO public.users (user_id) VALUES (new.id)
        ON CONFLICT DO NOTHING;

    INSERT INTO public.profile (user_id, first_name, last_name, grad_year)
    VALUES (
        new.id,
        COALESCE(new.raw_user_meta_data ->> 'first_name', ''),
        COALESCE(new.raw_user_meta_data ->> 'last_name', ''),
        CASE
            WHEN new.raw_user_meta_data ->> 'graduation_year' ~ '^[0-9]+$'
            THEN (new.raw_user_meta_data ->> 'graduation_year')::smallint
            ELSE 0
        END
    )
        ON CONFLICT DO NOTHING;

    INSERT INTO public.preferences (user_id) VALUES (new.id)
        ON CONFLICT DO NOTHING;

    RETURN new;
END;
$$;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- LangGraph checkpoints, written by the PostgresSaver in src/agents/checkpointer.ts. Kept in
-- their own schema so Supabase's REST API, which serves public, never exposes agent state.
--
-- This mirrors the migrations bundled with @langchain/langgraph-checkpoint-postgres 1.1.0
-- (versions 0-5). The app never calls setup(), so when an upgrade adds a migration, copy its
-- SQL from the package's getMigrations(), record its version below, and run it on Supabase.
CREATE SCHEMA IF NOT EXISTS langgraph;

CREATE TABLE langgraph.checkpoint_migrations (
    v integer PRIMARY KEY
);

CREATE TABLE langgraph.checkpoints (
    thread_id text NOT NULL,
    checkpoint_ns text NOT NULL DEFAULT '',
    checkpoint_id text NOT NULL,
    parent_checkpoint_id text,
    type text,
    checkpoint jsonb NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE TABLE langgraph.checkpoint_blobs (
    thread_id text NOT NULL,
    checkpoint_ns text NOT NULL DEFAULT '',
    channel text NOT NULL,
    version text NOT NULL,
    type text NOT NULL,
    blob bytea,
    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);

CREATE TABLE langgraph.checkpoint_writes (
    thread_id text NOT NULL,
    checkpoint_ns text NOT NULL DEFAULT '',
    checkpoint_id text NOT NULL,
    task_id text NOT NULL,
    idx integer NOT NULL,
    channel text NOT NULL,
    type text,
    blob bytea NOT NULL,
    task_path text NOT NULL DEFAULT '',
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

INSERT INTO langgraph.checkpoint_migrations (v) VALUES (0), (1), (2), (3), (4), (5);
