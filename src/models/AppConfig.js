import { DataTypes, Model } from 'sequelize';

export default class AppConfig extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            key: {
                type: DataTypes.STRING(255),
                allowNull: false,
                unique: true,
            },
            value: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            description: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
        }, {
            sequelize,
            tableName: 'app_configs',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    fields: ['key']
                }
            ]
        });
    }

    static associate(models) {
        // No associations for this model
    }
}
