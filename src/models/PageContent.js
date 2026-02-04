import { DataTypes, Model } from 'sequelize';

export default class PageContent extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            page_identifier: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            section_key: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            content_type: {
                type: DataTypes.ENUM('text', 'rich_text', 'html'),
                allowNull: false,
                defaultValue: 'text',
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
            tableName: 'page_contents',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    fields: ['page_identifier']
                },
                {
                    fields: ['section_key']
                },
                {
                    unique: true,
                    fields: ['page_identifier', 'section_key']
                }
            ]
        });
    }

    static associate(models) {
        this.hasMany(models.PageContentTranslation, {
            as: 'translations',
            foreignKey: 'page_content_id',
        });
        this.hasOne(models.PageContentTranslation, {
            as: 'translation',
            foreignKey: 'page_content_id',
        });
    }
}
