import { AppConfig } from '../models/index.js';

export class AppConfigRepository {
    async findByKey(key) {
        return await AppConfig.findOne({
            where: { key }
        });
    }

    async updateOrCreate(key, value = null, description = null) {
        const [config] = await AppConfig.upsert({
            key,
            value,
            description
        }, {
            returning: true
        });
        
        return config;
    }

    async findAll() {
        return await AppConfig.findAll({
            order: [['key', 'ASC']]
        });
    }
}
