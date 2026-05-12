import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { getVisitorGeoAdminStats } from '../../../services/visitorGeo.service.js';

export const getVisitorGeoStats = async (_req, res, next) => {
    try {
        const data = await getVisitorGeoAdminStats();
        res.status(HTTP_STATUS.OK).json(successResponse('Visitor geo stats', data));
    } catch (error) {
        next(error);
    }
};
