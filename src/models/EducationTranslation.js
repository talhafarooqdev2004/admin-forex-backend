import { DataTypes, Model } from 'sequelize';

export default class EducationTranslation extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            education_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                references: {
                    model: 'educations',
                    key: 'id'
                },
                onDelete: 'CASCADE'
            },
            locale: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            title: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            content: {
                type: DataTypes.TEXT('long'),
                allowNull: false,
            },
        }, {
            sequelize,
            tableName: 'education_translations',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            indexes: [
                {
                    unique: true,
                    fields: ['education_id', 'locale'],
                    name: 'unique_educations_locale'
                }
            ]
        });
    }

    static associate(models) {
        this.belongsTo(models.Education, {
            as: 'education',
            foreignKey: 'education_id',
        });
    }
}
