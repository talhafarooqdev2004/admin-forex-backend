import type { CreateForumRuleInput } from "../../../../../schemas/forum/createForumRule.schema.js";
import type { ForumRule } from "../../../../../types/ForumRule.js";
import { RuleTranslationDTO } from "../RuleTranslationDTO.js";

export class RuleStoreRequestDTO {
    readonly active: boolean;
    readonly translations: RuleTranslationDTO[];

    constructor(
        active: boolean = true,
        translations: RuleTranslationDTO[] = []
    ) {
        this.active = active;
        this.translations = translations;
    }

    static toRequest({
        active,
        translations,
    }: CreateForumRuleInput): RuleStoreRequestDTO {
        const mappedTranslations = translations.map(t => new RuleTranslationDTO(
            t.locale,
            t.title,
            t.description,
            t.tags,
        ));

        return new this(active, mappedTranslations);
    }

    toJSON(): ForumRule {
        return {
            active: this.active,
            translations: this.translations.map((translation) => translation.toJSON()),
        };
    }
}
