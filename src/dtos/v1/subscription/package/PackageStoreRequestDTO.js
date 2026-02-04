/**
 * DTO for creating a package
 * Converts camelCase from frontend to snake_case for Sequelize
 */
export class PackageStoreRequestDTO {
    constructor(data) {
        this.price = data.price;
        this.durationHours = data.durationHours;
        this.freeTrialHours = data.freeTrailHours || data.freeTrialHours || null;
        this.additionalDiscounts = data.additionalDiscounts || null;
        this.campaigns = data.campaigns || null;
        this.translations = data.translations || [];
    }

    /**
     * Convert to Sequelize format (snake_case)
     * @returns {Object} Data in snake_case format for Sequelize
     */
    toSequelize() {
        const data = {
            price: this.price === '' ? undefined : this.price,
            duration_hours: this.durationHours === '' ? undefined : this.durationHours,
            free_trial_hours: this.freeTrialHours === '' || this.freeTrialHours === null ? null : this.freeTrialHours,
        };

        // Only include optional fields if they have values
        if (this.additionalDiscounts !== null && this.additionalDiscounts !== undefined) {
            data.additional_discounts = this.additionalDiscounts;
        }

        if (this.campaigns !== null && this.campaigns !== undefined) {
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
