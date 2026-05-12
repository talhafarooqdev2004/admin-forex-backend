import { AppConfigRepository } from '../../../repositories/appConfig.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS } from '../../../config/constants.js';

const appConfigRepository = new AppConfigRepository();

const MAINTENANCE_KEY = 'maintenance_mode';

/** Unauthenticated: used by the Next.js middleware to decide maintenance redirects. */
export const getPublicStatus = async (req, res, next) => {
    try {
        const maintenance = await appConfigRepository.findByKey(MAINTENANCE_KEY);
        const raw = maintenance?.value;
        const maintenanceMode = raw === 'true' || raw === '1' || raw === 'yes';
        res.status(HTTP_STATUS.OK).json(
            successResponse('Public status', {
                maintenanceMode,
            }),
        );
    } catch (error) {
        next(error);
    }
};
