import { PackageRepository } from '../../../repositories/package.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { PackageStoreRequestDTO } from '../../../dtos/v1/subscription/package/PackageStoreRequestDTO.js';
import { PackagePutRequestDTO } from '../../../dtos/v1/subscription/package/PackagePutRequestDTO.js';
const packageRepository = new PackageRepository();
export const getAllPackages = async (req, res, next) => {
    try {
        const locale = req.query.locale || 'en';
        const publishedOnly = req.path === '/packages' || !req.path.includes('/admin');
        const packages = await packageRepository.findAll(locale, publishedOnly);
        res.status(HTTP_STATUS.OK).json(successResponse('Packages retrieved successfully', packages));
    }
    catch (error) {
        next(error);
    }
};
export const getPackageById = async (req, res, next) => {
    try {
        const pkg = await packageRepository.findById(req.params.id);
        if (!pkg) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Package not found');
        }
        res.status(HTTP_STATUS.OK).json(successResponse('Package retrieved successfully', pkg));
    }
    catch (error) {
        next(error);
    }
};
export const createPackage = async (req, res, next) => {
    try {
        const dto = new PackageStoreRequestDTO(req.body);
        const pkg = await packageRepository.create(dto);
        res.status(HTTP_STATUS.CREATED).json(successResponse(SUCCESS_MESSAGES.CREATED, pkg));
    }
    catch (error) {
        next(error);
    }
};
export const updatePackage = async (req, res, next) => {
    try {
        const dto = new PackagePutRequestDTO(req.body);
        const pkg = await packageRepository.update(req.params.id, dto);
        if (!pkg) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Package not found');
        }
        res.status(HTTP_STATUS.NO_CONTENT).send();
    }
    catch (error) {
        next(error);
    }
};
export const deletePackage = async (req, res, next) => {
    try {
        const deleted = await packageRepository.delete(req.params.id);
        if (!deleted) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Package not found');
        }
        res.status(HTTP_STATUS.NO_CONTENT).send();
    }
    catch (error) {
        next(error);
    }
};
export const publishPackage = async (req, res, next) => {
    try {
        const pkg = await packageRepository.publish(req.params.id);
        if (!pkg) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Package not found');
        }
        res.status(HTTP_STATUS.OK).json(successResponse(SUCCESS_MESSAGES.PUBLISHED, pkg));
    }
    catch (error) {
        next(error);
    }
};
export const unpublishPackage = async (req, res, next) => {
    try {
        const pkg = await packageRepository.unpublish(req.params.id);
        if (!pkg) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Package not found');
        }
        res.status(HTTP_STATUS.OK).json(successResponse(SUCCESS_MESSAGES.UNPUBLISHED, pkg));
    }
    catch (error) {
        next(error);
    }
};
export const getPackageStats = async (req, res, next) => {
    try {
        const [totalPackages, newPackages] = await Promise.all([
            packageRepository.getTotalPackagesCount(),
            packageRepository.getNewPackagesCount(30),
        ]);
        const stats = {
            total_packages: totalPackages,
            new_packages_last_30_days: newPackages,
        };
        res.status(HTTP_STATUS.OK).json(successResponse('Package statistics retrieved successfully', stats));
    }
    catch (error) {
        next(error);
    }
};
