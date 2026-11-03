/* eslint no-console: "off" */
import 'dotenv/config';
import express from 'express';
import * as http from 'http';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import userController, { meUserController } from './controller/user.controller.ts';
import resumeController, { meResumeController } from './controller/resume.controller.ts';
import jobController, { meJobController } from './controller/job.controller.ts';
import taskController, { meTaskController } from './controller/task.controller.ts';
import { meApplicationController } from './controller/application.controller.ts';
import { mePreferenceController } from './controller/preference.controller.ts';
import { meContextController } from './controller/context.controller.ts';
import { meAgentController } from './controller/agent.controller.ts';
import { meRequestController } from './controller/request.controller.ts';
import { interestController } from './controller/interest.controller.ts';
import { authenticate } from './controller/middleware/authenticate.ts';
import errorHandler from './controller/middleware/handlers/errorHandler.ts';
import { healthRouter, startDraining } from './health.ts';
import { pool } from './db/index.ts';
import { redis } from './db/redis.ts';
import { onShutdownSignal, runShutdown } from './utils/shutdown.ts';

const PORT = Number(process.env.PORT) || 8080;

const app = express();
const server = http.createServer(app);

// A load balancer reuses idle connections for up to 60s (AWS ALB's default). Node's 5s
// default would close one just as it is reused, which surfaces as a random 502.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// Only set behind a proxy: trusting X-Forwarded-For on a directly exposed server lets any
// client spoof its IP.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY));
}

function startServer() {
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Kill the process and retry.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

const closeServer = () =>
  new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeIdleConnections();
  });

/**
 * Fails readiness first so the load balancer stops sending new requests, lets in-flight
 * requests finish, then closes Postgres and Redis.
 */
onShutdownSignal((signal) => {
  console.log(`[shutdown] ${signal} received, draining`);
  startDraining();
  void runShutdown([
    closeServer,
    () => pool.end(),
    () => redis.quit().catch(() => {}),
  ]);
});

app.use(healthRouter());

app.use(cors({ exposedHeaders: ['Retry-After'] }));
app.use(express.json());

app.use('/users', userController());
app.use('/resumes', resumeController());
app.use('/jobs', jobController());
app.use('/tasks', taskController());
app.use('/interests', interestController());

// Everything the caller owns hangs off /me, identified by the JWT rather than by a
// url param. authenticate is mounted on the router itself so a route added here
// cannot accidentally ship unauthenticated.
const meRouter = express.Router();
meRouter.use(authenticate);
meRouter.use('/', meUserController());
meRouter.use('/preferences', mePreferenceController());
meRouter.use('/resumes', meResumeController());
meRouter.use('/jobs', meJobController());
meRouter.use('/tasks', meTaskController());
meRouter.use('/applications', meApplicationController());
meRouter.use('/context', meContextController());
meRouter.use('/agents', meAgentController());
meRouter.use('/requests', meRequestController());
app.use('/me', meRouter);

app.use(errorHandler);

// Only auto-start when not under test to allow Jest/supertest to import the app without
// binding to a port or requiring a running Postgres instance.
if (process.env.NODE_ENV !== 'test') {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const swaggerDocument = JSON.parse(readFileSync(join(__dirname, '..', 'swagger_output.json'), 'utf8'));
    app.use('/api-docs', ...swaggerUi.serve, swaggerUi.setup(swaggerDocument));
    console.log(`Swagger UI at http://localhost:${PORT}/api-docs`);
  } catch {
    console.warn('swagger_output.json not found — run npm run swagger:gen to generate it');
  }
  startServer();
}

export { app, server, startServer };
