export const FORUM_POST_CATEGORIES = [
    "general-discussion",
    "technical-charts",
    "fundamental-discussion",
    "success-stories",
] as const;

export type ForumPostCategory = typeof FORUM_POST_CATEGORIES[number];

export interface ForumPost {
    active: boolean;
    category: ForumPostCategory;
    title: string;
    content: string;
    imagePath?: string | null;
    tags: string[];
}

export interface ForumPostReply {
    message: string;
}

export type ForumPostReplyRecord = {
    id: number;
    authorName: string;
    message: string;
    createdAt: Date;
    updatedAt: Date;
};

export type ForumPostRecord = {
    id: number;
    active: boolean;
    category: ForumPostCategory;
    authorName: string;
    title: string;
    content: string;
    imagePath: string | null;
    viewCount: number;
    replyCount: number;
    replies: ForumPostReplyRecord[];
    tags: string[] | null;
    createdAt: Date;
    updatedAt: Date;
};
