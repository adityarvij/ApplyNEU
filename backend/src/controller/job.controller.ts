import express, { type Request, type Response } from 'express';
import { addJob } from '../services/job.service.ts';
import { analyzeJob, getJobAnalysis } from '../services/jobRun/jobRun.service.ts';
import type { AddJobRequest, SendJobDescriptionRequest } from '../types/jobs.ts';
import { validateAddJob, validateSendJobDescription } from './middleware/validators/job.validate.ts';
import { validateRunIdParam } from './middleware/validators/agent.validate.ts';
import asyncHandler from './middleware/handlers/asyncHandler.ts';

const jobController = (): express.Router => {
    const router = express.Router();

    /** POST /job/add — insert a new job record by company, title, and description. */
    const addJobRoute = async (req: AddJobRequest, res: Response) => {
        const { company, title, description } = req.body;
        const result = await addJob(company, title, description);
        res.status(200).json(result);
    };

    router.post('/add', validateAddJob, asyncHandler(addJobRoute));

    return router;
};

export const meJobController = (): express.Router => {
    const router = express.Router();

    /** POST /me/jobs/analyze
     * queue the posting's job run for the caller and return its run_id to poll.
    **/
    const analyzeJobDescriptionRoute = async (req: SendJobDescriptionRequest, res: Response) => {
        const { job_description, company, title } = req.body;
        const result = await analyzeJob(req.auth!.userId, job_description, company, title);
        res.status(202).json(result);
    };

    /** GET /me/jobs/analyze/:run_id
     * return the run's status, and its decision, score and employer instructions once it settles.
    **/
    const jobAnalysisRoute = async (req: Request<{ run_id: string }>, res: Response) => {
        const result = await getJobAnalysis(req.params.run_id, req.auth!.userId);
        res.status(200).json(result);
    };

    router.post('/analyze', validateSendJobDescription, asyncHandler(analyzeJobDescriptionRoute));
    router.get('/analyze/:run_id', validateRunIdParam, asyncHandler(jobAnalysisRoute));

    return router;
};

export default jobController;
