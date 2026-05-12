import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import type { ForumRule, ForumRuleLocale, ForumRuleRecord, RuleTranslationProps, RuleTranslationRecord } from "../../types/ForumRule.js";
import { serializePrisma } from "../../utils/prisma.util.js";

type RuleCreateResult = {
    id: number;
    translations: { id: number }[];
};

type PrismaRuleTranslation = {
    id: number;
    locale: ForumRuleLocale;
    title: string;
    description: string;
    tags: unknown;
};

type PrismaForumRule = {
    id: number;
    active: boolean;
    translations?: PrismaRuleTranslation[];
};

const normalizeTags = (tags: unknown): string[] | null => {
    if (Array.isArray(tags)) {
        return tags.filter((tag): tag is string => typeof tag === "string");
    }

    return null;
};

const mapTranslation = (translation: PrismaRuleTranslation) => {
    const serialized = serializePrisma(translation) as PrismaRuleTranslation;

    return {
        id: Number(serialized.id),
        locale: serialized.locale,
        title: serialized.title,
        description: serialized.description,
        tags: normalizeTags(serialized.tags),
    };
};

const mapRule = (rule: PrismaForumRule | null): ForumRuleRecord | null => {
    const serialized = serializePrisma(rule) as PrismaForumRule | null;

    if (!serialized) {
        return null;
    }

    const translations = (serialized.translations ?? []).map((translation) => mapTranslation(translation)) as RuleTranslationRecord[];

    return {
        id: Number(serialized.id),
        active: serialized.active,
        translation: translations[0] ?? null,
        translations,
    };
};

export class RuleRepository {
    create = async (dto: ForumRule): Promise<RuleCreateResult> => {
        return prisma.forumRule.create({
            data: {
                active: dto.active,
                translations: {
                    create: dto.translations.map((t: RuleTranslationProps) => ({
                        locale: t.locale,
                        title: t.title,
                        description: t.description,
                        tags: t.tags,
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

    findAll = async (locale: ForumRuleLocale = "en"): Promise<ForumRuleRecord[]> => {
        const rules = await prisma.forumRule.findMany({
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

        return rules
            .map((rule: PrismaForumRule) => mapRule(rule))
            .filter((rule): rule is ForumRuleRecord => rule !== null);
    };

    findById = async (id: string | number, locale?: ForumRuleLocale): Promise<ForumRuleRecord | null> => {
        const rule = await prisma.forumRule.findUnique({
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

        return mapRule(rule as PrismaForumRule | null);
    };

    update = async (
        id: string | number,
        dto: ForumRule,
        locale?: ForumRuleLocale,
    ): Promise<ForumRuleRecord | null> => {
        const existingRule = await prisma.forumRule.findUnique({
            where: {
                id: Number(id),
            },
            select: {
                id: true,
            },
        });

        if (!existingRule) {
            return null;
        }

        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.forumRule.update({
                where: {
                    id: Number(id),
                },
                data: {
                    active: dto.active,
                },
            });

            await tx.forumRulesTranslation.deleteMany({
                where: {
                    forum_rules_id: Number(id),
                },
            });

            await tx.forumRulesTranslation.createMany({
                data: dto.translations.map((translation: RuleTranslationProps) => ({
                    forum_rules_id: Number(id),
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
        const existingRule = await prisma.forumRule.findUnique({
            where: {
                id: Number(id),
            },
            select: {
                id: true,
            },
        });

        if (!existingRule) {
            return false;
        }

        await prisma.forumRule.delete({
            where: {
                id: Number(id),
            },
        });

        return true;
    };
}
