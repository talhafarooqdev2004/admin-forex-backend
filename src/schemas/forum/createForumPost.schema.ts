import { z } from "zod";
import { FORUM_POST_CATEGORIES } from "../../types/ForumPost.js";

const ForumPostQuerySchema = z.object({
    category: z.enum(FORUM_POST_CATEGORIES).optional(),
});

const CreateForumPostSchema = z.object({
    active: z.boolean(),
    category: z.enum(FORUM_POST_CATEGORIES),
    title: z.string().min(3).max(120),
    content: z.string().default(""),
    imagePath: z.string().min(1).max(2048).nullable().optional(),
    tags: z.array(z.string()),
});

const CreateForumPostReplySchema = z.object({
    message: z.string().min(1).max(2000),
});

type CreateForumPostInput = z.infer<typeof CreateForumPostSchema>;
type CreateForumPostReplyInput = z.infer<typeof CreateForumPostReplySchema>;
type ForumPostQueryInput = z.infer<typeof ForumPostQuerySchema>;

export { CreateForumPostSchema, CreateForumPostReplySchema, ForumPostQuerySchema };
export type { CreateForumPostInput, CreateForumPostReplyInput, ForumPostQueryInput };
