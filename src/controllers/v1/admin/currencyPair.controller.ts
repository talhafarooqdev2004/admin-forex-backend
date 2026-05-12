import { CurrencyPairRepository } from '../../../repositories/currencyPair.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS } from '../../../config/constants.js';
const currencyPairRepository = new CurrencyPairRepository();
export const getAllCurrencyPairs = async (req, res, next) => {
    try {
        const pairs = await currencyPairRepository.findAll();
        res.status(HTTP_STATUS.OK).json(successResponse('Currency pairs retrieved successfully', pairs));
    }
    catch (error) {
        next(error);
    }
};
