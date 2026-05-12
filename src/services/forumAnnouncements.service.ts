import { AnnouncementRepository } from "../repositories/forum/announcement.repository.js";
import type { ForumAnnouncement, ForumAnnouncementLocale, ForumAnnouncementRecord } from "../types/ForumAnnouncement.js";

export class ForumAnnouncementsService {
    constructor(private readonly announcementRepository: AnnouncementRepository) { }

    createAnnouncement = async (dto: ForumAnnouncement): Promise<{
        id: number;
        translations: { id: number }[];
    }> => {
        return this.announcementRepository.create(dto);
    };

    findAll = async (locale: ForumAnnouncementLocale): Promise<ForumAnnouncementRecord[]> => {
        return this.announcementRepository.findAll(locale);
    };

    findById = async (id: string | number, locale?: ForumAnnouncementLocale): Promise<ForumAnnouncementRecord | null> => {
        return this.announcementRepository.findById(id, locale);
    };

    updateAnnouncement = async (
        id: string | number,
        dto: ForumAnnouncement,
        locale?: ForumAnnouncementLocale,
    ): Promise<ForumAnnouncementRecord | null> => {
        return this.announcementRepository.update(id, dto, locale);
    };

    deleteAnnouncement = async (id: string | number): Promise<boolean> => {
        return this.announcementRepository.delete(id);
    };
}
