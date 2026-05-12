export class PackagePutRequestDTO {
    constructor(data) {
        this.price = data.price;
        this.durationHours = data.durationHours;
        this.freeTrialHours = data.freeTrailHours || data.freeTrialHours;
        this.additionalDiscounts = data.additionalDiscounts;
        this.campaigns = data.campaigns;
        this.translations = data.translations || [];
    }
    toPersistence() {
        const data = {};
        if (this.price !== undefined && this.price !== null && this.price !== '') {
            data.price = this.price;
        }
        if (this.durationHours !== undefined && this.durationHours !== null && this.durationHours !== '') {
            data.duration_hours = this.durationHours;
        }
        if (this.freeTrialHours !== undefined && this.freeTrialHours !== null) {
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
    getTranslations() {
        return this.translations;
    }
}
