import { CurrencyPair } from '../models/index.js';

export class CurrencyPairRepository {
    async findAll() {
        return await CurrencyPair.findAll({
            order: [['display_order', 'ASC']],
        });
    }

    async findById(id) {
        return await CurrencyPair.findByPk(id);
    }

    async findByCode(code) {
        return await CurrencyPair.findOne({
            where: { code }
        });
    }
}
