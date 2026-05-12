import express from "express";
import { ForumAnnouncementsController } from "../controllers/v1/forumAnnouncements.controller.js";
import { validate, validateQuery } from "../middlewares/validate.middleware.js";
import { CreateForumAnnouncementSchema, ForumAnnouncementQuerySchema } from "../schemas/forum/createForumAnnouncement.schema.js";
import { ForumAnnouncementsService } from "../services/forumAnnouncements.service.js";
import { AnnouncementRepository } from "../repositories/forum/announcement.repository.js";

const router = express.Router();

const repository = new AnnouncementRepository();
const service = new ForumAnnouncementsService(repository);
const forumAnnouncementsController = new ForumAnnouncementsController(service);

router.get('/', validateQuery(ForumAnnouncementQuerySchema), forumAnnouncementsController.index);
router.get('/:id', validateQuery(ForumAnnouncementQuerySchema), forumAnnouncementsController.show);
router.post('/create', validate(CreateForumAnnouncementSchema), forumAnnouncementsController.createAnnouncement);
router.put('/:id', validate(CreateForumAnnouncementSchema), forumAnnouncementsController.updateAnnouncement);
router.delete('/:id', forumAnnouncementsController.deleteAnnouncement);

export default router;
