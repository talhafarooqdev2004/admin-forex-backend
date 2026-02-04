import { DataTypes, Model } from 'sequelize';

export default class ForumPostTranslation extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            post_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                references: {
                    model: 'forum_posts',
                    key: 'id'
                },
                onDelete: 'CASCADE'
            },
            locale: {
                type: DataTypes.STRING(5),
                allowNull: false,
            },
            title: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            content: {
                type: DataTypes.TEXT,
                allowNull: false,
            },
        }, {
            sequelize,
            tableName: 'forum_post_translations',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    unique: true,
                    fields: ['post_id', 'locale'],
                    name: 'unique_post_locale'
                }
            ]
        });
    }

    static associate(models) {
        this.belongsTo(models.ForumPost, {
            as: 'post',
            foreignKey: 'post_id',
        });
    }
}
