import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
const mapEducation = (education, locale) => {
    const serialized = serializePrisma(education);
    if (!serialized) {
        return serialized;
    }
    if (locale) {
        return {
            ...serialized,
            translation: serialized.translations?.[0] || null,
        };
    }
    return serialized;
};
export class EducationRepository {
    async findAll(locale = 'en') {
        const educations = await prisma.education.findMany({
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
        return educations.map((education) => mapEducation(education, locale));
    }
    async findById(id) {
        const education = await prisma.education.findUnique({
            where: {
                id: BigInt(id),
            },
            include: {
                translations: true,
            },
        });
        return mapEducation(education);
    }
    async create(educationData) {
        const translations = educationData.translations || [];
        delete educationData.translations;
        const education = await prisma.education.create({
            data: {
                ...educationData,
                translations: translations.length > 0
                    ? {
                        create: translations.map((translation) => ({
                            locale: translation.locale,
                            title: translation.title,
                            content: translation.content,
                        })),
                    }
                    : undefined,
            },
            include: {
                translations: true,
            },
        });
        return mapEducation(education);
    }
    async update(id, educationData) {
        const existingEducation = await prisma.education.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingEducation)
            return null;
        const translations = educationData.translations;
        delete educationData.translations;
        await prisma.$transaction(async (tx) => {
            if (Object.keys(educationData).length > 0) {
                await tx.education.update({
                    where: {
                        id: BigInt(id),
                    },
                    data: educationData,
                });
            }
            if (translations && translations.length > 0) {
                await tx.educationTranslation.deleteMany({
                    where: {
                        education_id: BigInt(id),
                    },
                });
                await tx.educationTranslation.createMany({
                    data: translations.map((translation) => ({
                        education_id: BigInt(id),
                        locale: translation.locale,
                        title: translation.title,
                        content: translation.content,
                    })),
                });
            }
        });
        return this.findById(id);
    }
    async delete(id) {
        const existingEducation = await prisma.education.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingEducation)
            return false;
        await prisma.education.delete({
            where: {
                id: BigInt(id),
            },
        });
        return true;
    }
    async publish(id) {
        const existingEducation = await prisma.education.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingEducation)
            return null;
        const education = await prisma.education.update({
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
        return mapEducation(education);
    }
    async unpublish(id) {
        const existingEducation = await prisma.education.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingEducation)
            return null;
        const education = await prisma.education.update({
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
        return mapEducation(education);
    }
}
