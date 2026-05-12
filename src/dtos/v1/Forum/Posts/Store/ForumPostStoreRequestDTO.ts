import type { CreateForumPostInput } from "../../../../../schemas/forum/createForumPost.schema.js";
import type { ForumPost } from "../../../../../types/ForumPost.js";

export class ForumPostStoreRequestDTO {
    readonly active: boolean;
    readonly category: ForumPost["category"];
    readonly title: string;
    readonly content: string;
    readonly imagePath: string | null;
    readonly tags: string[];

    constructor(
        active: boolean,
        category: ForumPost["category"],
        title: string,
        content: string,
        imagePath: string | null,
        tags: string[],
    ) {
        this.active = active;
        this.category = category;
        this.title = title;
        this.content = content;
        this.imagePath = imagePath;
        this.tags = tags;
    }

    static toRequest({
        active,
        category,
        title,
        content,
        imagePath,
        tags,
    }: CreateForumPostInput): ForumPostStoreRequestDTO {
        return new this(active, category, title, content, imagePath ?? null, tags);
    }

    toJSON(): ForumPost {
        return {
            active: this.active,
            category: this.category,
            title: this.title,
            content: this.content,
            imagePath: this.imagePath,
            tags: this.tags,
        };
    }
}
