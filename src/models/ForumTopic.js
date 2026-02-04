import { DataTypes, Model } from 'sequelize';

export default class ForumTopic extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
        }, {
            sequelize,
            tableName: 'forum_topics',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    fields: ['created_at']
                }
            ]
        });
    }

    static associate(models) {
        this.hasMany(models.ForumPost, {
            as: 'posts',
            foreignKey: 'topic_id',
        });
        this.hasMany(models.ForumTopicTranslation, {
            as: 'translations',
            foreignKey: 'topic_id',
        });
        this.hasOne(models.ForumTopicTranslation, {
            as: 'translation',
            foreignKey: 'topic_id',
        });
    }
}
