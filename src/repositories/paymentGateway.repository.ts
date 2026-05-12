import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
export class PaymentGatewayRepository {
    async findAll() {
        const gateways = await prisma.paymentGateway.findMany({
            orderBy: {
                display_order: 'asc',
            },
        });
        return serializePrisma(gateways);
    }
    async findById(id) {
        const gateway = await prisma.paymentGateway.findUnique({
            where: {
                id: BigInt(id),
            },
        });
        return serializePrisma(gateway);
    }
    async update(id, data) {
        const existingGateway = await prisma.paymentGateway.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingGateway)
            return null;
        const gateway = await prisma.paymentGateway.update({
            where: {
                id: BigInt(id),
            },
            data,
        });
        return serializePrisma(gateway);
    }
    async toggleActive(id) {
        const gateway = await prisma.paymentGateway.findUnique({
            where: {
                id: BigInt(id),
            },
        });
        if (!gateway)
            return null;
        const updatedGateway = await prisma.paymentGateway.update({
            where: {
                id: BigInt(id),
            },
            data: {
                is_active: !gateway.is_active,
            },
        });
        return serializePrisma(updatedGateway);
    }
}
