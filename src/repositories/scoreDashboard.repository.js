import { ScoreDashboard, CurrencyPair } from '../models/index.js';

export class ScoreDashboardRepository {
    async findAll() {
        return await ScoreDashboard.findAll({
            include: [
                {
                    model: CurrencyPair,
                    as: 'currencyPair',
                }
            ],
            order: [['currency_pair_id', 'ASC']],
        });
    }

    async findByCurrencyPairId(currencyPairId) {
        return await ScoreDashboard.findOne({
            where: { currency_pair_id: currencyPairId },
            include: [
                {
                    model: CurrencyPair,
                    as: 'currencyPair',
                }
            ],
        });
    }

    async updateOrCreate(currencyPairId, scoreData) {
        const [score] = await ScoreDashboard.upsert({
            currency_pair_id: currencyPairId,
            ...scoreData,
            calculated_at: new Date()
        }, {
            returning: true
        });
        
        return await ScoreDashboard.findByPk(score.id, {
            include: [
                {
                    model: CurrencyPair,
                    as: 'currencyPair',
                }
            ],
        });
    }

    async deleteByCurrencyPairId(currencyPairId) {
        await ScoreDashboard.destroy({
            where: { currency_pair_id: currencyPairId }
        });
    }
}
