import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
export class ColorConfigurationRepository {
    async findAll() {
        const configurations = await prisma.colorConfiguration.findMany({
            orderBy: [
                { type: 'asc' },
                { min_value: 'asc' },
            ],
        });
        return serializePrisma(configurations);
    }
    async findByType(type) {
        const configurations = await prisma.colorConfiguration.findMany({
            where: { type },
            orderBy: {
                min_value: 'asc',
            },
        });
        return serializePrisma(configurations);
    }
    async findById(id) {
        const configuration = await prisma.colorConfiguration.findUnique({
            where: {
                id: BigInt(id),
            },
        });
        return serializePrisma(configuration);
    }
    async create(data) {
        const configuration = await prisma.colorConfiguration.create({
            data,
        });
        return serializePrisma(configuration);
    }
    async update(id, data) {
        const existingConfiguration = await prisma.colorConfiguration.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingConfiguration)
            return null;
        const configuration = await prisma.colorConfiguration.update({
            where: {
                id: BigInt(id),
            },
            data,
        });
        return serializePrisma(configuration);
    }
    async delete(id) {
        const existingConfiguration = await prisma.colorConfiguration.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingConfiguration)
            return false;
        await prisma.colorConfiguration.delete({
            where: {
                id: BigInt(id),
            },
        });
        return true;
    }
    async deleteByType(type) {
        await prisma.colorConfiguration.deleteMany({
            where: { type },
        });
    }
    async bulkUpdate(type, configurations) {
        await prisma.$transaction(async (tx) => {
            await tx.colorConfiguration.deleteMany({
                where: { type },
            });
            if (configurations.length > 0) {
                await tx.colorConfiguration.createMany({
                    data: configurations.map((config) => ({
                        ...config,
                        type,
                    })),
                });
            }
        });
        return this.findByType(type);
    }
}
