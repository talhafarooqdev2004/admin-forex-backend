import {
    NextFunction,
    Request,
    Response,
} from "express";
import { HTTP_STATUS, SUCCESS_MESSAGES } from "../../config/constants.js";
import { ApiError } from "../../exceptions/ApiError.js";
import { successResponse } from "../../utils/response.util.js";
import type {
    CreateForumPostInput,
    CreateForumPostReplyInput,
    ForumPostQueryInput,
} from "../../schemas/forum/createForumPost.schema.js";
import { ForumPostResponseDTO } from "../../dtos/v1/Forum/Posts/ForumPostResponseDTO.js";
import { ForumPostStoreRequestDTO } from "../../dtos/v1/Forum/Posts/Store/ForumPostStoreRequestDTO.js";
import { ForumPostStoreResponseDTO } from "../../dtos/v1/Forum/Posts/Store/ForumPostStoreResponseDTO.js";
import { ForumPostsService } from "../../services/forumPosts.service.js";

export class ForumPostsController {
    constructor(private readonly forumPostsService: ForumPostsService) { }

    index = async (
        req: Request<{}, unknown, unknown, ForumPostQueryInput>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const posts = await this.forumPostsService.findAll(req.query.category);
            const responseDto = posts.map((post) => ForumPostResponseDTO.fromModel(post));

            res
                .status(HTTP_STATUS.OK)
                .json(successResponse("Forum posts retrieved successfully", responseDto));
        } catch (error) {
            next(error);
        }
    };

    show = async (
        req: Request<{ id: string }>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const post = await this.forumPostsService.findById(req.params.id);

            if (!post) {
                throw new ApiError(HTTP_STATUS.NOT_FOUND, "Forum post not found");
            }

            res
                .status(HTTP_STATUS.OK)
                .json(successResponse("Forum post retrieved successfully", ForumPostResponseDTO.fromModel(post)));
        } catch (error) {
            next(error);
        }
    };

    createPost = async (
        req: Request<{}, unknown, CreateForumPostInput>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const requestDto = ForumPostStoreRequestDTO.toRequest(req.body);
            const post = await this.forumPostsService.createPost(requestDto.toJSON());
            const responseDto = ForumPostStoreResponseDTO.fromModel(post);

            res
                .status(HTTP_STATUS.CREATED)
                .json(successResponse(SUCCESS_MESSAGES.CREATED, responseDto));
        } catch (error) {
            next(error);
        }
    };

    updatePost = async (
        req: Request<{ id: string }, unknown, CreateForumPostInput>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const requestDto = ForumPostStoreRequestDTO.toRequest(req.body);
            const post = await this.forumPostsService.updatePost(req.params.id, requestDto.toJSON());

            if (!post) {
                throw new ApiError(HTTP_STATUS.NOT_FOUND, "Forum post not found");
            }

            res
                .status(HTTP_STATUS.OK)
                .json(successResponse(SUCCESS_MESSAGES.UPDATED, ForumPostResponseDTO.fromModel(post)));
        } catch (error) {
            next(error);
        }
    };

    uploadImage = async (
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const uploadedFile = (req as Request & { file?: { filename: string } }).file;

            if (!uploadedFile) {
                throw new ApiError(HTTP_STATUS.BAD_REQUEST, "Image file is required");
            }

            res
                .status(HTTP_STATUS.OK)
                .json(successResponse("Forum post image uploaded successfully", {
                    imagePath: `/uploads/forum-posts/${uploadedFile.filename}`,
                }));
        } catch (error) {
            next(error);
        }
    };

    addReply = async (
        req: Request<{ id: string }, unknown, CreateForumPostReplyInput>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const post = await this.forumPostsService.addReply(req.params.id, {
                message: req.body.message,
            });

            if (!post) {
                throw new ApiError(HTTP_STATUS.NOT_FOUND, "Forum post not found");
            }

            res
                .status(HTTP_STATUS.OK)
                .json(successResponse("Reply added successfully", ForumPostResponseDTO.fromModel(post)));
        } catch (error) {
            next(error);
        }
    };

    incrementViewCount = async (
        req: Request<{ id: string }>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const post = await this.forumPostsService.incrementViewCount(req.params.id);

            if (!post) {
                throw new ApiError(HTTP_STATUS.NOT_FOUND, "Forum post not found");
            }

            res
                .status(HTTP_STATUS.OK)
                .json(successResponse("Forum post view count updated successfully", ForumPostResponseDTO.fromModel(post)));
        } catch (error) {
            next(error);
        }
    };

    deletePost = async (
        req: Request<{ id: string }>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const deleted = await this.forumPostsService.deletePost(req.params.id);

            if (!deleted) {
                throw new ApiError(HTTP_STATUS.NOT_FOUND, "Forum post not found");
            }

            res.status(HTTP_STATUS.NO_CONTENT).send();
        } catch (error) {
            next(error);
        }
    };
}
