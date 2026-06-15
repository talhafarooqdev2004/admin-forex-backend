import { TradeAlertPairRepository } from '../../../repositories/tradeAlertPair.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';

const tradeAlertPairRepository = new TradeAlertPairRepository();

const toInt = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
};

export const getAllPairs = async (req, res, next) => {
    try {
        const pairs = await tradeAlertPairRepository.findAll();
        res.status(HTTP_STATUS.OK).json(successResponse('Trade alert pairs retrieved successfully', pairs));
    } catch (error) {
        next(error);
    }
};

export const createPair = async (req, res, next) => {
    try {
        const body = req.body ?? {};
        const name = (body.name ?? '').toString().trim();
        if (!name) {
            throw new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, 'Pair name is required');
        }
        const pair = await tradeAlertPairRepository.create({
            name,
            scalping_sl: toInt(body.scalping_sl),
            swing_sl: toInt(body.swing_sl),
        });
        res.status(HTTP_STATUS.CREATED).json(successResponse(SUCCESS_MESSAGES.CREATED, pair));
    } catch (error) {
        if ((error as any)?.code === 'P2002') {
            return next(new ApiError(HTTP_STATUS.CONFLICT, 'A pair with this name already exists'));
        }
        next(error);
    }
};

export const updatePair = async (req, res, next) => {
    try {
        const body = req.body ?? {};
        const data: any = {};
        if (body.name !== undefined) data.name = body.name.toString().trim();
        if (body.scalping_sl !== undefined) data.scalping_sl = toInt(body.scalping_sl);
        if (body.swing_sl !== undefined) data.swing_sl = toInt(body.swing_sl);

        const pair = await tradeAlertPairRepository.update(req.params.id, data);
        if (!pair) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Trade alert pair not found');
        }
        res.status(HTTP_STATUS.OK).json(successResponse(SUCCESS_MESSAGES.UPDATED, pair));
    } catch (error) {
        if ((error as any)?.code === 'P2002') {
            return next(new ApiError(HTTP_STATUS.CONFLICT, 'A pair with this name already exists'));
        }
        next(error);
    }
};

export const upsertPairPreset = async (req, res, next) => {
    try {
        const body = req.body ?? {};
        const name = (body.name ?? '').toString().trim();
        if (!name) {
            throw new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, 'Pair name is required');
        }
        const pair = await tradeAlertPairRepository.upsertByName(
            name,
            toInt(body.scalping_sl),
            toInt(body.swing_sl),
        );
        res.status(HTTP_STATUS.OK).json(successResponse(SUCCESS_MESSAGES.UPDATED, pair));
    } catch (error) {
        next(error);
    }
};

export const deletePair = async (req, res, next) => {
    try {
        const deleted = await tradeAlertPairRepository.delete(req.params.id);
        if (!deleted) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Trade alert pair not found');
        }
        res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (error) {
        next(error);
    }
};
