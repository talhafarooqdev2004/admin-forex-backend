import jwt from 'jsonwebtoken';
import { ENV } from '../config/env.js';

export const generateToken = (payload) => {
    return jwt.sign(payload, ENV.JWT_SECRET, {
        expiresIn: ENV.JWT_EXPIRES_IN,
    });
};

export const verifyToken = (token) => {
    try {
        return jwt.verify(token, ENV.JWT_SECRET);
    } catch (error) {
        throw new Error('Invalid or expired token');
    }
};

export const decodeToken = (token) => {
    return jwt.decode(token);
};
