import { ForumPostRepository } from '../../../repositories/forum/post.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';

const postRepository = new ForumPostRepository();

export const getAllPosts = async (req, res, next) => {
    try {
        const locale = req.query.locale || 'en';
        const posts = await postRepository.findAll(locale);
        
        res.status(HTTP_STATUS.OK).json(
            successResponse('Posts retrieved successfully', posts)
        );
    } catch (error) {
        next(error);
    }
};

export const getPostById = async (req, res, next) => {
    try {
        const post = await postRepository.findById(req.params.id);
        
        if (!post) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Post not found');
        }
        
        res.status(HTTP_STATUS.OK).json(
            successResponse('Post retrieved successfully', post)
        );
    } catch (error) {
        next(error);
    }
};

export const createPost = async (req, res, next) => {
    try {
        const post = await postRepository.create(req.body);
        
        res.status(HTTP_STATUS.CREATED).json(
            successResponse(SUCCESS_MESSAGES.CREATED, post)
        );
    } catch (error) {
        next(error);
    }
};

export const updatePost = async (req, res, next) => {
    try {
        const post = await postRepository.update(req.params.id, req.body);
        
        if (!post) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Post not found');
        }
        
        res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (error) {
        next(error);
    }
};

export const deletePost = async (req, res, next) => {
    try {
        const deleted = await postRepository.delete(req.params.id);
        
        if (!deleted) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Post not found');
        }
        
        res.status(HTTP_STATUS.NO_CONTENT).send();
    } catch (error) {
        next(error);
    }
};
