import { RuleRepository } from "../repositories/forum/rule.repository.js";
import type { ForumRule, ForumRuleLocale, ForumRuleRecord } from "../types/ForumRule.js";

export class ForumRulesService {
    constructor(private readonly ruleRepository: RuleRepository) { }

    createRule = async (dto: ForumRule): Promise<{
        id: number;
        translations: { id: number }[];
    }> => {
        return await this.ruleRepository.create(dto);
    };

    findAll = async (locale: ForumRuleLocale): Promise<ForumRuleRecord[]> => {
        return this.ruleRepository.findAll(locale);
    };

    findById = async (id: string | number, locale?: ForumRuleLocale): Promise<ForumRuleRecord | null> => {
        return this.ruleRepository.findById(id, locale);
    };

    updateRule = async (
        id: string | number,
        dto: ForumRule,
        locale?: ForumRuleLocale,
    ): Promise<ForumRuleRecord | null> => {
        return this.ruleRepository.update(id, dto, locale);
    };

    deleteRule = async (id: string | number): Promise<boolean> => {
        return this.ruleRepository.delete(id);
    };
}
