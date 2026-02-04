import { ColorConfigurationRepository } from '../../../repositories/colorConfiguration.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';

const colorConfigRepository = new ColorConfigurationRepository();

export const getAllColorConfigurations = async (req, res, next) => {
    try {
        const { type } = req.query;
        
        const configurations = type 
            ? await colorConfigRepository.findByType(type)
            : await colorConfigRepository.findAll();
        
        res.status(HTTP_STATUS.OK).json(
            successResponse('Color configurations retrieved successfully', configurations)
        );
    } catch (error) {
        next(error);
    }
};

export const createColorConfiguration = async (req, res, next) => {
    try {
        const configuration = await colorConfigRepository.create(req.body);
        
        res.status(HTTP_STATUS.CREATED).json(
            successResponse('Color configuration created successfully', configuration)
        );
    } catch (error) {
        next(error);
    }
};

export const bulkUpdateColorConfigurations = async (req, res, next) => {
    try {
        const { type, configurations } = req.body;
        
        if (!type || !configurations || !Array.isArray(configurations)) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'Type and configurations array are required');
        }
        
        await colorConfigRepository.bulkUpdate(type, configurations);
        
        const updated = await colorConfigRepository.findByType(type);
        
        res.status(HTTP_STATUS.OK).json(
            successResponse('Color configurations updated successfully', updated)
        );
    } catch (error) {
        next(error);
    }
};

export const updateColorConfiguration = async (req, res, next) => {
    try {
        const configuration = await colorConfigRepository.update(req.params.id, req.body);
        
        if (!configuration) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Color configuration not found');
        }
        
        res.status(HTTP_STATUS.OK).json(
            successResponse(SUCCESS_MESSAGES.UPDATED, configuration)
        );
    } catch (error) {
        next(error);
    }
};

export const deleteColorConfiguration = async (req, res, next) => {
    try {
        const deleted = await colorConfigRepository.delete(req.params.id);
        
        if (!deleted) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Color configuration not found');
        }
        
        res.status(HTTP_STATUS.OK).json(
            successResponse(SUCCESS_MESSAGES.DELETED)
        );
    } catch (error) {
        next(error);
    }
};
