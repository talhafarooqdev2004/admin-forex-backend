import { UserRepository } from '../../../repositories/user.repository.js';
import { successResponse, errorResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES, ERROR_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
const userRepository = new UserRepository();
const transformUser = (user) => {
    if (!user)
        return user;
    const userObj = user.toJSON ? user.toJSON() : user;
    const { first_name, last_name, ...rest } = userObj;
    return {
        ...rest,
        firstName: first_name,
        lastName: last_name,
    };
};
export const getAllUsers = async (req, res, next) => {
    try {
        const users = await userRepository.findAll();
        const transformedUsers = Array.isArray(users)
            ? users.map(transformUser)
            : transformUser(users);
        res.status(HTTP_STATUS.OK).json(successResponse('Users retrieved successfully', transformedUsers));
    }
    catch (error) {
        next(error);
    }
};
export const getUserById = async (req, res, next) => {
    try {
        const user = await userRepository.findById(req.params.id);
        if (!user) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
        }
        const transformedUser = transformUser(user);
        res.status(HTTP_STATUS.OK).json(successResponse('User retrieved successfully', transformedUser));
    }
    catch (error) {
        next(error);
    }
};
export const getUserStats = async (req, res, next) => {
    try {
        const [totalUsers, googleUsers, newUsers] = await Promise.all([
            userRepository.getTotalUsersCount(),
            userRepository.getGoogleUsersCount(),
            userRepository.getNewUsersCount(30),
        ]);
        const stats = {
            total_users: totalUsers,
            google_users: googleUsers,
            new_users_last_30_days: newUsers,
        };
        res.status(HTTP_STATUS.OK).json(successResponse('User statistics retrieved successfully', stats));
    }
    catch (error) {
        next(error);
    }
};
export const deleteUser = async (req, res, next) => {
    try {
        const deleted = await userRepository.delete(req.params.id);
        if (!deleted) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'User not found');
        }
        res.status(HTTP_STATUS.OK).json(successResponse(SUCCESS_MESSAGES.DELETED));
    }
    catch (error) {
        next(error);
    }
};
