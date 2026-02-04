import { DataTypes, Model } from 'sequelize';

export default class TableColumn extends Model {
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
            header: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            key: {
                type: DataTypes.STRING(255),
                allowNull: true,
            },
            column_index: {
                type: DataTypes.INTEGER,
                allowNull: false,
            },
            column_metadata: {
                type: DataTypes.JSON,
                allowNull: true,
            },
        }, {
            sequelize,
            tableName: 'table_columns',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    unique: true,
                    fields: ['dynamic_table_id', 'column_index']
                },
                {
                    fields: ['dynamic_table_id', 'column_index']
                }
            ]
        });
    }

    static associate(models) {
        this.belongsTo(models.DynamicTable, {
            as: 'table',
            foreignKey: 'dynamic_table_id',
        });
        this.hasMany(models.TableCell, {
            as: 'cells',
            foreignKey: 'table_column_id',
        });
    }
}
