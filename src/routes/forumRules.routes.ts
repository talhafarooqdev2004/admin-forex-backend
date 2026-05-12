import express from "express";
import { ForumRulesController } from "../controllers/v1/forumRules.controller.js";
import { validate, validateQuery } from "../middlewares/validate.middleware.js";
import { CreateForumRuleSchema, ForumRuleQuerySchema } from "../schemas/forum/createForumRule.schema.js";
import { ForumRulesService } from "../services/forumRules.service.js";
import { RuleRepository } from "../repositories/forum/rule.repository.js";

const router = express.Router();

const repository = new RuleRepository();
const service = new ForumRulesService(repository);
const forumRulesController = new ForumRulesController(service);

router.get('/', validateQuery(ForumRuleQuerySchema), forumRulesController.index);
router.get('/:id', validateQuery(ForumRuleQuerySchema), forumRulesController.show);
router.post('/create', validate(CreateForumRuleSchema), forumRulesController.createRule);
router.put('/:id', validate(CreateForumRuleSchema), forumRulesController.updateRule);
router.delete('/:id', forumRulesController.deleteRule);

export default router;
