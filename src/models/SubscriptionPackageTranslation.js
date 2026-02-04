import { DataTypes, Model } from 'sequelize';

export default class SubscriptionPackageTranslation extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            subscription_package_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                references: {
                    model: 'subscription_packages',
                    key: 'id'
                },
                onDelete: 'CASCADE'
            },
            locale: {
                type: DataTypes.STRING(5),
                allowNull: false,
            },
            name: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            detail: {
                type: DataTypes.TEXT,
                allowNull: false,
            },
        }, {
            sequelize,
            tableName: 'subscription_package_translations',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    unique: true,
                    fields: ['subscription_package_id', 'locale'],
                    name: 'unique_subscription_package_locale'
                }
            ]
        });
    }

    static associate(models) {
        this.belongsTo(models.SubscriptionPackage, {
            as: 'package',
            foreignKey: 'subscription_package_id',
        });
    }
}
