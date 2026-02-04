import { DataTypes, Model } from 'sequelize';

export default class Education extends Model {
    static init(sequelize) {
        return super.init({
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            slug: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            publish: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
        }, {
            sequelize,
            tableName: 'educations',
            timestamps: true,
            underscored: true,
            createdAt: 'created_at',
            updatedAt: 'updated_at',
        });
    }

    static associate(models) {
        this.hasMany(models.EducationTranslation, {
            as: 'translations',
            foreignKey: 'education_id',
        });
        this.hasOne(models.EducationTranslation, {
            as: 'translation',
            foreignKey: 'education_id',
        });
    }
}
