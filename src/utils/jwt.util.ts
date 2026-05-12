import jwt, { type Secret, type SignOptions } from 'jsonwebtoken';
import { ENV } from '../config/env.js';

function jwtSecret(): Secret {
    const s = ENV.JWT_SECRET;
    if (!s) {
        throw new Error('JWT_SECRET is not configured');
    }
    return s;
}

export const generateToken = (payload) => {
    const options: SignOptions = { expiresIn: ENV.JWT_EXPIRES_IN as SignOptions['expiresIn'] };
    return jwt.sign(payload, jwtSecret(), options);
};
export const verifyToken = (token) => {
    try {
        return jwt.verify(token, jwtSecret());
    }
    catch (error) {
        throw new Error('Invalid or expired token');
    }
};
export const decodeToken = (token) => {
    return jwt.decode(token);
};
