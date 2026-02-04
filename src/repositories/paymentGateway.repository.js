import { PaymentGateway } from '../models/index.js';

export class PaymentGatewayRepository {
    async findAll() {
        return await PaymentGateway.findAll({
            order: [['display_order', 'ASC']],
        });
    }

    async findById(id) {
        return await PaymentGateway.findByPk(id);
    }

    async update(id, data) {
        const gateway = await PaymentGateway.findByPk(id);
        if (!gateway) return null;
        
        await gateway.update(data);
        return await PaymentGateway.findByPk(id);
    }

    async toggleActive(id) {
        const gateway = await PaymentGateway.findByPk(id);
        if (!gateway) return null;
        
        await gateway.update({ is_active: !gateway.is_active });
        return await PaymentGateway.findByPk(id);
    }
}
