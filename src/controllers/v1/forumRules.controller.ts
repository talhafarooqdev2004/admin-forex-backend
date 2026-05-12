import {
    NextFunction,
    Request,
    Response,
} from "express";
import { HTTP_STATUS, SUCCESS_MESSAGES } from "../../config/constants.js";
import { ApiError } from "../../exceptions/ApiError.js";
import { ForumRulesService } from "../../services/forumRules.service.js";
import { successResponse } from "../../utils/response.util.js";
import type { CreateForumRuleInput, ForumRuleQueryInput } from "../../schemas/forum/createForumRule.schema.js";
import { RuleStoreRequestDTO } from "../../dtos/v1/Forum/Rules/Store/RuleStoreRequestDTO.js";
import { RuleStoreResponseDTO } from "../../dtos/v1/Forum/Rules/Store/RuleStoreResponseDTO.js";
import { RuleResponseDTO } from "../../dtos/v1/Forum/Rules/RuleResponseDTO.js";

export class ForumRulesController {
    constructor(private readonly forumRulesService: ForumRulesService) { }

    index = async (
        req: Request<{}, unknown, unknown, ForumRuleQueryInput>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const locale = req.query.locale ?? "en";
            const rules = await this.forumRulesService.findAll(locale);
            const responseDto = rules.map((rule) => RuleResponseDTO.fromModel(rule));

            res
                .status(HTTP_STATUS.OK)
                .json(successResponse("Forum rules retrieved successfully", responseDto));
        } catch (error) {
            next(error);
        }
    };

    show = async (
        req: Request<{ id: string }, unknown, unknown, ForumRuleQueryInput>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const locale = req.query.locale;
            const rule = await this.forumRulesService.findById(req.params.id, locale);

            if (!rule) {
                throw new ApiError(HTTP_STATUS.NOT_FOUND, "Forum rule not found");
            }

            res
                .status(HTTP_STATUS.OK)
                .json(successResponse("Forum rule retrieved successfully", RuleResponseDTO.fromModel(rule)));
        } catch (error) {
            next(error);
        }
    };

    createRule = async (
        req: Request<{}, unknown, CreateForumRuleInput>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const requestDto = RuleStoreRequestDTO.toRequest(req.body);
            const rule = await this.forumRulesService.createRule(requestDto);
            const responseDto = RuleStoreResponseDTO.fromModel(rule);

            res
                .status(HTTP_STATUS.CREATED)
                .json(successResponse(SUCCESS_MESSAGES.CREATED, responseDto));
        } catch (error) {
            next(error);
        }
    };

    updateRule = async (
        req: Request<{ id: string }, unknown, CreateForumRuleInput, ForumRuleQueryInput>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const locale = req.query.locale;
            const requestDto = RuleStoreRequestDTO.toRequest(req.body);
            const rule = await this.forumRulesService.updateRule(req.params.id, requestDto, locale);

            if (!rule) {
                throw new ApiError(HTTP_STATUS.NOT_FOUND, "Forum rule not found");
            }

            res
                .status(HTTP_STATUS.OK)
                .json(successResponse(SUCCESS_MESSAGES.UPDATED, RuleResponseDTO.fromModel(rule)));
        } catch (error) {
            next(error);
        }
    };

    deleteRule = async (
        req: Request<{ id: string }>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const deleted = await this.forumRulesService.deleteRule(req.params.id);

            if (!deleted) {
                throw new ApiError(HTTP_STATUS.NOT_FOUND, "Forum rule not found");
            }

            res.status(HTTP_STATUS.NO_CONTENT).send();
        } catch (error) {
            next(error);
        }
    };
}
