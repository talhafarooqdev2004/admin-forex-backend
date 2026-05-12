import type { ForumRuleRecord } from "../../../../types/ForumRule.js";
import { RuleTranslationResponseDTO } from "./RuleTranslationResponseDTO.js";

export class RuleResponseDTO {
    readonly id: number;
    readonly active: boolean;
    readonly translation: RuleTranslationResponseDTO | null;
    readonly translations: RuleTranslationResponseDTO[];

    constructor(
        id: number,
        active: boolean,
        translation: RuleTranslationResponseDTO | null,
        translations: RuleTranslationResponseDTO[],
    ) {
        this.id = id;
        this.active = active;
        this.translation = translation;
        this.translations = translations;
    }

    static fromModel(rule: ForumRuleRecord): RuleResponseDTO {
        const translations = rule.translations.map((translation) => RuleTranslationResponseDTO.fromModel(translation));

        return new this(
            rule.id,
            rule.active,
            rule.translation ? RuleTranslationResponseDTO.fromModel(rule.translation) : null,
            translations,
        );
    }
}
