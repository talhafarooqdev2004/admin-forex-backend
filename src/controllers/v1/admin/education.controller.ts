import { EducationRepository } from '../../../repositories/education.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
const educationRepository = new EducationRepository();
export const getAllEducations = async (req, res, next) => {
    try {
        const locale = req.query.locale || 'en';
        const educations = await educationRepository.findAll(locale);
        res.status(HTTP_STATUS.OK).json(successResponse('Educations retrieved successfully', educations));
    }
    catch (error) {
        next(error);
    }
};
export const getEducationById = async (req, res, next) => {
    try {
        const education = await educationRepository.findById(req.params.id);
        if (!education) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Education not found');
        }
        res.status(HTTP_STATUS.OK).json(successResponse('Education retrieved successfully', education));
    }
    catch (error) {
        next(error);
    }
};
export const createEducation = async (req, res, next) => {
    try {
        const education = await educationRepository.create(req.body);
        res.status(HTTP_STATUS.CREATED).json(successResponse(SUCCESS_MESSAGES.CREATED, education));
    }
    catch (error) {
        next(error);
    }
};
export const updateEducation = async (req, res, next) => {
    try {
        const education = await educationRepository.update(req.params.id, req.body);
        if (!education) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Education not found');
        }
        res.status(HTTP_STATUS.NO_CONTENT).send();
    }
    catch (error) {
        next(error);
    }
};
export const deleteEducation = async (req, res, next) => {
    try {
        const deleted = await educationRepository.delete(req.params.id);
        if (!deleted) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Education not found');
        }
        res.status(HTTP_STATUS.NO_CONTENT).send();
    }
    catch (error) {
        next(error);
    }
};
export const publishEducation = async (req, res, next) => {
    try {
        const education = await educationRepository.publish(req.params.id);
        if (!education) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Education not found');
        }
        res.status(HTTP_STATUS.OK).json(successResponse(SUCCESS_MESSAGES.PUBLISHED, education));
    }
    catch (error) {
        next(error);
    }
};
export const unpublishEducation = async (req, res, next) => {
    try {
        const education = await educationRepository.unpublish(req.params.id);
        if (!education) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Education not found');
        }
        res.status(HTTP_STATUS.OK).json(successResponse(SUCCESS_MESSAGES.UNPUBLISHED, education));
    }
    catch (error) {
        next(error);
    }
};
