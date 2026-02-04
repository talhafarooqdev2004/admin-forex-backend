import { PageContentRepository } from '../../../repositories/pageContent.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';

const pageContentRepository = new PageContentRepository();

export const getPageContent = async (req, res, next) => {
    try {
        const { pageIdentifier } = req.params;
        const content = await pageContentRepository.findByPageIdentifier(pageIdentifier);
        
        res.status(HTTP_STATUS.OK).json(
            successResponse('Page content retrieved successfully', content)
        );
    } catch (error) {
        next(error);
    }
};

export const updatePageContent = async (req, res, next) => {
    try {
        const { pageIdentifier } = req.params;
        const { sectionId, section_key, sectionKey, translations, ...updateData } = req.body;
        
        let content;
        
        // If sectionId is provided, find by ID directly
        if (sectionId) {
            content = await pageContentRepository.findById(sectionId);
        } 
        // Otherwise, use section_key or sectionKey to find by page identifier and section key
        else if (section_key || sectionKey) {
            const key = section_key || sectionKey;
            content = await pageContentRepository.findByPageIdentifierAndSectionKey(
                pageIdentifier,
                key
            );
        } else {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'sectionId or section_key is required');
        }
        
        if (!content) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Page content not found');
        }
        
        // Handle translations if provided
        const finalUpdateData = { ...updateData };
        if (translations) {
            finalUpdateData.translations = translations;
        }
        
        await pageContentRepository.update(content.id, finalUpdateData);
        
        res.status(HTTP_STATUS.OK).json(
            successResponse(SUCCESS_MESSAGES.UPDATED)
        );
    } catch (error) {
        next(error);
    }
};
