export class AnnouncementStoreResponseDTO {
    readonly id: number;
    readonly translations: number[];

    constructor(id: number, translations: number[]) {
        this.id = id;
        this.translations = translations;
    }

    static fromModel(announcement: {
        id: number;
        translations: { id: number }[];
    }) {
        return new this(
            announcement.id,
            announcement.translations.map((translation) => translation.id),
        );
    }
}
