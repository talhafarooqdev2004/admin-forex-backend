'use strict';

export async function up(queryInterface, Sequelize) {
    console.log('Starting constraint fix migration...');
    
    // Drop old unique constraints on table_rows
    const possibleRowConstraints = [
        'table_rows_dynamic_table_id_row_index_unique',
        'table_rows_dynamic_table_id_row_index',
        'table_rows_dynamic_table_id_row_index_key'
    ];
    
    for (const constraintName of possibleRowConstraints) {
        try {
            await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${constraintName}" CASCADE`);
            console.log(`Dropped row index: ${constraintName}`);
        } catch (error) {
            console.log(`Could not drop ${constraintName}:`, error.message);
        }
    }
    
    // Find and remove any other unique indexes on table_rows
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
            console.log('Found old row unique indexes:', tableRowsIndexes.map(i => i.indexname));
            for (const idx of tableRowsIndexes) {
                await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${idx.indexname}" CASCADE`);
                console.log(`Dropped row index: ${idx.indexname}`);
            }
        } else {
            console.log('No old row unique indexes found');
        }
    } catch (error) {
        console.log('Error finding old row indexes:', error.message);
    }
    
    // Drop old unique constraints on table_cells
    const possibleCellConstraints = [
        'table_cells_table_row_id_table_column_id_unique',
        'table_cells_table_row_id_table_column_id',
        'table_cells_table_row_id_table_column_id_key'
    ];
    
    for (const constraintName of possibleCellConstraints) {
        try {
            await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${constraintName}" CASCADE`);
            console.log(`Dropped cell index: ${constraintName}`);
        } catch (error) {
            console.log(`Could not drop ${constraintName}:`, error.message);
        }
    }
    
    // Find and remove any other unique indexes on table_cells
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
            console.log('Found old cell unique indexes:', tableCellsIndexes.map(i => i.indexname));
            for (const idx of tableCellsIndexes) {
                await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${idx.indexname}" CASCADE`);
                console.log(`Dropped cell index: ${idx.indexname}`);
            }
        } else {
            console.log('No old cell unique indexes found');
        }
    } catch (error) {
        console.log('Error finding old cell indexes:', error.message);
    }
    
    // Ensure new unique constraints exist with user_id
    try {
        await queryInterface.addIndex('table_rows', ['dynamic_table_id', 'row_index', 'user_id'], {
            unique: true,
            name: 'table_rows_dynamic_table_id_row_index_user_id_unique'
        });
        console.log('Created new row unique index with user_id');
    } catch (error) {
        console.log('Row unique index with user_id may already exist:', error.message);
    }
    
    try {
        await queryInterface.addIndex('table_cells', ['table_row_id', 'table_column_id', 'user_id'], {
            unique: true,
            name: 'table_cells_table_row_id_table_column_id_user_id_unique'
        });
        console.log('Created new cell unique index with user_id');
    } catch (error) {
        console.log('Cell unique index with user_id may already exist:', error.message);
    }
    
    console.log('Constraint fix migration completed!');
}

export async function down(queryInterface) {
    // Reverse the changes
    await queryInterface.removeIndex('table_cells', 'table_cells_table_row_id_table_column_id_user_id_unique');
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
}
