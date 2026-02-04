import { DataTypes, Model } from 'sequelize';

export default class TableRow extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            dynamic_table_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                references: {
                    model: 'dynamic_tables',
                    key: 'id'
                },
                onDelete: 'CASCADE'
            },
            currency_pair_id: {
                type: DataTypes.BIGINT,
                allowNull: true,
                references: {
                    model: 'currency_pairs',
                    key: 'id'
                },
                onDelete: 'SET NULL'
            },
            row_index: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            user_id: {
                type: DataTypes.BIGINT,
                allowNull: true,
                references: {
                    model: 'users',
                    key: 'id'
                },
                onDelete: 'CASCADE'
            },
            row_metadata: {
                type: DataTypes.JSON,
                allowNull: true,
            },
        }, {
            sequelize,
            tableName: 'table_rows',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    unique: true,
                    fields: ['dynamic_table_id', 'row_index', 'user_id']
                },
                {
                    fields: ['dynamic_table_id', 'row_index']
                },
                {
                    fields: ['user_id']
                }
            ]
        });
    }

    static associate(models) {
        this.belongsTo(models.DynamicTable, {
            as: 'table',
            foreignKey: 'dynamic_table_id',
        });
        this.belongsTo(models.CurrencyPair, {
            as: 'currencyPair',
            foreignKey: 'currency_pair_id',
        });
        this.belongsTo(models.User, {
            as: 'user',
            foreignKey: 'user_id',
        });
        this.hasMany(models.TableCell, {
            as: 'cells',
            foreignKey: 'table_row_id',
        });
    }
}
