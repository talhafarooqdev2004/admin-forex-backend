import { DataTypes, Model } from 'sequelize';

export default class ColorConfiguration extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            type: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            name: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            min_value: {
                type: DataTypes.FLOAT,
                allowNull: false,
            },
            max_value: {
                type: DataTypes.FLOAT,
                allowNull: false,
            },
            color: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            display_order: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            is_active: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true,
            },
        }, {
            sequelize,
            tableName: 'color_configurations',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    fields: ['type', 'is_active']
                }
            ]
        });
    }

    static associate(models) {
        // No associations for this model
    }
}
