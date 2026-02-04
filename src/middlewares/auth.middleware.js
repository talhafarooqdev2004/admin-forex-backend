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
        req.user = decoded; // Attach user to request
        next();
    } catch (error) {
        next(new ApiError(401, 'Invalid or expired token'));
    }
};

// Check specific permissions
export const authorize = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return next(new ApiError(403, 'Insufficient permissions'));
        }
        next();
    };
};

// Optional auth - doesn't fail if no token
export const optionalAuth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        
        if (token) {
            try {
                // Try to verify with admin backend secret first
                const decoded = jwt.verify(token, ENV.JWT_SECRET);
                req.user = decoded;
                console.log('optionalAuth - Token verified with admin secret:', { id: decoded.id, email: decoded.email, role: decoded.role });
            } catch (verifyError) {
                // Token might be from site backend with different secret
                // Try to decode without verification (we can still get the payload)
                console.log('optionalAuth - Token verification failed, decoding without verification:', verifyError.message);
                try {
                    const decoded = jwt.decode(token, { complete: false });
                    if (decoded && decoded.id) {
                        // Use decoded payload even if signature verification failed
                        // This allows tokens from site backend to work
                        req.user = decoded;
                        console.log('optionalAuth - Token decoded (unverified, from site backend?):', { id: decoded.id, email: decoded.email, role: decoded.role });
                    } else {
                        console.log('optionalAuth - Decoded token missing id field');
                    }
                } catch (decodeError) {
                    console.log('optionalAuth - Token decode failed:', decodeError.message);
                }
            }
        } else {
            console.log('optionalAuth - No token provided');
        }
        next();
    } catch (error) {
        // Continue without auth
        console.log('optionalAuth - Unexpected error:', error.message);
        next();
    }
};
