import type { ForumPostRecord } from "../../../../types/ForumPost.js";

class ForumPostReplyResponseDTO {
    readonly id: number;
    readonly authorName: string;
    readonly message: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;

    constructor(
        id: number,
        authorName: string,
        message: string,
        createdAt: Date,
        updatedAt: Date,
    ) {
        this.id = id;
        this.authorName = authorName;
        this.message = message;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    static fromModel(reply: ForumPostRecord["replies"][number]): ForumPostReplyResponseDTO {
        return new this(
            reply.id,
            reply.authorName,
            reply.message,
            reply.createdAt,
            reply.updatedAt,
        );
    }
}

export class ForumPostResponseDTO {
    readonly id: number;
    readonly active: boolean;
    readonly category: ForumPostRecord["category"];
    readonly authorName: string;
    readonly title: string;
    readonly content: string;
    readonly imagePath: string | null;
    readonly viewCount: number;
    readonly replyCount: number;
    readonly replies: ForumPostReplyResponseDTO[];
    readonly tags: string[] | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;

    constructor(
        id: number,
        active: boolean,
        category: ForumPostRecord["category"],
        authorName: string,
        title: string,
        content: string,
        imagePath: string | null,
        viewCount: number,
        replyCount: number,
        replies: ForumPostReplyResponseDTO[],
        tags: string[] | null,
        createdAt: Date,
        updatedAt: Date,
    ) {
        this.id = id;
        this.active = active;
        this.category = category;
        this.authorName = authorName;
        this.title = title;
        this.content = content;
        this.imagePath = imagePath;
        this.viewCount = viewCount;
        this.replyCount = replyCount;
        this.replies = replies;
        this.tags = tags;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    static fromModel(post: ForumPostRecord): ForumPostResponseDTO {
        return new this(
            post.id,
            post.active,
            post.category,
            post.authorName,
            post.title,
            post.content,
            post.imagePath,
            post.viewCount,
            post.replyCount,
            post.replies.map((reply) => ForumPostReplyResponseDTO.fromModel(reply)),
            post.tags,
            post.createdAt,
            post.updatedAt,
        );
    }
}
