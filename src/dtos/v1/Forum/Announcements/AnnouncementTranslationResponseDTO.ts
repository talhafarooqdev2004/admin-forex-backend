import type { AnnouncementTranslationRecord } from "../../../../types/ForumAnnouncement.js";

export class AnnouncementTranslationResponseDTO {
    readonly id: number;
    readonly locale: AnnouncementTranslationRecord["locale"];
    readonly title: string;
    readonly description: string;
    readonly tags: string[] | null;

    constructor(
        id: number,
        locale: AnnouncementTranslationRecord["locale"],
        title: string,
        description: string,
        tags: string[] | null,
    ) {
        this.id = id;
        this.locale = locale;
        this.title = title;
        this.description = description;
        this.tags = tags;
    }

    static fromModel(translation: AnnouncementTranslationRecord): AnnouncementTranslationResponseDTO {
        return new this(
            translation.id,
            translation.locale,
            translation.title,
            translation.description,
            translation.tags,
        );
    }
}
