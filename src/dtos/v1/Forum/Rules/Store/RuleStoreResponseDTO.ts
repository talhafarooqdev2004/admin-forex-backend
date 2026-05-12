export class RuleStoreResponseDTO {
    readonly id: number;
    readonly translations: number[];

    constructor(id: number, translations: number[]) {
        this.id = id;
        this.translations = translations;
    }

    static fromModel(rule: {
        id: number,
        translations: { id: number }[],
    }) {
        return new this(
            rule.id,
            rule.translations.map(t => t.id)
        );
    }
};