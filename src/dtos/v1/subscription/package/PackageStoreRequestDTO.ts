export class PackageStoreRequestDTO {
    constructor(data) {
        this.price = data.price;
        this.durationHours = data.durationHours;
        this.freeTrialHours = data.freeTrailHours || data.freeTrialHours || null;
        this.additionalDiscounts = data.additionalDiscounts || null;
        this.campaigns = data.campaigns || null;
        this.translations = data.translations || [];
    }
    toPersistence() {
        const data = {
            price: this.price === '' ? undefined : this.price,
            duration_hours: this.durationHours === '' ? undefined : this.durationHours,
            free_trial_hours: this.freeTrialHours === '' || this.freeTrialHours === null ? null : this.freeTrialHours,
        };
        if (this.additionalDiscounts !== null && this.additionalDiscounts !== undefined) {
            data.additional_discounts = this.additionalDiscounts;
        }
        if (this.campaigns !== null && this.campaigns !== undefined) {
            data.campaigns = this.campaigns;
        }
        return data;
    }
    getTranslations() {
        return this.translations;
    }
}
