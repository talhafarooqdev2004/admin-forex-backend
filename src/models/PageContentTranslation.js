import { DataTypes, Model } from 'sequelize';

export default class PageContentTranslation extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            page_content_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                references: {
                    model: 'page_contents',
                    key: 'id'
                },
                onDelete: 'CASCADE'
            },
            locale: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            content_value: {
                type: DataTypes.TEXT('long'),
                allowNull: false,
            },
        }, {
            sequelize,
            tableName: 'page_content_translations',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    unique: true,
                    fields: ['page_content_id', 'locale'],
                    name: 'unique_page_content_locale'
                }
            ]
        });
    }

    static associate(models) {
        this.belongsTo(models.PageContent, {
            as: 'pageContent',
            foreignKey: 'page_content_id',
        });
    }
}
