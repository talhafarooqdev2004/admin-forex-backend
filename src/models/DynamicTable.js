import { DataTypes, Model } from 'sequelize';

export default class DynamicTable extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            name: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            identifier: {
                type: DataTypes.STRING(255),
                allowNull: false,
                unique: true,
            },
            description: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            table_metadata: {
                type: DataTypes.JSON,
                allowNull: true,
            },
            is_active: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true,
            },
        }, {
            sequelize,
            tableName: 'dynamic_tables',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
        });
    }

    static associate(models) {
        this.hasMany(models.TableRow, {
            as: 'rows',
            foreignKey: 'dynamic_table_id',
        });
        this.hasMany(models.TableColumn, {
            as: 'columns',
            foreignKey: 'dynamic_table_id',
        });
    }
}
