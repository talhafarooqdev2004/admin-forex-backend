import {
    NextFunction,
    Request,
    Response,
} from "express";
import { HTTP_STATUS, SUCCESS_MESSAGES } from "../../config/constants.js";
import { ApiError } from "../../exceptions/ApiError.js";
import { successResponse } from "../../utils/response.util.js";
import type { CreateForumAnnouncementInput, ForumAnnouncementQueryInput } from "../../schemas/forum/createForumAnnouncement.schema.js";
import { AnnouncementStoreRequestDTO } from "../../dtos/v1/Forum/Announcements/Store/AnnouncementStoreRequestDTO.js";
import { AnnouncementStoreResponseDTO } from "../../dtos/v1/Forum/Announcements/Store/AnnouncementStoreResponseDTO.js";
import { AnnouncementResponseDTO } from "../../dtos/v1/Forum/Announcements/AnnouncementResponseDTO.js";
import { ForumAnnouncementsService } from "../../services/forumAnnouncements.service.js";

export class ForumAnnouncementsController {
    constructor(private readonly forumAnnouncementsService: ForumAnnouncementsService) { }

    index = async (
        req: Request<{}, unknown, unknown, ForumAnnouncementQueryInput>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const locale = req.query.locale ?? "en";
            const announcements = await this.forumAnnouncementsService.findAll(locale);
            const responseDto = announcements.map((announcement) => AnnouncementResponseDTO.fromModel(announcement));

            res
                .status(HTTP_STATUS.OK)
                .json(successResponse("Announcements retrieved successfully", responseDto));
        } catch (error) {
            next(error);
        }
    };

    show = async (
        req: Request<{ id: string }, unknown, unknown, ForumAnnouncementQueryInput>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const locale = req.query.locale;
            const announcement = await this.forumAnnouncementsService.findById(req.params.id, locale);

            if (!announcement) {
                throw new ApiError(HTTP_STATUS.NOT_FOUND, "Announcement not found");
            }

            res
                .status(HTTP_STATUS.OK)
                .json(successResponse("Announcement retrieved successfully", AnnouncementResponseDTO.fromModel(announcement)));
        } catch (error) {
            next(error);
        }
    };

    createAnnouncement = async (
        req: Request<{}, unknown, CreateForumAnnouncementInput>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const requestDto = AnnouncementStoreRequestDTO.toRequest(req.body);
            const announcement = await this.forumAnnouncementsService.createAnnouncement(requestDto);
            const responseDto = AnnouncementStoreResponseDTO.fromModel(announcement);

            res
                .status(HTTP_STATUS.CREATED)
                .json(successResponse(SUCCESS_MESSAGES.CREATED, responseDto));
        } catch (error) {
            next(error);
        }
    };

    updateAnnouncement = async (
        req: Request<{ id: string }, unknown, CreateForumAnnouncementInput, ForumAnnouncementQueryInput>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const locale = req.query.locale;
            const requestDto = AnnouncementStoreRequestDTO.toRequest(req.body);
            const announcement = await this.forumAnnouncementsService.updateAnnouncement(req.params.id, requestDto, locale);

            if (!announcement) {
                throw new ApiError(HTTP_STATUS.NOT_FOUND, "Announcement not found");
            }

            res
                .status(HTTP_STATUS.OK)
                .json(successResponse(SUCCESS_MESSAGES.UPDATED, AnnouncementResponseDTO.fromModel(announcement)));
        } catch (error) {
            next(error);
        }
    };

    deleteAnnouncement = async (
        req: Request<{ id: string }>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const deleted = await this.forumAnnouncementsService.deleteAnnouncement(req.params.id);

            if (!deleted) {
                throw new ApiError(HTTP_STATUS.NOT_FOUND, "Announcement not found");
            }

            res.status(HTTP_STATUS.NO_CONTENT).send();
        } catch (error) {
            next(error);
        }
    };
}
