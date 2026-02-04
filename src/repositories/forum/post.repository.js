import { ForumPost, ForumPostTranslation, ForumTopic, ForumTopicTranslation } from '../../models/index.js';
import { Op } from 'sequelize';

export class ForumPostRepository {
    async findAll(locale = 'en') {
        return await ForumPost.findAll({
            attributes: ['id', 'topic_id', 'banner_img', 'slug', 'created_at', 'updated_at'],
            include: [
                {
                    model: ForumPostTranslation,
                    as: 'translation',
                    attributes: ['title', 'content'],
                    where: { locale },
                    required: false,
                },
                {
                    model: ForumTopic,
                    as: 'topic',
                    attributes: ['id'],
                    include: [
                        {
                            model: ForumTopicTranslation,
                            as: 'translation',
                            where: { locale },
                            required: false,
                        }
                    ]
                }
            ],
            order: [['created_at', 'DESC']],
        });
    }

    async findById(id) {
        return await ForumPost.findByPk(id, {
            include: [
                {
                    model: ForumPostTranslation,
                    as: 'translations',
                },
                {
                    model: ForumTopic,
                    as: 'topic',
                }
            ],
        });
    }

    async findBySlug(slug, locale = 'en') {
        return await ForumPost.findOne({
            where: { slug },
            include: [
                {
                    model: ForumPostTranslation,
                    as: 'translations',
                    where: { locale },
                    required: false,
                },
                {
                    model: ForumTopic,
                    as: 'topic',
                    include: [
                        {
                            model: ForumTopicTranslation,
                            as: 'translations',
                            where: { locale },
                            required: false,
                        }
                    ]
                }
            ],
        });
    }

    async findByTopicId(topicId, locale = 'en') {
        return await ForumPost.findAll({
            where: { topic_id: topicId },
            include: [
                {
                    model: ForumPostTranslation,
                    as: 'translation',
                    where: { locale },
                    required: false,
                }
            ],
            order: [['created_at', 'DESC']],
        });
    }

    async create(postData) {
        // Extract translations from postData
        const translations = postData.translations || [];
        delete postData.translations;
        
        // Create post first
        const post = await ForumPost.create(postData);
        
        // Create translations if provided
        if (translations && translations.length > 0) {
            const translationData = translations.map(translation => ({
                post_id: post.id,
                locale: translation.locale,
                title: translation.title,
                content: translation.content,
            }));
            
            await ForumPostTranslation.bulkCreate(translationData);
        }
        
        return await this.findById(post.id);
    }

    async update(id, postData) {
        const post = await ForumPost.findByPk(id);
        if (!post) return null;
        
        // Extract translations from postData
        const translations = postData.translations;
        delete postData.translations;
        
        // Update post if there are other fields
        if (Object.keys(postData).length > 0) {
            await post.update(postData);
        }
        
        // Handle translations update if provided
        if (translations && translations.length > 0) {
            // Delete existing translations
            await ForumPostTranslation.destroy({
                where: { post_id: id }
            });
            
            // Create new translations
            const translationData = translations.map(translation => ({
                post_id: id,
                locale: translation.locale,
                title: translation.title,
                content: translation.content,
            }));
            
            await ForumPostTranslation.bulkCreate(translationData);
        }
        
        return await this.findById(id);
    }

    async delete(id) {
        const post = await ForumPost.findByPk(id);
        if (!post) return false;
        
        await post.destroy();
        return true;
    }
}
