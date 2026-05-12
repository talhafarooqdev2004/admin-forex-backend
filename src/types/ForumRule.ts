export const FORUM_RULE_LOCALES = ['en', 'ru', 'de', 'fr', 'zh'] as const;

export type ForumRuleLocale = typeof FORUM_RULE_LOCALES[number];

export interface ForumRule {
    active: boolean;
    translations: RuleTranslationProps[];
}

export type RuleTranslationProps = {
    locale: ForumRuleLocale;
    title: string;
    description: string;
    tags: string[];
};

export type RuleTranslationRecord = {
    id: number;
    locale: ForumRuleLocale;
    title: string;
    description: string;
    tags: string[] | null;
};

export type ForumRuleRecord = {
    id: number;
    active: boolean;
    translation: RuleTranslationRecord | null;
    translations: RuleTranslationRecord[];
};
