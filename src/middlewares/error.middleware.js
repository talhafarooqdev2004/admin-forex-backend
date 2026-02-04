import { ApiError } from '../exceptions/ApiError.js';
import { logger } from '../utils/logger.util.js';
import { errorResponse } from '../utils/response.util.js';

export const errorMiddleware = (err, req, res, next) => {
    logger.error('Error:', {
        message: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method
    });

    if (err instanceof ApiError) {
        return res.status(err.statusCode).json(
            errorResponse(err.message, err.errors)
        );
    }

    // Sequelize Validation Error
    if (err.name === 'SequelizeValidationError') {
        const errors = err.errors.map(e => ({
            field: e.path,
            message: e.message
        }));
        return res.status(422).json(
            errorResponse('Validation error', errors)
        );
    }

    // Sequelize Unique Constraint Error
    if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json(
            errorResponse('Resource already exists')
        );
    }

    // Sequelize Not Found Error
    if (err.name === 'SequelizeDatabaseError') {
        return res.status(400).json(
            errorResponse('Database error')
        );
    }

    // Unknown errors
    return res.status(500).json(
        errorResponse('Internal server error')
    );
};
