import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
const mapContent = (content) => serializePrisma(content);
export class PageContentRepository {
    async findByPageIdentifier(pageIdentifier) {
        const contents = await prisma.pageContent.findMany({
            where: { page_identifier: pageIdentifier },
            include: {
                translations: true,
            },
        });
        return contents.map(mapContent);
    }
    async findById(id) {
        const content = await prisma.pageContent.findUnique({
            where: {
                id: BigInt(id),
            },
            include: {
                translations: true,
            },
        });
        return mapContent(content);
    }
    async findByPageIdentifierAndSectionKey(pageIdentifier, sectionKey) {
        if (!sectionKey) {
            throw new Error('sectionKey is required');
        }
        const content = await prisma.pageContent.findFirst({
            where: {
                page_identifier: pageIdentifier,
                section_key: sectionKey,
            },
            include: {
                translations: true,
            },
        });
        return mapContent(content);
    }
    async update(id, contentData) {
        const existingContent = await prisma.pageContent.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingContent)
            return null;
        const translations = contentData.translations;
        delete contentData.translations;
        await prisma.$transaction(async (tx) => {
            if (Object.keys(contentData).length > 0) {
                await tx.pageContent.update({
                    where: {
                        id: BigInt(id),
                    },
                    data: contentData,
                });
            }
            if (translations && typeof translations === 'object') {
                await tx.pageContentTranslation.deleteMany({
                    where: {
                        page_content_id: BigInt(id),
                    },
                });
                const translationData = Object.entries(translations).map(([locale, contentValue]) => ({
                    page_content_id: BigInt(id),
                    locale,
                    content_value: typeof contentValue === 'string'
                        ? contentValue
                        : contentValue?.content_value || contentValue?.contentValue || '',
                }));
                if (translationData.length > 0) {
                    await tx.pageContentTranslation.createMany({
                        data: translationData,
                    });
                }
            }
        });
        return this.findById(id);
    }
}
