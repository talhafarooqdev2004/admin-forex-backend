import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { recordVisitorPing } from '../../../services/visitorGeo.service.js';

export const postVisitorAnalyticsPing = async (req, res, next) => {
    try {
        const result = await recordVisitorPing(req);
        res.status(HTTP_STATUS.OK).json(
            successResponse('Visitor analytics ping processed', result),
        );
    } catch (error) {
        next(error);
    }
};
