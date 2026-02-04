import { ForumTopicRepository } from '../../../repositories/forum/topic.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';

const topicRepository = new ForumTopicRepository();

export const getAllTopics = async (req, res, next) => {
    try {
        const locale = req.query.locale || 'en';
        const topics = await topicRepository.findAll(locale);
        
        res.status(HTTP_STATUS.OK).json(
            successResponse('Topics retrieved successfully', topics)
        );
    } catch (error) {
        next(error);
    }
};

export const getTopicById = async (req, res, next) => {
    try {
        const topic = await topicRepository.findById(req.params.id);
        
        if (!topic) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Topic not found');
        }
        
        res.status(HTTP_STATUS.OK).json(
            successResponse('Topic retrieved successfully', topic)
        );
    } catch (error) {
        next(error);
    }
};

export const createTopic = async (req, res, next) => {
    try {
        const topic = await topicRepository.create(req.body);
        
        res.status(HTTP_STATUS.CREATED).json(
            successResponse(SUCCESS_MESSAGES.CREATED, topic)
        );
    } catch (error) {
        next(error);
    }
};

export const updateTopic = async (req, res, next) => {
    try {
        const topic = await topicRepository.update(req.params.id, req.body);
        
        if (!topic) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Topic not found');
        }
        
        res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (error) {
        next(error);
    }
};

export const deleteTopic = async (req, res, next) => {
    try {
        const deleted = await topicRepository.delete(req.params.id);
        
        if (!deleted) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Topic not found');
        }
        
        res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (error) {
        next(error);
    }
};
