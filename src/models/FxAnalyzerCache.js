import { DataTypes, Model } from 'sequelize';

export default class FxAnalyzerCache extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            pair: {
                type: DataTypes.STRING(255),
                allowNull: false,
                unique: true,
                comment: 'Currency pair identifier (e.g., EUR/USD)',
            },
            currency_pair_id: {
                type: DataTypes.BIGINT,
                allowNull: true,
                references: {
                    model: 'currency_pairs',
                    key: 'id'
                },
                onDelete: 'CASCADE',
                comment: 'Foreign key to currency_pairs table',
            },
            complete_data: {
                type: DataTypes.TEXT('long'),
                allowNull: false,
                comment: 'JSON string containing all pre-calculated analyzer data',
                get() {
                    const rawValue = this.getDataValue('complete_data');
                    return rawValue ? JSON.parse(rawValue) : null;
                },
                set(value) {
                    this.setDataValue('complete_data', JSON.stringify(value));
                }
            },
            last_updated: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW,
                comment: 'Timestamp of last cache update',
            },
        }, {
            sequelize,
            tableName: 'fx_analyzer_cache',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    unique: true,
                    fields: ['pair']
                },
                {
                    fields: ['currency_pair_id']
                },
                {
                    fields: ['last_updated']
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
