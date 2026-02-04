import { DataTypes, Model } from 'sequelize';

export default class RiskModeScore extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            score: {
                type: DataTypes.DECIMAL(8, 2),
                allowNull: false,
                defaultValue: 0,
            },
        }, {
            sequelize,
            tableName: 'risk_mode_scores',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
        });
    }

    static associate(models) {
        // No associations for this model
    }
}
