import { DataTypes, Model } from 'sequelize';

export default class PaymentGateway extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            name: {
                type: DataTypes.STRING(255),
                allowNull: false,
                unique: true,
            },
            display_name: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            description: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            is_active: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
            credentials: {
                type: DataTypes.JSON,
                allowNull: true,
            },
            settings: {
                type: DataTypes.JSON,
                allowNull: true,
            },
            display_order: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            icon: {
                type: DataTypes.STRING(255),
                allowNull: true,
            },
        }, {
            sequelize,
            tableName: 'payment_gateways',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    fields: ['is_active']
                }
            ]
        });
    }

    static associate(models) {
        this.hasMany(models.PaymentTransaction, {
            as: 'transactions',
            foreignKey: 'payment_gateway_id',
        });
    }
}
