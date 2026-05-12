import type { AnnouncementTranslationProps } from "../../../../types/ForumAnnouncement.js";

export class AnnouncementTranslationDTO {
    readonly locale: AnnouncementTranslationProps["locale"];
    readonly title: string;
    readonly description: string;
    readonly tags: string[];

    constructor(
        locale: AnnouncementTranslationProps["locale"],
        title: string,
        description: string,
        tags: string[],
    ) {
        this.locale = locale;
        this.title = title;
        this.description = description;
        this.tags = tags;
    }

    toJSON(): AnnouncementTranslationProps {
        return {
            locale: this.locale,
            title: this.title,
            description: this.description,
            tags: this.tags,
        };
    }
}
