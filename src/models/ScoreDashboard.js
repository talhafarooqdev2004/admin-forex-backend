import { DataTypes, Model } from 'sequelize';

export default class ScoreDashboard extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            currency_pair_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                unique: true,
                references: {
                    model: 'currency_pairs',
                    key: 'id'
                },
                onDelete: 'CASCADE'
            },
            net_score: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: true,
            },
            net_bias: {
                type: DataTypes.STRING(255),
                allowNull: true,
            },
            trend_score: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: true,
            },
            momentum_score: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: true,
            },
            volatility_score: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: true,
            },
            sentiment_score: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: true,
            },
            seasonal_score: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: true,
            },
            cot_score: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: true,
            },
            fundamental_score: {
                type: DataTypes.DECIMAL(10, 2),
                allowNull: true,
            },
            additional_scores: {
                type: DataTypes.JSON,
                allowNull: true,
            },
            calculated_at: {
                type: DataTypes.DATE,
                allowNull: true,
            },
        }, {
            sequelize,
            tableName: 'score_dashboard',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    fields: ['currency_pair_id']
                }
            ]
        });
    }

    static associate(models) {
        this.belongsTo(models.CurrencyPair, {
            as: 'currencyPair',
            foreignKey: 'currency_pair_id',
        });
    }
}
