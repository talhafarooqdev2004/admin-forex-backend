import { z } from "zod";
import { FORUM_ANNOUNCEMENT_LOCALES } from "../../types/ForumAnnouncement.js";

const AnnouncementTranslationSchema = z.array(
    z.object({
        locale: z.enum(FORUM_ANNOUNCEMENT_LOCALES),
        title: z.string().min(3).max(120),
        description: z.string().min(3),
        tags: z.array(z.string()),
    })
);

const CreateForumAnnouncementSchema = z.object({
    active: z.boolean(),
    translations: AnnouncementTranslationSchema.min(5),
});

const ForumAnnouncementQuerySchema = z.object({
    locale: z.enum(FORUM_ANNOUNCEMENT_LOCALES).optional(),
});

type AnnouncementTranslationInput = z.infer<typeof AnnouncementTranslationSchema>[number];
type CreateForumAnnouncementInput = z.infer<typeof CreateForumAnnouncementSchema>;
type ForumAnnouncementQueryInput = z.infer<typeof ForumAnnouncementQuerySchema>;

export { CreateForumAnnouncementSchema, ForumAnnouncementQuerySchema, AnnouncementTranslationSchema };
export type { AnnouncementTranslationInput, CreateForumAnnouncementInput, ForumAnnouncementQueryInput };
