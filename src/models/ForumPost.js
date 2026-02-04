import { DataTypes, Model } from 'sequelize';

export default class ForumPost extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            topic_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                references: {
                    model: 'forum_topics',
                    key: 'id'
                },
                onDelete: 'CASCADE'
            },
            banner_img: {
                type: DataTypes.STRING(255),
                allowNull: true,
            },
            slug: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
        }, {
            sequelize,
            tableName: 'forum_posts',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    fields: ['topic_id', 'created_at']
                }
            ]
        });
    }

    static associate(models) {
        this.belongsTo(models.ForumTopic, {
            as: 'topic',
            foreignKey: 'topic_id',
        });
        this.hasMany(models.ForumPostTranslation, {
            as: 'translations',
            foreignKey: 'post_id',
        });
        this.hasOne(models.ForumPostTranslation, {
            as: 'translation',
            foreignKey: 'post_id',
        });
    }
}
