import { DataTypes, Model } from 'sequelize';

export default class TableCell extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            table_row_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                references: {
                    model: 'table_rows',
                    key: 'id'
                },
                onDelete: 'CASCADE'
            },
            table_column_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                references: {
                    model: 'table_columns',
                    key: 'id'
                },
                onDelete: 'CASCADE'
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
            value: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            formula: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            data_type: {
                type: DataTypes.STRING(255),
                allowNull: false,
                defaultValue: 'text',
            },
            cell_metadata: {
                type: DataTypes.JSON,
                allowNull: true,
            },
        }, {
            sequelize,
            tableName: 'table_cells',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    unique: true,
                    fields: ['table_row_id', 'table_column_id', 'user_id']
                },
                {
                    fields: ['table_row_id', 'table_column_id']
                },
                {
                    fields: ['user_id']
                }
            ]
        });
    }

    static associate(models) {
        this.belongsTo(models.TableRow, {
            as: 'row',
            foreignKey: 'table_row_id',
        });
        this.belongsTo(models.TableColumn, {
            as: 'column',
            foreignKey: 'table_column_id',
        });
        this.belongsTo(models.User, {
            as: 'user',
            foreignKey: 'user_id',
        });
    }
}
