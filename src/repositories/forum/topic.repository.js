import { ForumTopic, ForumTopicTranslation } from '../../models/index.js';

export class ForumTopicRepository {
    async findAll(locale = 'en') {
        return await ForumTopic.findAll({
            include: [
                {
                    model: ForumTopicTranslation,
                    as: 'translation',
                    where: { locale },
                    required: false,
                }
            ],
            order: [['created_at', 'DESC']],
        });
    }

    async findById(id) {
        return await ForumTopic.findByPk(id, {
            include: [
                {
                    model: ForumTopicTranslation,
                    as: 'translations',
                }
            ],
        });
    }

    async create(topicData) {
        // Extract translations from topicData
        const translations = topicData.translations || [];
        delete topicData.translations;
        
        // Create topic first
        const topic = await ForumTopic.create(topicData);
        
        // Create translations if provided
        if (translations && translations.length > 0) {
            const translationData = translations.map(translation => ({
                topic_id: topic.id,
                locale: translation.locale,
                title: translation.title,
            }));
            
            await ForumTopicTranslation.bulkCreate(translationData);
        }
        
        return await this.findById(topic.id);
    }

    async update(id, topicData) {
        const topic = await ForumTopic.findByPk(id);
        if (!topic) return null;
        
        // Extract translations from topicData
        const translations = topicData.translations;
        delete topicData.translations;
        
        // Update topic if there are other fields
        if (Object.keys(topicData).length > 0) {
            await topic.update(topicData);
        }
        
        // Handle translations update if provided
        if (translations && translations.length > 0) {
            // Delete existing translations
            await ForumTopicTranslation.destroy({
                where: { topic_id: id }
            });
            
            // Create new translations
            const translationData = translations.map(translation => ({
                topic_id: id,
                locale: translation.locale,
                title: translation.title,
            }));
            
            await ForumTopicTranslation.bulkCreate(translationData);
        }
        
        return await this.findById(id);
    }

    async delete(id) {
        const topic = await ForumTopic.findByPk(id);
        if (!topic) return false;
        
        await topic.destroy();
        return true;
    }
}
