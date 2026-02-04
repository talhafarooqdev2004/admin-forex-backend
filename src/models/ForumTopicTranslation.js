import { DataTypes, Model } from 'sequelize';

export default class ForumTopicTranslation extends Model {
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
            locale: {
                type: DataTypes.STRING(5),
                allowNull: false,
            },
            title: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
        }, {
            sequelize,
            tableName: 'forum_topic_translations',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    unique: true,
                    fields: ['topic_id', 'locale'],
                    name: 'unique_topic_locale'
                }
            ]
        });
    }

    static associate(models) {
        this.belongsTo(models.ForumTopic, {
            as: 'topic',
            foreignKey: 'topic_id',
        });
    }
}
