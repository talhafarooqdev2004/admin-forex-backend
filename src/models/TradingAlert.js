import { DataTypes, Model } from 'sequelize';

export default class TradingAlert extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            trade_id: {
                type: DataTypes.STRING(255),
                allowNull: true,
                unique: true,
            },
            pair: {
                type: DataTypes.STRING(255),
                allowNull: true,
            },
            direction: {
                type: DataTypes.ENUM('buy', 'sell'),
                allowNull: true,
            },
            entry_level: {
                type: DataTypes.DECIMAL(10, 5),
                allowNull: true,
            },
            stop_loss: {
                type: DataTypes.DECIMAL(10, 5),
                allowNull: true,
            },
            tp1: {
                type: DataTypes.DECIMAL(10, 5),
                allowNull: true,
            },
            tp2: {
                type: DataTypes.DECIMAL(10, 5),
                allowNull: true,
            },
            image_path: {
                type: DataTypes.STRING(255),
                allowNull: true,
            },
            trade_follow_up: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            type: {
                type: DataTypes.ENUM('Swing', 'Scalp'),
                allowNull: true,
            },
            result: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: false,
                defaultValue: 0,
            },
            status: {
                type: DataTypes.ENUM('completed', 'open', 'stopped'),
                allowNull: false,
                defaultValue: 'open',
            },
            comment: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
            },
        }, {
            sequelize,
            tableName: 'trading_alerts',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            getterMethods: {
                entry_level() {
                    const value = this.getDataValue('entry_level');
                    return value !== null && value !== undefined ? parseFloat(value) : value;
                },
                stop_loss() {
                    const value = this.getDataValue('stop_loss');
                    return value !== null && value !== undefined ? parseFloat(value) : value;
                },
                tp1() {
                    const value = this.getDataValue('tp1');
                    return value !== null && value !== undefined ? parseFloat(value) : value;
                },
                tp2() {
                    const value = this.getDataValue('tp2');
                    return value !== null && value !== undefined ? parseFloat(value) : value;
                },
                result() {
                    const value = this.getDataValue('result');
                    return value !== null && value !== undefined ? parseFloat(value) : value;
                },
            },
            indexes: [
                {
                    fields: ['date']
                },
                {
                    fields: ['status']
                },
                {
                    fields: ['pair']
                }
            ]
        });
    }

    static associate(models) {
        // No associations for this model
    }
}
