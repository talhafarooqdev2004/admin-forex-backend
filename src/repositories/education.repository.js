import { Education, EducationTranslation } from '../models/index.js';

export class EducationRepository {
    async findAll(locale = 'en') {
        return await Education.findAll({
            include: [
                {
                    model: EducationTranslation,
                    as: 'translation',
                    where: { locale },
                    required: false,
                }
            ],
            order: [['created_at', 'DESC']],
        });
    }

    async findById(id) {
        return await Education.findByPk(id, {
            include: [
                {
                    model: EducationTranslation,
                    as: 'translations',
                }
            ],
        });
    }

    async create(educationData) {
        // Extract translations from educationData
        const translations = educationData.translations || [];
        delete educationData.translations;
        
        // Create education first
        const education = await Education.create(educationData);
        
        // Create translations if provided
        if (translations && translations.length > 0) {
            const translationData = translations.map(translation => ({
                education_id: education.id,
                locale: translation.locale,
                title: translation.title,
                content: translation.content,
            }));
            
            await EducationTranslation.bulkCreate(translationData);
        }
        
        return await this.findById(education.id);
    }

    async update(id, educationData) {
        const education = await Education.findByPk(id);
        if (!education) return null;
        
        // Extract translations from educationData
        const translations = educationData.translations;
        delete educationData.translations;
        
        // Update education if there are other fields
        if (Object.keys(educationData).length > 0) {
            await education.update(educationData);
        }
        
        // Handle translations update if provided
        if (translations && translations.length > 0) {
            // Delete existing translations
            await EducationTranslation.destroy({
                where: { education_id: id }
            });
            
            // Create new translations
            const translationData = translations.map(translation => ({
                education_id: id,
                locale: translation.locale,
                title: translation.title,
                content: translation.content,
            }));
            
            await EducationTranslation.bulkCreate(translationData);
        }
        
        return await this.findById(id);
    }

    async delete(id) {
        const education = await Education.findByPk(id);
        if (!education) return false;
        
        await education.destroy();
        return true;
    }

    async publish(id) {
        const education = await Education.findByPk(id);
        if (!education) return null;
        
        await education.update({ publish: true });
        return await this.findById(id);
    }

    async unpublish(id) {
        const education = await Education.findByPk(id);
        if (!education) return null;
        
        await education.update({ publish: false });
        return await this.findById(id);
    }
}
