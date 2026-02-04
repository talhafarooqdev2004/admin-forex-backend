import { DataTypes, Model } from 'sequelize';

export default class UserSubscription extends Model {
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
            payment_transaction_id: {
                type: DataTypes.BIGINT,
                allowNull: true,
                references: {
                    model: 'payment_transactions',
                    key: 'id'
                },
                onDelete: 'SET NULL'
            },
            start_date: {
                type: DataTypes.DATE,
                allowNull: false,
            },
            end_date: {
                type: DataTypes.DATE,
                allowNull: false,
            },
            status: {
                type: DataTypes.ENUM('active', 'expired', 'cancelled'),
                allowNull: false,
                defaultValue: 'active',
            },
            cancelled_at: {
                type: DataTypes.DATE,
                allowNull: true,
            },
            cancellation_reason: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
        }, {
            sequelize,
            tableName: 'user_subscriptions',
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
                    fields: ['status']
                },
                {
                    fields: ['user_id', 'status']
                },
                {
                    fields: ['end_date']
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
        this.belongsTo(models.PaymentTransaction, {
            as: 'transaction',
            foreignKey: 'payment_transaction_id',
        });
    }
}
