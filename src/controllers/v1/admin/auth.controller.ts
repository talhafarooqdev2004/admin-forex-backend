import { UserRepository } from '../../../repositories/user.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { ENV } from '../../../config/env.js';
const userRepository = new UserRepository();
const generateToken = (user) => {
    const payload = {
        id: user.id,
        email: user.email,
        role: user.role || 'user'
    };
    const token = jwt.sign(payload, ENV.JWT_SECRET, { expiresIn: '7d' });
    return token;
};
const transformUser = (user) => {
    if (!user)
        return user;
    const userObj = user.toJSON ? user.toJSON() : user;
    const { first_name, last_name, password, ...rest } = userObj;
    return {
        ...rest,
        firstName: first_name,
        lastName: last_name,
        phone: rest.phone || null,
    };
};
export const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Email and password are required');
        }
        const user = await userRepository.findByEmail(email);
        if (!user) {
            throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Invalid credentials');
        }
        if (!user.password) {
            throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Invalid credentials');
        }
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Invalid credentials');
        }
        const token = generateToken(user);
        const transformedUser = transformUser(user);
        res.status(HTTP_STATUS.OK).json(successResponse('Login successful', {
            token,
            user: transformedUser
        }));
    }
    catch (error) {
        next(error);
    }
};
export const adminLogin = async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Email and password are required');
        }
        const user = await userRepository.findByEmail(email);
        if (!user) {
            throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Invalid credentials');
        }
        if (user.role !== 'admin') {
            throw new ApiError(HTTP_STATUS.FORBIDDEN, 'Access denied. Admin privileges required.');
        }
        if (!user.password) {
            throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Invalid credentials');
        }
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Invalid credentials');
        }
        const token = generateToken(user);
        const transformedUser = transformUser(user);
        res.status(HTTP_STATUS.OK).json(successResponse('Admin login successful', {
            token,
            user: transformedUser
        }));
    }
    catch (error) {
        next(error);
    }
};
export const register = async (req, res, next) => {
    try {
        const { email, password, firstName, lastName, gender } = req.body;
        if (!email || !password || !firstName || !lastName) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Email, password, first name, and last name are required');
        }
        const existingUser = await userRepository.findByEmail(email);
        if (existingUser) {
            throw new ApiError(HTTP_STATUS.CONFLICT, 'Email already exists');
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await userRepository.create({
            first_name: firstName,
            last_name: lastName,
            email: email.toLowerCase(),
            password: hashedPassword,
            gender: gender || null,
            role: 'user'
        });
        const token = generateToken(user);
        const transformedUser = transformUser(user);
        res.status(HTTP_STATUS.CREATED).json(successResponse('Registration successful', {
            token,
            user: transformedUser
        }));
    }
    catch (error) {
        next(error);
    }
};
export const getMe = async (req, res, next) => {
    try {
        const user = await userRepository.findById(req.user.id);
        if (!user) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
        }
        const transformedUser = transformUser(user);
        res.status(HTTP_STATUS.OK).json(successResponse('User profile retrieved successfully', transformedUser));
    }
    catch (error) {
        next(error);
    }
};
export const updateMe = async (req, res, next) => {
    try {
        const { firstName, lastName, email, gender, phone } = req.body;
        const userId = req.user.id;
        if (email) {
            const existingUser = await userRepository.findByEmail(email.toLowerCase());
            if (existingUser && existingUser.id !== userId) {
                throw new ApiError(HTTP_STATUS.CONFLICT, 'Email already exists');
            }
        }
        const updateData = {};
        if (firstName !== undefined)
            updateData.firstName = firstName;
        if (lastName !== undefined)
            updateData.lastName = lastName;
        if (email !== undefined)
            updateData.email = email.toLowerCase();
        if (gender !== undefined)
            updateData.gender = gender || null;
        if (phone !== undefined)
            updateData.phone = phone || null;
        const updatedUser = await userRepository.update(userId, updateData);
        if (!updatedUser) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
        }
        const transformedUser = transformUser(updatedUser);
        res.status(HTTP_STATUS.OK).json(successResponse('Profile updated successfully', transformedUser));
    }
    catch (error) {
        next(error);
    }
};
export const handleGoogleAuth = async (req, res, next) => {
    try {
        const { googleId, displayName, email } = req.body;
        if (!email) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Email is required from Google account');
        }
        const splitFullName = (name) => {
            if (!name || typeof name !== 'string') {
                return ['User', ''];
            }
            const fullName = name.trim().split(/\s+/);
            if (fullName.length === 0) {
                return ['User', ''];
            }
            else if (fullName.length === 1) {
                return [fullName[0], ''];
            }
            else {
                const firstName = fullName[0];
                const lastName = fullName.slice(1).join(' ');
                return [firstName, lastName];
            }
        };
        const [firstName, lastName] = splitFullName(displayName || 'User');
        let user = await userRepository.findByGoogleId(googleId);
        if (user) {
            const token = generateToken(user);
            const transformedUser = transformUser(user);
            return res.status(HTTP_STATUS.OK).json(successResponse('Google login successful', {
                token,
                user: transformedUser
            }));
        }
        user = await userRepository.findByEmail(email);
        if (user) {
            await userRepository.update(user.id, { google_id: googleId });
            user = await userRepository.findById(user.id);
            const token = generateToken(user);
            const transformedUser = transformUser(user);
            return res.status(HTTP_STATUS.OK).json(successResponse('Google login successful', {
                token,
                user: transformedUser
            }));
        }
        user = await userRepository.create({
            google_id: googleId,
            first_name: firstName,
            last_name: lastName,
            email: email.toLowerCase(),
            password: null,
            role: 'user'
        });
        const token = generateToken(user);
        const transformedUser = transformUser(user);
        res.status(HTTP_STATUS.CREATED).json(successResponse('Google registration successful', {
            token,
            user: transformedUser
        }));
    }
    catch (error) {
        next(error);
    }
};
