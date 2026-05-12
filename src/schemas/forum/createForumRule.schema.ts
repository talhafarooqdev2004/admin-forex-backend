import { z } from "zod";
import { FORUM_RULE_LOCALES } from "../../types/ForumRule.js";

const RuleTranslationSchema = z.array(
    z.object({
        locale: z.enum(FORUM_RULE_LOCALES),
        title: z.string().min(3).max(120),
        description: z.string().min(3),
        tags: z.array(z.string()),
    })
);

const CreateForumRuleSchema = z.object({
    active: z.boolean(),
    translations: RuleTranslationSchema.min(5),
});

const ForumRuleQuerySchema = z.object({
    locale: z.enum(FORUM_RULE_LOCALES).optional(),
});

type RuleTranslationInput = z.infer<typeof RuleTranslationSchema>[number];
type CreateForumRuleInput = z.infer<typeof CreateForumRuleSchema>;
type ForumRuleQueryInput = z.infer<typeof ForumRuleQuerySchema>;

export { CreateForumRuleSchema, ForumRuleQuerySchema, RuleTranslationSchema };
export type { CreateForumRuleInput, ForumRuleQueryInput, RuleTranslationInput };
