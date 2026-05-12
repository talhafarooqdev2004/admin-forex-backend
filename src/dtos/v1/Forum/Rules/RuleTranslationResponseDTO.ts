import type { ForumRuleLocale, RuleTranslationRecord } from "../../../../types/ForumRule.js";

export class RuleTranslationResponseDTO {
    readonly id: number;
    readonly locale: ForumRuleLocale;
    readonly title: string;
    readonly description: string;
    readonly tags: string[] | null;

    constructor(
        id: number,
        locale: ForumRuleLocale,
        title: string,
        description: string,
        tags: string[] | null,
    ) {
        this.id = id;
        this.locale = locale;
        this.title = title;
        this.description = description;
        this.tags = tags;
    }

    static fromModel(translation: RuleTranslationRecord): RuleTranslationResponseDTO {
        return new this(
            translation.id,
            translation.locale,
            translation.title,
            translation.description,
            translation.tags,
        );
    }
}
