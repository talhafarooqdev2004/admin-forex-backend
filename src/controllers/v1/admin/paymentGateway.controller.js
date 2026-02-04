import { PaymentGatewayRepository } from '../../../repositories/paymentGateway.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';

const paymentGatewayRepository = new PaymentGatewayRepository();

export const getAllPaymentGateways = async (req, res, next) => {
    try {
        const gateways = await paymentGatewayRepository.findAll();
        
        res.status(HTTP_STATUS.OK).json(
            successResponse('Payment gateways retrieved successfully', gateways)
        );
    } catch (error) {
        next(error);
    }
};

export const updatePaymentGateway = async (req, res, next) => {
    try {
        const gateway = await paymentGatewayRepository.update(req.params.id, req.body);
        
        if (!gateway) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Payment gateway not found');
        }
        
        res.status(HTTP_STATUS.OK).json(
            successResponse(SUCCESS_MESSAGES.UPDATED, gateway)
        );
    } catch (error) {
        next(error);
    }
};

export const toggleActivePaymentGateway = async (req, res, next) => {
    try {
        const gateway = await paymentGatewayRepository.toggleActive(req.params.id);
        
        if (!gateway) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Payment gateway not found');
        }
        
        res.status(HTTP_STATUS.OK).json(
            successResponse('Payment gateway status updated successfully', gateway)
        );
    } catch (error) {
        next(error);
    }
};
