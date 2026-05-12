import { prisma } from "../../lib/prisma.js";
import type {
    ForumPost,
    ForumPostCategory,
    ForumPostRecord,
    ForumPostReply,
    ForumPostReplyRecord,
} from "../../types/ForumPost.js";
import { serializePrisma } from "../../utils/prisma.util.js";

type PrismaForumPostReply = {
    id: number;
    author_name: string;
    message: string;
    created_at: Date;
    updated_at: Date;
};

type PrismaForumPost = {
    id: number;
    active: boolean;
    category: ForumPostCategory;
    author_name: string;
    title: string;
    content: string;
    image_path: string | null;
    view_count: number;
    tags: unknown;
    created_at: Date;
    updated_at: Date;
    replies?: PrismaForumPostReply[];
    _count?: {
        replies: number;
    };
};

const normalizeTags = (tags: unknown): string[] | null => {
    if (Array.isArray(tags)) {
        return tags.filter((tag): tag is string => typeof tag === "string");
    }

    return null;
};

const mapReply = (reply: PrismaForumPostReply): ForumPostReplyRecord => {
    const serialized = serializePrisma(reply) as PrismaForumPostReply;

    return {
        id: Number(serialized.id),
        authorName: serialized.author_name,
        message: serialized.message,
        createdAt: serialized.created_at,
        updatedAt: serialized.updated_at,
    };
};

const mapPost = (post: PrismaForumPost | null): ForumPostRecord | null => {
    const serialized = serializePrisma(post) as PrismaForumPost | null;

    if (!serialized) {
        return null;
    }

    return {
        id: Number(serialized.id),
        active: serialized.active,
        category: serialized.category,
        authorName: serialized.author_name,
        title: serialized.title,
        content: serialized.content,
        imagePath: serialized.image_path,
        viewCount: serialized.view_count,
        replyCount: serialized._count?.replies ?? serialized.replies?.length ?? 0,
        replies: (serialized.replies ?? []).map((reply) => mapReply(reply)),
        tags: normalizeTags(serialized.tags),
        createdAt: serialized.created_at,
        updatedAt: serialized.updated_at,
    };
};

const postInclude = {
    replies: {
        orderBy: {
            created_at: "asc" as const,
        },
    },
    _count: {
        select: {
            replies: true,
        },
    },
};

export class PostRepository {
    create = async (dto: ForumPost): Promise<{ id: number }> => {
        return prisma.forumPost.create({
            data: {
                active: dto.active,
                category: dto.category,
                title: dto.title,
                content: dto.content,
                image_path: dto.imagePath ?? null,
                tags: dto.tags,
            },
            select: {
                id: true,
            },
        });
    };

    findAll = async (category?: ForumPostCategory): Promise<ForumPostRecord[]> => {
        const posts = await prisma.forumPost.findMany({
            where: category ? { category } : undefined,
            include: postInclude,
            orderBy: {
                created_at: "desc",
            },
        });

        return posts
            .map((post) => mapPost(post as PrismaForumPost))
            .filter((post): post is ForumPostRecord => post !== null);
    };

    findById = async (id: string | number): Promise<ForumPostRecord | null> => {
        const post = await prisma.forumPost.findUnique({
            where: {
                id: Number(id),
            },
            include: postInclude,
        });

        return mapPost(post as PrismaForumPost | null);
    };

    update = async (id: string | number, dto: ForumPost): Promise<ForumPostRecord | null> => {
        const existingPost = await prisma.forumPost.findUnique({
            where: {
                id: Number(id),
            },
            select: {
                id: true,
            },
        });

        if (!existingPost) {
            return null;
        }

        await prisma.forumPost.update({
            where: {
                id: Number(id),
            },
            data: {
                active: dto.active,
                category: dto.category,
                title: dto.title,
                content: dto.content,
                image_path: dto.imagePath ?? null,
                tags: dto.tags,
            },
        });

        return this.findById(id);
    };

    addReply = async (postId: string | number, dto: ForumPostReply): Promise<ForumPostRecord | null> => {
        const existingPost = await prisma.forumPost.findUnique({
            where: {
                id: Number(postId),
            },
            select: {
                id: true,
            },
        });

        if (!existingPost) {
            return null;
        }

        await prisma.forumPostReply.create({
            data: {
                forum_post_id: Number(postId),
                message: dto.message,
            },
        });

        return this.findById(postId);
    };

    incrementViewCount = async (id: string | number): Promise<ForumPostRecord | null> => {
        const updatedPost = await prisma.forumPost.update({
            where: {
                id: Number(id),
            },
            data: {
                view_count: {
                    increment: 1,
                },
            },
            include: postInclude,
        }).catch(() => null);

        return mapPost(updatedPost as PrismaForumPost | null);
    };

    delete = async (id: string | number): Promise<boolean> => {
        const existingPost = await prisma.forumPost.findUnique({
            where: {
                id: Number(id),
            },
            select: {
                id: true,
            },
        });

        if (!existingPost) {
            return false;
        }

        await prisma.forumPost.delete({
            where: {
                id: Number(id),
            },
        });

        return true;
    };
}
