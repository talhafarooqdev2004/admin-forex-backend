import { PageContent, PageContentTranslation } from '../models/index.js';

export class PageContentRepository {
    async findByPageIdentifier(pageIdentifier) {
        return await PageContent.findAll({
            where: { page_identifier: pageIdentifier },
            include: [
                {
                    model: PageContentTranslation,
                    as: 'translations',
                }
            ],
        });
    }

    async findById(id) {
        return await PageContent.findByPk(id, {
            include: [
                {
                    model: PageContentTranslation,
                    as: 'translations',
                }
            ],
        });
    }

    async findByPageIdentifierAndSectionKey(pageIdentifier, sectionKey) {
        if (!sectionKey) {
            throw new Error('sectionKey is required');
        }
        
        return await PageContent.findOne({
            where: { 
                page_identifier: pageIdentifier,
                section_key: sectionKey
            },
            include: [
                {
                    model: PageContentTranslation,
                    as: 'translations',
                }
            ],
        });
    }

    async update(id, contentData) {
        const content = await PageContent.findByPk(id);
        if (!content) return null;
        
        // Extract translations from contentData
        const translations = contentData.translations;
        delete contentData.translations;
        
        // Update content if there are other fields
        if (Object.keys(contentData).length > 0) {
            await content.update(contentData);
        }
        
        // Handle translations update if provided
        if (translations && typeof translations === 'object') {
            // Delete existing translations
            await PageContentTranslation.destroy({
                where: { page_content_id: id }
            });
            
            // Create new translations
            const translationData = Object.entries(translations).map(([locale, contentValue]) => ({
                page_content_id: id,
                locale: locale,
                content_value: typeof contentValue === 'string' ? contentValue : contentValue?.content_value || contentValue?.contentValue || '',
            }));
            
            if (translationData.length > 0) {
                await PageContentTranslation.bulkCreate(translationData);
            }
        }
        
        return await this.findById(id);
    }
}
