import { SubscriptionPackage, SubscriptionPackageTranslation } from '../models/index.js';
import { Op } from 'sequelize';

export class PackageRepository {
    async findAll(locale = 'en', publishedOnly = false) {
        const whereClause = publishedOnly ? { publish: true } : {};
        
        return await SubscriptionPackage.findAll({
            where: whereClause,
            include: [
                {
                    model: SubscriptionPackageTranslation,
                    as: 'translation',
                    where: { locale },
                    required: false,
                }
            ],
            order: [['created_at', 'DESC']],
        });
    }

    async findById(id) {
        return await SubscriptionPackage.findByPk(id, {
            include: [
                {
                    model: SubscriptionPackageTranslation,
                    as: 'translations',
                }
            ],
        });
    }

    async create(dto) {
        // Use DTO's toSequelize method to convert camelCase to snake_case
        const packageData = dto.toSequelize();
        const translations = dto.getTranslations();
        
        // Create package with translations using Sequelize nested creation
        const pkg = await SubscriptionPackage.create(packageData, {
            include: [{
                model: SubscriptionPackageTranslation,
                as: 'translations'
            }]
        });

        // Create translations if provided
        if (translations && translations.length > 0) {
            const translationData = translations.map(translation => ({
                subscription_package_id: pkg.id,
                locale: translation.locale,
                name: translation.name,
                detail: translation.detail,
            }));
            
            await SubscriptionPackageTranslation.bulkCreate(translationData);
        }

        return await this.findById(pkg.id);
    }

    async update(id, dto) {
        const pkg = await SubscriptionPackage.findByPk(id);
        if (!pkg) return null;
        
        // Use DTO's toSequelize method to convert camelCase to snake_case
        const packageData = dto.toSequelize();
        await pkg.update(packageData);

        // Handle translations update if provided
        const translations = dto.getTranslations();
        if (translations && translations.length > 0) {
            // Delete existing translations
            await SubscriptionPackageTranslation.destroy({
                where: { subscription_package_id: id }
            });

            // Create new translations
            const translationData = translations.map(translation => ({
                subscription_package_id: id,
                locale: translation.locale,
                name: translation.name,
                detail: translation.detail,
            }));
            
            await SubscriptionPackageTranslation.bulkCreate(translationData);
        }

        return await this.findById(id);
    }

    async delete(id) {
        const pkg = await SubscriptionPackage.findByPk(id);
        if (!pkg) return false;
        
        await pkg.destroy();
        return true;
    }

    async publish(id) {
        const pkg = await SubscriptionPackage.findByPk(id);
        if (!pkg) return null;
        
        await pkg.update({ publish: true });
        return await this.findById(id);
    }

    async unpublish(id) {
        const pkg = await SubscriptionPackage.findByPk(id);
        if (!pkg) return null;
        
        await pkg.update({ publish: false });
        return await this.findById(id);
    }

    async getTotalPackagesCount() {
        return await SubscriptionPackage.count();
    }

    async getNewPackagesCount(days = 30) {
        const date = new Date();
        date.setDate(date.getDate() - days);
        
        return await SubscriptionPackage.count({
            where: {
                created_at: { [Op.gte]: date }
            }
        });
    }
}
