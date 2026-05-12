import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
const mapPackage = (pkg, locale) => {
    const serialized = serializePrisma(pkg);
    if (!serialized) {
        return serialized;
    }
    const transformed = {
        id: serialized.id,
        price: serialized.price,
        durationHours: serialized.duration_hours ?? null,
        freeTrailHours: serialized.free_trial_hours ?? null,
        additionalDiscounts: serialized.additional_discounts ?? null,
        campaigns: serialized.campaigns ?? null,
        published: serialized.publish ?? false,
        created_at: serialized.created_at,
        updated_at: serialized.updated_at,
    };
    if (serialized.translations) {
        transformed.translations = serialized.translations;
    }
    if (locale) {
        transformed.translation = serialized.translations?.[0] || null;
    }
    return transformed;
};
export class PackageRepository {
    async findAll(locale = 'en', publishedOnly = false) {
        const packages = await prisma.subscriptionPackage.findMany({
            where: publishedOnly ? { publish: true } : undefined,
            include: {
                translations: {
                    where: { locale },
                    take: 1,
                },
            },
            orderBy: {
                created_at: 'desc',
            },
        });
        return packages.map((pkg) => mapPackage(pkg, locale));
    }
    async findById(id) {
        const pkg = await prisma.subscriptionPackage.findUnique({
            where: {
                id: BigInt(id),
            },
            include: {
                translations: true,
            },
        });
        return mapPackage(pkg);
    }
    async create(dto) {
        const packageData = dto.toPersistence();
        const translations = dto.getTranslations();
        const pkg = await prisma.subscriptionPackage.create({
            data: {
                ...packageData,
                translations: translations && translations.length > 0
                    ? {
                        create: translations.map((translation) => ({
                            locale: translation.locale,
                            name: translation.name,
                            detail: translation.detail,
                        })),
                    }
                    : undefined,
            },
            include: {
                translations: true,
            },
        });
        return mapPackage(pkg);
    }
    async update(id, dto) {
        const existingPackage = await prisma.subscriptionPackage.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingPackage)
            return null;
        const packageData = dto.toPersistence();
        const translations = dto.getTranslations();
        await prisma.$transaction(async (tx) => {
            await tx.subscriptionPackage.update({
                where: {
                    id: BigInt(id),
                },
                data: packageData,
            });
            if (translations && translations.length > 0) {
                await tx.subscriptionPackageTranslation.deleteMany({
                    where: {
                        subscription_package_id: BigInt(id),
                    },
                });
                await tx.subscriptionPackageTranslation.createMany({
                    data: translations.map((translation) => ({
                        subscription_package_id: BigInt(id),
                        locale: translation.locale,
                        name: translation.name,
                        detail: translation.detail,
                    })),
                });
            }
        });
        return this.findById(id);
    }
    async delete(id) {
        const existingPackage = await prisma.subscriptionPackage.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingPackage)
            return false;
        await prisma.subscriptionPackage.delete({
            where: {
                id: BigInt(id),
            },
        });
        return true;
    }
    async publish(id) {
        const existingPackage = await prisma.subscriptionPackage.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingPackage)
            return null;
        const pkg = await prisma.subscriptionPackage.update({
            where: {
                id: BigInt(id),
            },
            data: {
                publish: true,
            },
            include: {
                translations: true,
            },
        });
        return mapPackage(pkg);
    }
    async unpublish(id) {
        const existingPackage = await prisma.subscriptionPackage.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingPackage)
            return null;
        const pkg = await prisma.subscriptionPackage.update({
            where: {
                id: BigInt(id),
            },
            data: {
                publish: false,
            },
            include: {
                translations: true,
            },
        });
        return mapPackage(pkg);
    }
    async getTotalPackagesCount() {
        return prisma.subscriptionPackage.count();
    }
    async getNewPackagesCount(days = 30) {
        const date = new Date();
        date.setDate(date.getDate() - days);
        return prisma.subscriptionPackage.count({
            where: {
                created_at: {
                    gte: date,
                },
            },
        });
    }
}
