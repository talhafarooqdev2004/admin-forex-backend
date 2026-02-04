import { ColorConfiguration } from '../models/index.js';
import { Op } from 'sequelize';

export class ColorConfigurationRepository {
    async findAll() {
        return await ColorConfiguration.findAll({
            order: [
                ['type', 'ASC'],
                ['min_value', 'ASC']
            ],
        });
    }

    async findByType(type) {
        return await ColorConfiguration.findAll({
            where: { type },
            order: [['min_value', 'ASC']],
        });
    }

    async findById(id) {
        return await ColorConfiguration.findByPk(id);
    }

    async create(data) {
        return await ColorConfiguration.create(data);
    }

    async update(id, data) {
        const config = await ColorConfiguration.findByPk(id);
        if (!config) return null;
        
        await config.update(data);
        return await ColorConfiguration.findByPk(id);
    }

    async delete(id) {
        const config = await ColorConfiguration.findByPk(id);
        if (!config) return false;
        
        await config.destroy();
        return true;
    }

    async deleteByType(type) {
        await ColorConfiguration.destroy({
            where: { type }
        });
    }

    async bulkUpdate(type, configurations) {
        // Delete existing configurations for this type
        await this.deleteByType(type);
        
        // Insert new configurations
        const configsToCreate = configurations.map(config => ({
            ...config,
            type
        }));
        
        return await ColorConfiguration.bulkCreate(configsToCreate);
    }
}
