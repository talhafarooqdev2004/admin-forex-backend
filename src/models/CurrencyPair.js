import { DataTypes, Model } from 'sequelize';

export default class CurrencyPair extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            code: {
                type: DataTypes.STRING(10),
                allowNull: false,
                unique: true,
            },
            base_currency: {
                type: DataTypes.STRING(3),
                allowNull: false,
            },
            quote_currency: {
                type: DataTypes.STRING(3),
                allowNull: false,
            },
            is_active: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true,
            },
            display_order: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
        }, {
            sequelize,
            tableName: 'currency_pairs',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
        });
    }

    static associate(models) {
        this.hasMany(models.TableRow, {
            as: 'tableRows',
            foreignKey: 'currency_pair_id',
        });
        this.hasMany(models.ScoreDashboard, {
            as: 'scoreDashboard',
            foreignKey: 'currency_pair_id',
        });
    }
}
