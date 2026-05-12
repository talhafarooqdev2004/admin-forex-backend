import type { ForumAnnouncementRecord } from "../../../../types/ForumAnnouncement.js";
import { AnnouncementTranslationResponseDTO } from "./AnnouncementTranslationResponseDTO.js";

export class AnnouncementResponseDTO {
    readonly id: number;
    readonly active: boolean;
    readonly translation: AnnouncementTranslationResponseDTO | null;
    readonly translations: AnnouncementTranslationResponseDTO[];
    readonly createdAt: Date;
    readonly updatedAt: Date;

    constructor(
        id: number,
        active: boolean,
        translation: AnnouncementTranslationResponseDTO | null,
        translations: AnnouncementTranslationResponseDTO[],
        createdAt: Date,
        updatedAt: Date,
    ) {
        this.id = id;
        this.active = active;
        this.translation = translation;
        this.translations = translations;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    static fromModel(announcement: ForumAnnouncementRecord): AnnouncementResponseDTO {
        const translations = announcement.translations.map((translation) => AnnouncementTranslationResponseDTO.fromModel(translation));

        return new this(
            announcement.id,
            announcement.active,
            announcement.translation ? AnnouncementTranslationResponseDTO.fromModel(announcement.translation) : null,
            translations,
            announcement.createdAt,
            announcement.updatedAt,
        );
    }
}
