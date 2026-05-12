import type { ForumRuleLocale } from "../../../../types/ForumRule.js";

export class RuleTranslationDTO {
    readonly locale: ForumRuleLocale;
    readonly title: string;
    readonly description: string;
    readonly tags: string[];

    constructor(
        locale: ForumRuleLocale,
        title: string,
        description: string,
        tags: string[],
    ) {
        this.locale = locale;
        this.title = title;
        this.description = description;
        this.tags = tags;
    }

    toJSON(): {
        locale: ForumRuleLocale,
        title: string,
        description: string,
        tags: string[],
    } {
        return {
            locale: this.locale,
            title: this.title,
            description: this.description,
            tags: this.tags,
        };
    }
};
