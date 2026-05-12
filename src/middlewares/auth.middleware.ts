import jwt from 'jsonwebtoken';
import { ENV } from '../config/env.js';
import { ApiError } from '../exceptions/ApiError.js';
export const authMiddleware = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            throw new ApiError(401, 'Authentication token required');
        }
        const decoded = jwt.verify(token, ENV.JWT_SECRET);
        req.user = decoded;
        next();
    }
    catch (error) {
        next(new ApiError(401, 'Invalid or expired token'));
    }
};
export const authorize = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return next(new ApiError(403, 'Insufficient permissions'));
        }
        next();
    };
};
export const optionalAuth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (token) {
            try {
                const decoded = jwt.verify(token, ENV.JWT_SECRET);
                req.user = decoded;
            }
            catch (verifyError) {
                try {
                    const decoded = jwt.decode(token, { complete: false });
                    if (decoded && decoded.id) {
                        req.user = decoded;
                    }
                    else {
                    }
                }
                catch (decodeError) {
                }
            }
        }
        else {
        }
        next();
    }
    catch (error) {
        next();
    }
};
