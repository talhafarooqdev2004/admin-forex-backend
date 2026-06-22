import { UserPreferenceRepository } from '../../repositories/userPreference.repository.js';
import { successResponse } from '../../utils/response.util.js';
import { HTTP_STATUS } from '../../config/constants.js';
import { ApiError } from '../../exceptions/ApiError.js';

const userPreferenceRepository = new UserPreferenceRepository();

const ALLOWED_KEYS = new Set(['active_trades_columns']);

function assertAllowedKey(key: string) {
    if (!ALLOWED_KEYS.has(key)) {
        throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Unsupported preference key');
    }
}

export const getUserPreference = async (req, res, next) => {
    try {
        const { key } = req.params;
        assertAllowedKey(key);

        const pref = await userPreferenceRepository.findByUserAndKey(req.user.id, key);
        if (!pref) {
            return res.status(HTTP_STATUS.OK).json(
                successResponse('Preference not found. Returning null value.', { key, value: null }),
            );
        }

        res.status(HTTP_STATUS.OK).json(successResponse('Preference retrieved successfully', pref));
    } catch (error) {
        next(error);
    }
};

export const upsertUserPreference = async (req, res, next) => {
    try {
        const { key } = req.params;
        assertAllowedKey(key);

        const { value } = req.body;
        if (value !== null && value !== undefined && typeof value !== 'string') {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Value must be a JSON string or null');
        }

        const pref = await userPreferenceRepository.upsert(req.user.id, key, value ?? null);
        res.status(HTTP_STATUS.OK).json(successResponse('Preference saved successfully', pref));
    } catch (error) {
        next(error);
    }
};
