import express from "express";
import { ForumPostsController } from "../controllers/v1/forumPosts.controller.js";
import { forumPostImageUpload } from "../middlewares/upload.middleware.js";
import { validate, validateQuery } from "../middlewares/validate.middleware.js";
import {
    CreateForumPostReplySchema,
    CreateForumPostSchema,
    ForumPostQuerySchema,
} from "../schemas/forum/createForumPost.schema.js";
import { ForumPostsService } from "../services/forumPosts.service.js";
import { PostRepository } from "../repositories/forum/post.repository.js";

const router = express.Router();

const repository = new PostRepository();
const service = new ForumPostsService(repository);
const forumPostsController = new ForumPostsController(service);

router.get("/", validateQuery(ForumPostQuerySchema), forumPostsController.index);
router.get("/:id", forumPostsController.show);
router.post("/upload-image", forumPostImageUpload.single("image"), forumPostsController.uploadImage);
router.post("/create", validate(CreateForumPostSchema), forumPostsController.createPost);
router.post("/:id/replies", validate(CreateForumPostReplySchema), forumPostsController.addReply);
router.post("/:id/views", forumPostsController.incrementViewCount);
router.put("/:id", validate(CreateForumPostSchema), forumPostsController.updatePost);
router.delete("/:id", forumPostsController.deletePost);

export default router;
