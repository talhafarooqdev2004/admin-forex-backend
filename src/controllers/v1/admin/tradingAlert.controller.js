import { TradingAlertRepository } from '../../../repositories/tradingAlert.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';

const tradingAlertRepository = new TradingAlertRepository();

const parseDecimalFields = (alert) => {
    if (!alert) return alert;
    
    const parsed = alert.toJSON ? alert.toJSON() : alert;
    
    // Convert decimal string fields to numbers
    if (parsed.entry_level !== null && parsed.entry_level !== undefined) {
        parsed.entry_level = parseFloat(parsed.entry_level);
    }
    if (parsed.stop_loss !== null && parsed.stop_loss !== undefined) {
        parsed.stop_loss = parseFloat(parsed.stop_loss);
    }
    if (parsed.tp1 !== null && parsed.tp1 !== undefined) {
        parsed.tp1 = parseFloat(parsed.tp1);
    }
    if (parsed.tp2 !== null && parsed.tp2 !== undefined) {
        parsed.tp2 = parseFloat(parsed.tp2);
    }
    if (parsed.result !== null && parsed.result !== undefined) {
        parsed.result = parseFloat(parsed.result);
    }
    
    return parsed;
};

export const getAllAlerts = async (req, res, next) => {
    try {
        const alerts = await tradingAlertRepository.findAll();
        
        // Convert decimal fields to numbers
        const parsedAlerts = Array.isArray(alerts) 
            ? alerts.map(parseDecimalFields)
            : parseDecimalFields(alerts);
        
        res.status(HTTP_STATUS.OK).json(
            successResponse('Trading alerts retrieved successfully', parsedAlerts)
        );
    } catch (error) {
        next(error);
    }
};

export const getAlertById = async (req, res, next) => {
    try {
        const alert = await tradingAlertRepository.findById(req.params.id);
        
        if (!alert) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Trading alert not found');
        }
        
        res.status(HTTP_STATUS.OK).json(
            successResponse('Trading alert retrieved successfully', alert)
        );
    } catch (error) {
        next(error);
    }
};

export const createAlert = async (req, res, next) => {
    try {
        const alert = await tradingAlertRepository.create(req.body);
        
        const parsedAlert = parseDecimalFields(alert);
        
        res.status(HTTP_STATUS.CREATED).json(
            successResponse(SUCCESS_MESSAGES.CREATED, parsedAlert)
        );
    } catch (error) {
        next(error);
    }
};

export const updateAlert = async (req, res, next) => {
    try {
        const alert = await tradingAlertRepository.update(req.params.id, req.body);
        
        if (!alert) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Trading alert not found');
        }
        
        res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (error) {
        next(error);
    }
};

export const deleteAlert = async (req, res, next) => {
    try {
        const deleted = await tradingAlertRepository.delete(req.params.id);
        
        if (!deleted) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Trading alert not found');
        }
        
        res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (error) {
        next(error);
    }
};
