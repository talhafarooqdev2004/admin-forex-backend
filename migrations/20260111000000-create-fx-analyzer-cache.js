'use strict';

export async function up(queryInterface, Sequelize) {
    await queryInterface.createTable('fx_analyzer_cache', {
        id: {
            type: Sequelize.BIGINT,
            autoIncrement: true,
            primaryKey: true,
        },
        pair: {
            type: Sequelize.STRING(255),
            allowNull: false,
            unique: true,
            comment: 'Currency pair identifier (e.g., EUR/USD)',
        },
        currency_pair_id: {
            type: Sequelize.BIGINT,
            allowNull: true,
            references: {
                model: 'currency_pairs',
                key: 'id',
            },
            onDelete: 'CASCADE',
            comment: 'Foreign key to currency_pairs table',
        },
        complete_data: {
            type: Sequelize.TEXT('long'),
            allowNull: false,
            comment: 'JSON string containing all pre-calculated analyzer data',
        },
        last_updated: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        created_at: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updated_at: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
    }, {
        comment: 'Cache table for pre-computed fx-analyzer data per currency pair',
    });

    await queryInterface.addIndex('fx_analyzer_cache', ['pair'], {
        unique: true,
        name: 'idx_fx_analyzer_cache_pair',
    });

    await queryInterface.addIndex('fx_analyzer_cache', ['currency_pair_id'], {
        name: 'idx_fx_analyzer_cache_currency_pair_id',
    });

    await queryInterface.addIndex('fx_analyzer_cache', ['last_updated'], {
        name: 'idx_fx_analyzer_cache_last_updated',
    });
}

export async function down(queryInterface) {
    await queryInterface.dropTable('fx_analyzer_cache');
}
