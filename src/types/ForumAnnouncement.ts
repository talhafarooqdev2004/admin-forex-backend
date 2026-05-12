export const FORUM_ANNOUNCEMENT_LOCALES = ['en', 'ru', 'de', 'fr', 'zh'] as const;

export type ForumAnnouncementLocale = typeof FORUM_ANNOUNCEMENT_LOCALES[number];

export interface ForumAnnouncement {
    active: boolean;
    translations: AnnouncementTranslationProps[];
}

export type AnnouncementTranslationProps = {
    locale: ForumAnnouncementLocale;
    title: string;
    description: string;
    tags: string[];
};

export type AnnouncementTranslationRecord = {
    id: number;
    locale: ForumAnnouncementLocale;
    title: string;
    description: string;
    tags: string[] | null;
};

export type ForumAnnouncementRecord = {
    id: number;
    active: boolean;
    translation: AnnouncementTranslationRecord | null;
    translations: AnnouncementTranslationRecord[];
    createdAt: Date;
    updatedAt: Date;
};
