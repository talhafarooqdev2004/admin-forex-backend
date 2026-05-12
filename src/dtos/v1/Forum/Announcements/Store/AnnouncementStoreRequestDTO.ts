import type { CreateForumAnnouncementInput } from "../../../../../schemas/forum/createForumAnnouncement.schema.js";
import type { ForumAnnouncement } from "../../../../../types/ForumAnnouncement.js";
import { AnnouncementTranslationDTO } from "../AnnouncementTranslationDTO.js";

export class AnnouncementStoreRequestDTO {
    readonly active: boolean;
    readonly translations: AnnouncementTranslationDTO[];

    constructor(
        active: boolean = true,
        translations: AnnouncementTranslationDTO[] = [],
    ) {
        this.active = active;
        this.translations = translations;
    }

    static toRequest({
        active,
        translations,
    }: CreateForumAnnouncementInput): AnnouncementStoreRequestDTO {
        const mappedTranslations = translations.map((translation) => new AnnouncementTranslationDTO(
            translation.locale,
            translation.title,
            translation.description,
            translation.tags,
        ));

        return new this(active, mappedTranslations);
    }

    toJSON(): ForumAnnouncement {
        return {
            active: this.active,
            translations: this.translations.map((translation) => translation.toJSON()),
        };
    }
}
