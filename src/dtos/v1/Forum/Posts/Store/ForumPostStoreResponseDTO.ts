export class ForumPostStoreResponseDTO {
    readonly id: number;

    constructor(id: number) {
        this.id = id;
    }

    static fromModel(post: { id: number }) {
        return new this(post.id);
    }
}
