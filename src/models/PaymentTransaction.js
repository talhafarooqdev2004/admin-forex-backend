import { DataTypes, Model } from 'sequelize';

export default class PaymentTransaction extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            user_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                references: {
                    model: 'users',
                    key: 'id'
                },
                onDelete: 'CASCADE'
            },
            package_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                references: {
                    model: 'subscription_packages',
                    key: 'id'
                },
                onDelete: 'CASCADE'
            },
            payment_gateway_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                references: {
                    model: 'payment_gateways',
                    key: 'id'
                },
                onDelete: 'CASCADE'
            },
            transaction_id: {
                type: DataTypes.STRING(255),
                allowNull: false,
                unique: true,
            },
            amount: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: false,
            },
            currency: {
                type: DataTypes.STRING(3),
                allowNull: false,
                defaultValue: 'USD',
            },
            status: {
                type: DataTypes.ENUM('pending', 'completed', 'failed', 'refunded', 'cancelled'),
                allowNull: false,
                defaultValue: 'pending',
            },
            gateway_response: {
                type: DataTypes.JSON,
                allowNull: true,
            },
            failure_reason: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            completed_at: {
                type: DataTypes.DATE,
                allowNull: true,
            },
        }, {
            sequelize,
            tableName: 'payment_transactions',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    fields: ['user_id']
                },
                {
                    fields: ['package_id']
                },
                {
                    fields: ['payment_gateway_id']
                },
                {
                    fields: ['status']
                },
                {
                    fields: ['transaction_id']
                }
            ]
        });
    }

    static associate(models) {
        this.belongsTo(models.User, {
            as: 'user',
            foreignKey: 'user_id',
        });
        this.belongsTo(models.SubscriptionPackage, {
            as: 'package',
            foreignKey: 'package_id',
        });
        this.belongsTo(models.PaymentGateway, {
            as: 'gateway',
            foreignKey: 'payment_gateway_id',
        });
        this.hasOne(models.UserSubscription, {
            as: 'subscription',
            foreignKey: 'payment_transaction_id',
        });
    }
}
