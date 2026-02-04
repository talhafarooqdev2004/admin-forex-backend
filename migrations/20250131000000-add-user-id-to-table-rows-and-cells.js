'use strict';

export async function up(queryInterface, Sequelize) {
    // Add user_id to table_rows
    await queryInterface.addColumn('table_rows', 'user_id', {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        },
        onDelete: 'CASCADE'
    });

    // Add user_id to table_cells
    await queryInterface.addColumn('table_cells', 'user_id', {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
            model: 'users',
            key: 'id'
        },
        onDelete: 'CASCADE'
    });

    // Drop old unique constraint on table_rows
    // First, try to drop by common constraint names
    const possibleRowConstraints = [
        'table_rows_dynamic_table_id_row_index_unique',
        'table_rows_dynamic_table_id_row_index',
        'table_rows_dynamic_table_id_row_index_key'
    ];

    for (const constraintName of possibleRowConstraints) {
        try {
            await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${constraintName}"`);
            console.log(`Dropped index: ${constraintName}`);
        } catch (error) {
            // Ignore if doesn't exist
        }
    }

    // Also try to find and remove any other unique indexes
    try {
        const [tableRowsIndexes] = await queryInterface.sequelize.query(`
            SELECT indexname 
            FROM pg_indexes 
            WHERE tablename = 'table_rows' 
            AND indexdef LIKE '%UNIQUE%' 
            AND indexdef LIKE '%dynamic_table_id%' 
            AND indexdef LIKE '%row_index%'
            AND indexdef NOT LIKE '%user_id%'
        `);

        if (tableRowsIndexes.length > 0) {
            console.log('Found old unique indexes to remove:', tableRowsIndexes.map(i => i.indexname));
            for (const idx of tableRowsIndexes) {
                await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${idx.indexname}"`);
                console.log(`Dropped index: ${idx.indexname}`);
            }
        }
    } catch (error) {
        console.log('Note: Could not find/remove old table_rows unique index');
    }

    // Add new unique constraint with user_id
    await queryInterface.addIndex('table_rows', ['dynamic_table_id', 'row_index', 'user_id'], {
        unique: true,
        name: 'table_rows_dynamic_table_id_row_index_user_id_unique'
    });

    // Add index on user_id for table_rows
    await queryInterface.addIndex('table_rows', ['user_id'], {
        name: 'table_rows_user_id_idx'
    });

    // Drop old unique constraint on table_cells
    // First, try to drop by common constraint names
    const possibleCellConstraints = [
        'table_cells_table_row_id_table_column_id_unique',
        'table_cells_table_row_id_table_column_id',
        'table_cells_table_row_id_table_column_id_key'
    ];

    for (const constraintName of possibleCellConstraints) {
        try {
            await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${constraintName}"`);
            console.log(`Dropped index: ${constraintName}`);
        } catch (error) {
            // Ignore if doesn't exist
        }
    }

    // Also try to find and remove any other unique indexes
    try {
        const [tableCellsIndexes] = await queryInterface.sequelize.query(`
            SELECT indexname 
            FROM pg_indexes 
            WHERE tablename = 'table_cells' 
            AND indexdef LIKE '%UNIQUE%' 
            AND indexdef LIKE '%table_row_id%' 
            AND indexdef LIKE '%table_column_id%'
            AND indexdef NOT LIKE '%user_id%'
        `);

        if (tableCellsIndexes.length > 0) {
            console.log('Found old unique indexes to remove:', tableCellsIndexes.map(i => i.indexname));
            for (const idx of tableCellsIndexes) {
                await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${idx.indexname}"`);
                console.log(`Dropped index: ${idx.indexname}`);
            }
        }
    } catch (error) {
        console.log('Note: Could not find/remove old table_cells unique index');
    }

    // Add new unique constraint with user_id
    await queryInterface.addIndex('table_cells', ['table_row_id', 'table_column_id', 'user_id'], {
        unique: true,
        name: 'table_cells_table_row_id_table_column_id_user_id_unique'
    });

    // Add index on user_id for table_cells
    await queryInterface.addIndex('table_cells', ['user_id'], {
        name: 'table_cells_user_id_idx'
    });
}

export async function down(queryInterface) {
    // Remove indexes
    await queryInterface.removeIndex('table_cells', 'table_cells_user_id_idx');
    await queryInterface.removeIndex('table_cells', 'table_cells_table_row_id_table_column_id_user_id_unique');
    await queryInterface.removeIndex('table_rows', 'table_rows_user_id_idx');
    await queryInterface.removeIndex('table_rows', 'table_rows_dynamic_table_id_row_index_user_id_unique');

    // Restore old unique constraints
    await queryInterface.addIndex('table_cells', ['table_row_id', 'table_column_id'], {
        unique: true,
        name: 'table_cells_table_row_id_table_column_id_unique'
    });

    await queryInterface.addIndex('table_rows', ['dynamic_table_id', 'row_index'], {
        unique: true,
        name: 'table_rows_dynamic_table_id_row_index_unique'
    });

    // Remove columns
    await queryInterface.removeColumn('table_cells', 'user_id');
    await queryInterface.removeColumn('table_rows', 'user_id');
}
