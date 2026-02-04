'use strict';

export async function up(queryInterface, Sequelize) {
    console.log('Dropping old unique constraints...');
    
    // Drop the constraint on table_rows (not just the index)
    try {
        await queryInterface.sequelize.query(`
            ALTER TABLE "table_rows" 
            DROP CONSTRAINT IF EXISTS "table_rows_dynamic_table_id_row_index_unique" CASCADE
        `);
        console.log('✓ Dropped old table_rows constraint');
    } catch (error) {
        console.log('Could not drop table_rows constraint:', error.message);
    }
    
    // Drop the constraint on table_cells (not just the index)
    try {
        await queryInterface.sequelize.query(`
            ALTER TABLE "table_cells" 
            DROP CONSTRAINT IF EXISTS "table_cells_table_row_id_table_column_id_unique" CASCADE
        `);
        console.log('✓ Dropped old table_cells constraint');
    } catch (error) {
        console.log('Could not drop table_cells constraint:', error.message);
    }
    
    console.log('Old constraints dropped successfully!');
}

export async function down(queryInterface) {
    // Restore old constraints (without user_id)
    await queryInterface.sequelize.query(`
        ALTER TABLE "table_rows" 
        ADD CONSTRAINT "table_rows_dynamic_table_id_row_index_unique" 
        UNIQUE ("dynamic_table_id", "row_index")
    `);
    
    await queryInterface.sequelize.query(`
        ALTER TABLE "table_cells" 
        ADD CONSTRAINT "table_cells_table_row_id_table_column_id_unique" 
        UNIQUE ("table_row_id", "table_column_id")
    `);
}
