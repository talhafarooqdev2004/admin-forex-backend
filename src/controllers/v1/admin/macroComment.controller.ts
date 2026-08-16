import { AppConfigRepository } from '../../../repositories/appConfig.repository.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { successResponse } from '../../../utils/response.util.js';

const appConfigRepository = new AppConfigRepository();
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3,5}$/;
const KEY_PREFIX = 'daily_market_macro_comment:';

function requireDayKey(value: unknown): string {
    const dayKey = typeof value === 'string' ? value.trim() : '';
    if (!DAY_KEY_RE.test(dayKey)) throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid market day');
    return dayKey;
}

function requireCurrency(value: unknown): string {
    const currency = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!CURRENCY_RE.test(currency)) throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Invalid currency');
    return currency;
}

function configKey(dayKey: string, currency: string): string {
    return `${KEY_PREFIX}${dayKey}:${currency}`;
}

/** Admin-only daily overrides for derived Macro Scoreboard comments. */
export const listMacroComments = async (req, res, next) => {
    try {
        const dayKey = requireDayKey(req.query.day);
        const prefix = `${KEY_PREFIX}${dayKey}:`;
        const configs = await appConfigRepository.findByKeyPrefix(prefix);
        const comments = Object.fromEntries(
            configs
                .filter((config) => typeof config.key === 'string' && config.key.startsWith(prefix))
                .map((config) => [config.key.slice(prefix.length), typeof config.value === 'string' ? config.value : '']),
        );
        res.status(HTTP_STATUS.OK).json(successResponse('Macro comments retrieved successfully', { dayKey, comments }));
    } catch (error) {
        next(error);
    }
};

export const upsertMacroComment = async (req, res, next) => {
    try {
        const dayKey = requireDayKey(req.query.day);
        const currency = requireCurrency(req.params.currency);
        const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
        if (comment.length > 2_000) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Comment must be 2000 characters or fewer');
        }
        const data = await appConfigRepository.updateOrCreate(
            configKey(dayKey, currency),
            comment || null,
            `Admin macro scoreboard comment for ${currency} on ${dayKey}`,
        );
        res.status(HTTP_STATUS.OK).json(successResponse('Macro comment saved successfully', data));
    } catch (error) {
        next(error);
    }
};
