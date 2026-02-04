import { DataTypes, Model } from 'sequelize';

export default class SubscriptionPackage extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            price: {
                type: DataTypes.DECIMAL(8, 2),
                allowNull: false,
            },
            duration_hours: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            free_trial_hours: {
                type: DataTypes.INTEGER,
                allowNull: true,
            },
            additional_discounts: {
                type: DataTypes.JSON,
                allowNull: true,
            },
            campaigns: {
                type: DataTypes.JSON,
                allowNull: true,
            },
            publish: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
        }, {
            sequelize,
            tableName: 'subscription_packages',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            hooks: {
                beforeCreate: (pkg, options) => {
                    // Convert string numbers to actual numbers (Sequelize accepts both)
                    if (typeof pkg.price === 'string' && pkg.price !== '') {
                        pkg.price = parseFloat(pkg.price);
                    }
                    if (typeof pkg.duration_hours === 'string' && pkg.duration_hours !== '') {
                        pkg.duration_hours = parseInt(pkg.duration_hours, 10);
                    }
                    if (typeof pkg.free_trial_hours === 'string') {
                        pkg.free_trial_hours = pkg.free_trial_hours === '' ? null : parseInt(pkg.free_trial_hours, 10);
                    }
                },
                beforeUpdate: (pkg, options) => {
                    // Convert string numbers to actual numbers (Sequelize accepts both)
                    if (typeof pkg.price === 'string' && pkg.price !== '') {
                        pkg.price = parseFloat(pkg.price);
                    }
                    if (typeof pkg.duration_hours === 'string' && pkg.duration_hours !== '') {
                        pkg.duration_hours = parseInt(pkg.duration_hours, 10);
                    }
                    if (typeof pkg.free_trial_hours === 'string') {
                        pkg.free_trial_hours = pkg.free_trial_hours === '' ? null : parseInt(pkg.free_trial_hours, 10);
                    }
                },
            },
        });
    }

    static associate(models) {
        this.hasMany(models.SubscriptionPackageTranslation, {
            as: 'translations',
            foreignKey: 'subscription_package_id',
        });
        this.hasOne(models.SubscriptionPackageTranslation, {
            as: 'translation',
            foreignKey: 'subscription_package_id',
        });
        this.hasMany(models.UserSubscription, {
            as: 'subscriptions',
            foreignKey: 'subscription_package_id',
        });
    }

    toJSON() {
        const values = this.get({ plain: true });
        
        // Convert snake_case to camelCase for API response
        const transformed = {
            id: values.id,
            price: values.price,
            durationHours: values.duration_hours ?? null,
            freeTrailHours: values.free_trial_hours ?? null,
            additionalDiscounts: values.additional_discounts ?? null,
            campaigns: values.campaigns ?? null,
            published: values.publish ?? false,
            created_at: values.created_at,
            updated_at: values.updated_at,
        };

        // Include relations if they exist (they will be serialized by Sequelize)
        if (values.translation) {
            transformed.translation = values.translation;
        }
        if (values.translations) {
            transformed.translations = values.translations;
        }

        return transformed;
    }
}
