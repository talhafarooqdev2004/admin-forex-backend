import { PostRepository } from "../repositories/forum/post.repository.js";
import type { ForumPost, ForumPostCategory, ForumPostRecord, ForumPostReply } from "../types/ForumPost.js";

export class ForumPostsService {
    constructor(private readonly postRepository: PostRepository) { }

    createPost = async (dto: ForumPost): Promise<{ id: number }> => {
        return this.postRepository.create(dto);
    };

    findAll = async (category?: ForumPostCategory): Promise<ForumPostRecord[]> => {
        return this.postRepository.findAll(category);
    };

    findById = async (id: string | number): Promise<ForumPostRecord | null> => {
        return this.postRepository.findById(id);
    };

    updatePost = async (id: string | number, dto: ForumPost): Promise<ForumPostRecord | null> => {
        return this.postRepository.update(id, dto);
    };

    addReply = async (postId: string | number, dto: ForumPostReply): Promise<ForumPostRecord | null> => {
        return this.postRepository.addReply(postId, dto);
    };

    incrementViewCount = async (id: string | number): Promise<ForumPostRecord | null> => {
        return this.postRepository.incrementViewCount(id);
    };

    deletePost = async (id: string | number): Promise<boolean> => {
        return this.postRepository.delete(id);
    };
}
