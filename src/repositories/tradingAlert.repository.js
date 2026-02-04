import { TradingAlert } from '../models/index.js';

export class TradingAlertRepository {
    async findAll() {
        return await TradingAlert.findAll({
            order: [['date', 'DESC']],
        });
    }

    async findById(id) {
        return await TradingAlert.findByPk(id);
    }

    async create(alertData) {
        return await TradingAlert.create(alertData);
    }

    async update(id, alertData) {
        const alert = await TradingAlert.findByPk(id);
        if (!alert) return null;
        
        await alert.update(alertData);
        return await TradingAlert.findByPk(id);
    }

    async delete(id) {
        const alert = await TradingAlert.findByPk(id);
        if (!alert) return false;
        
        await alert.destroy();
        return true;
    }
}
