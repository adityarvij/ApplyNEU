import express, { type Request, type Response } from 'express';
import { listHumanRequests, resolveHumanRequest } from '../services/humanRequest/humanRequest.service.ts';
import type { HumanRequestStatus } from '../types/humanRequests.ts';
import { validateListRequests, validateResolveRequest } from './middleware/validators/request.validate.ts';
import asyncHandler from './middleware/handlers/asyncHandler.ts';

export const meRequestController = (): express.Router => {
    const router = express.Router();

    /** GET /me/requests?status=pending
     * return the caller's requests from their agents, newest first, optionally filtered by status.
    **/
    const listRoute = async (req: Request, res: Response) => {
        const status = req.query.status as HumanRequestStatus | undefined;
        const result = await listHumanRequests(req.auth!.userId, status);
        res.status(200).json(result);
    };

    /** POST /me/requests/:request_id/resolve
     * answer one of the caller's pending requests with { answer }, which resumes its agent.
    **/
    const resolveRoute = async (req: Request<{ request_id: string }>, res: Response) => {
        const result = await resolveHumanRequest(req.params.request_id, req.auth!.userId, req.body.answer);
        res.status(200).json(result);
    };

    router.get('/', validateListRequests, asyncHandler(listRoute));
    router.post('/:request_id/resolve', validateResolveRequest, asyncHandler(resolveRoute));

    return router;
};
