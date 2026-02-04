import { RiskModeScore } from '../models/index.js';

export class RiskModeScoreRepository {
    async getCurrent() {
        return await RiskModeScore.findOne({
            order: [['id', 'ASC']]
        });
    }

    async updateOrCreate(score) {
        const [riskScore] = await RiskModeScore.upsert({
            id: 1,
            score: score
        }, {
            returning: true
        });
        
        return riskScore;
    }
}
