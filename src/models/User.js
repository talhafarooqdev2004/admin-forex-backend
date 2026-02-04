import { DataTypes, Model } from 'sequelize';

export default class User extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            first_name: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            last_name: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            email: {
                type: DataTypes.STRING(255),
                allowNull: false,
                unique: true,
                validate: {
                    isEmail: true,
                },
            },
            password: {
                type: DataTypes.STRING(255),
                allowNull: true,
            },
            gender: {
                type: DataTypes.ENUM('male', 'female', 'other'),
                allowNull: true,
            },
            google_id: {
                type: DataTypes.STRING(255),
                allowNull: true,
                unique: true,
            },
            facebook_id: {
                type: DataTypes.STRING(255),
                allowNull: true,
                unique: true,
            },
            apple_id: {
                type: DataTypes.STRING(255),
                allowNull: true,
                unique: true,
            },
            role: {
                type: DataTypes.ENUM('user', 'admin'),
                allowNull: false,
                defaultValue: 'user',
            },
            phone: {
                type: DataTypes.STRING(20),
                allowNull: true,
            },
            image: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
        }, {
            sequelize,
            tableName: 'users',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
        });
    }

    static associate(models) {
        this.hasMany(models.UserSubscription, {
            as: 'subscriptions',
            foreignKey: 'user_id',
        });
        this.hasMany(models.PaymentTransaction, {
            as: 'transactions',
            foreignKey: 'user_id',
        });
    }
}
