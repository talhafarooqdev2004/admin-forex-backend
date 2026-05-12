import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import type {
    AnnouncementTranslationProps,
    AnnouncementTranslationRecord,
    ForumAnnouncement,
    ForumAnnouncementLocale,
    ForumAnnouncementRecord,
} from "../../types/ForumAnnouncement.js";
import { serializePrisma } from "../../utils/prisma.util.js";

type AnnouncementCreateResult = {
    id: number;
    translations: { id: number }[];
};

type PrismaAnnouncementTranslation = {
    id: number;
    locale: ForumAnnouncementLocale;
    title: string;
    description: string;
    tags: unknown;
};

type PrismaForumAnnouncement = {
    id: number;
    active: boolean;
    created_at: Date;
    updated_at: Date;
    translations?: PrismaAnnouncementTranslation[];
};

const normalizeTags = (tags: unknown): string[] | null => {
    if (Array.isArray(tags)) {
        return tags.filter((tag): tag is string => typeof tag === "string");
    }

    return null;
};

const mapTranslation = (translation: PrismaAnnouncementTranslation) => {
    const serialized = serializePrisma(translation) as PrismaAnnouncementTranslation;

    return {
        id: Number(serialized.id),
        locale: serialized.locale,
        title: serialized.title,
        description: serialized.description,
        tags: normalizeTags(serialized.tags),
    };
};

const mapAnnouncement = (announcement: PrismaForumAnnouncement | null): ForumAnnouncementRecord | null => {
    const serialized = serializePrisma(announcement) as PrismaForumAnnouncement | null;

    if (!serialized) {
        return null;
    }

    const translations = (serialized.translations ?? []).map((translation) => mapTranslation(translation)) as AnnouncementTranslationRecord[];

    return {
        id: Number(serialized.id),
        active: serialized.active,
        translation: translations[0] ?? null,
        translations,
        createdAt: serialized.created_at,
        updatedAt: serialized.updated_at,
    };
};

export class AnnouncementRepository {
    create = async (dto: ForumAnnouncement): Promise<AnnouncementCreateResult> => {
        return prisma.forumAnnouncement.create({
            data: {
                active: dto.active,
                translations: {
                    create: dto.translations.map((translation: AnnouncementTranslationProps) => ({
                        locale: translation.locale,
                        title: translation.title,
                        description: translation.description,
                        tags: translation.tags,
                    })),
                },
            },
            select: {
                id: true,
                translations: {
                    select: { id: true },
                },
            },
        });
    };

    findAll = async (locale: ForumAnnouncementLocale = "en"): Promise<ForumAnnouncementRecord[]> => {
        const announcements = await prisma.forumAnnouncement.findMany({
            include: {
                translations: {
                    where: { locale },
                    take: 1,
                },
            },
            orderBy: {
                created_at: "desc",
            },
        });

        return announcements
            .map((announcement: PrismaForumAnnouncement) => mapAnnouncement(announcement))
            .filter((announcement): announcement is ForumAnnouncementRecord => announcement !== null);
    };

    findById = async (id: string | number, locale?: ForumAnnouncementLocale): Promise<ForumAnnouncementRecord | null> => {
        const announcement = await prisma.forumAnnouncement.findUnique({
            where: {
                id: Number(id),
            },
            include: {
                translations: locale
                    ? {
                        where: { locale },
                        take: 1,
                    }
                    : true,
            },
        });

        return mapAnnouncement(announcement as PrismaForumAnnouncement | null);
    };

    update = async (
        id: string | number,
        dto: ForumAnnouncement,
        locale?: ForumAnnouncementLocale,
    ): Promise<ForumAnnouncementRecord | null> => {
        const existingAnnouncement = await prisma.forumAnnouncement.findUnique({
            where: {
                id: Number(id),
            },
            select: {
                id: true,
            },
        });

        if (!existingAnnouncement) {
            return null;
        }

        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.forumAnnouncement.update({
                where: {
                    id: Number(id),
                },
                data: {
                    active: dto.active,
                },
            });

            await tx.forumAnnouncementsTranslation.deleteMany({
                where: {
                    forum_announcements_id: Number(id),
                },
            });

            await tx.forumAnnouncementsTranslation.createMany({
                data: dto.translations.map((translation: AnnouncementTranslationProps) => ({
                    forum_announcements_id: Number(id),
                    locale: translation.locale,
                    title: translation.title,
                    description: translation.description,
                    tags: translation.tags,
                })),
            });
        });

        return this.findById(id, locale);
    };

    delete = async (id: string | number): Promise<boolean> => {
        const existingAnnouncement = await prisma.forumAnnouncement.findUnique({
            where: {
                id: Number(id),
            },
            select: {
                id: true,
            },
        });

        if (!existingAnnouncement) {
            return false;
        }

        await prisma.forumAnnouncement.delete({
            where: {
                id: Number(id),
            },
        });

        return true;
    };
}
