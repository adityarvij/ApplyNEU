import { body, param, query, validationResult } from 'express-validator';
import type { Request, Response, NextFunction } from 'express';
import { HUMAN_REQUEST_STATUSES } from '../../../types/humanRequests.ts';

const handleValidation = (req: Request, res: Response, next: NextFunction) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        res.status(400).json({ message: errors.array()[0]?.msg ?? 'Validation error.' });
        return;
    }
    next();
};

export const validateListRequests = [
    query('status').optional().isIn(HUMAN_REQUEST_STATUSES)
        .withMessage(`status must be one of ${HUMAN_REQUEST_STATUSES.join(', ')}.`),
    handleValidation,
];

export const validateResolveRequest = [
    param('request_id').isUUID().withMessage('request_id must be a UUID.'),
    body('answer').exists().withMessage('answer is required.'),
    handleValidation,
];
