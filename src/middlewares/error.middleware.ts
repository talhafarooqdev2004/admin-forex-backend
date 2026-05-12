import { Prisma } from '@prisma/client';
import type { ErrorRequestHandler } from "express";
import { ApiError } from '../exceptions/ApiError.js';
import { logger } from '../utils/logger.util.js';
import { errorResponse } from '../utils/response.util.js';

export const errorMiddleware: ErrorRequestHandler = (err, req, res, next) => {
    logger.error('Error:', {
        message: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
    });

    if (err instanceof ApiError) {
        return res.status(err.statusCode).json(errorResponse(err.message, err.errors));
    }

    if (err instanceof Prisma.PrismaClientValidationError) {
        return res.status(422).json(errorResponse('Validation error'));
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return res.status(409).json(errorResponse('Resource already exists'));
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        return res.status(400).json(errorResponse('Database error'));
    }

    return res.status(500).json(errorResponse('Internal server error'));
};
