/**
 * DTO for updating a package
 * Converts camelCase from frontend to snake_case for Sequelize
 */
export class PackagePutRequestDTO {
    constructor(data) {
        this.price = data.price;
        this.durationHours = data.durationHours;
        this.freeTrialHours = data.freeTrailHours || data.freeTrialHours;
        this.additionalDiscounts = data.additionalDiscounts;
        this.campaigns = data.campaigns;
        this.translations = data.translations || [];
    }

    /**
     * Convert to Sequelize format (snake_case)
     * Only includes fields that are not null/undefined
     * @returns {Object} Data in snake_case format for Sequelize
     */
    toSequelize() {
        const data = {};

        if (this.price !== undefined && this.price !== null && this.price !== '') {
            data.price = this.price;
        }

        if (this.durationHours !== undefined && this.durationHours !== null && this.durationHours !== '') {
            data.duration_hours = this.durationHours;
        }

        if (this.freeTrialHours !== undefined && this.freeTrialHours !== null) {
            // Allow empty string to set to null
            data.free_trial_hours = this.freeTrialHours === '' ? null : this.freeTrialHours;
        }

        if (this.additionalDiscounts !== undefined && this.additionalDiscounts !== null) {
            data.additional_discounts = this.additionalDiscounts;
        }

        if (this.campaigns !== undefined && this.campaigns !== null) {
            data.campaigns = this.campaigns;
        }

        return data;
    }

    /**
     * Get translations array
     * @returns {Array} Translations array
     */
    getTranslations() {
        return this.translations;
    }
}
