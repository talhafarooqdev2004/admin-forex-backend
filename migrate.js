import { Sequelize } from 'sequelize';
import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ENV } from './src/config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create Sequelize instance
const sequelize = new Sequelize(
    ENV.DB_NAME,
    ENV.DB_USER,
    ENV.DB_PASSWORD,
    {
        host: ENV.DB_HOST,
        port: ENV.DB_PORT,
        dialect: 'postgres',
        logging: console.log,
    }
);

// Create SequelizeMeta table if it doesn't exist
async function ensureSequelizeMetaTable() {
    const queryInterface = sequelize.getQueryInterface();
    
    try {
        await queryInterface.describeTable('SequelizeMeta');
    } catch (error) {
        // Table doesn't exist, create it
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS "SequelizeMeta" (
                name VARCHAR(255) NOT NULL PRIMARY KEY
            );
        `);
        console.log('✅ Created SequelizeMeta table');
    }
}

// Get all migration files
async function getMigrationFiles() {
    const migrationsDir = join(__dirname, 'migrations');
    const files = await readdir(migrationsDir);
    return files
        .filter(file => file.endsWith('.js') && !file.includes('README'))
        .sort();
}

// Check if migration has been run
async function isMigrationRun(name) {
    const [results] = await sequelize.query(
        'SELECT name FROM "SequelizeMeta" WHERE name = :name',
        {
            replacements: { name }
        }
    );
    return Array.isArray(results) && results.length > 0;
}

// Check if column exists
async function columnExists(tableName, columnName) {
    try {
        const queryInterface = sequelize.getQueryInterface();
        const tableDescription = await queryInterface.describeTable(tableName);
        return columnName in tableDescription;
    } catch (error) {
        return false;
    }
}

// Run a single migration
async function runMigration(file) {
    const migrationPath = join(__dirname, 'migrations', file);
    const migration = await import(migrationPath);
    
    if (!migration.up || typeof migration.up !== 'function') {
        throw new Error(`Migration ${file} does not export an 'up' function`);
    }
    
    const queryInterface = sequelize.getQueryInterface();
    const transaction = await sequelize.transaction();
    
    try {
        console.log(`Running migration: ${file}`);
        await migration.up(queryInterface, Sequelize);
        
        // Record migration
        await sequelize.query(
            'INSERT INTO "SequelizeMeta" (name) VALUES (:name)',
            {
                replacements: { name: file },
                transaction
            }
        );
        
        await transaction.commit();
        console.log(`✅ Successfully ran migration: ${file}`);
    } catch (error) {
        await transaction.rollback();
        
        // Check if error is due to column/constraint already existing
        const errorMessage = error.message || error.original?.message || '';
        const errorCode = error.original?.code || '';
        
        // PostgreSQL error codes:
        // 42701 = duplicate column
        // 42P07 = duplicate table
        // 42710 = duplicate object (constraint, index, etc.)
        if (errorCode === '42701' || 
            errorCode === '42P07' || 
            errorCode === '42710' ||
            errorMessage.includes('already exists') ||
            errorMessage.includes('duplicate')) {
            console.log(`⚠️  Migration ${file} attempted to create existing object`);
            console.log(`   This usually means the migration was already applied manually.`);
            console.log(`   Marking as completed...`);
            
            // Mark migration as run even though it failed (because it's already applied)
            try {
                const [results] = await sequelize.query(
                    'SELECT name FROM "SequelizeMeta" WHERE name = :name',
                    {
                        replacements: { name: file }
                    }
                );
                
                if (results.length === 0) {
                    await sequelize.query(
                        'INSERT INTO "SequelizeMeta" (name) VALUES (:name)',
                        {
                            replacements: { name: file }
                        }
                    );
                    console.log(`✅ Marked migration ${file} as completed (already applied)`);
                } else {
                    console.log(`✅ Migration ${file} already marked as completed`);
                }
            } catch (insertError) {
                console.warn(`⚠️  Could not mark migration ${file} as run:`, insertError.message);
                throw error; // Re-throw if we can't mark it
            }
        } else {
            console.error(`❌ Error running migration ${file}:`, error.message || error);
            throw error;
        }
    }
}

// Main migration function
async function migrate() {
    try {
        console.log('🔄 Starting migrations...\n');
        
        // Test database connection
        await sequelize.authenticate();
        console.log('✅ Database connection established\n');
        
        // Ensure SequelizeMeta table exists
        await ensureSequelizeMetaTable();
        
        // Get all migration files
        const migrationFiles = await getMigrationFiles();
        console.log(`Found ${migrationFiles.length} migration file(s)\n`);
        
        // Run pending migrations
        let runCount = 0;
        for (const file of migrationFiles) {
            const isRun = await isMigrationRun(file);
            
            if (!isRun) {
                await runMigration(file);
                runCount++;
            } else {
                console.log(`⏭️  Skipping already run migration: ${file}`);
            }
        }
        
        if (runCount === 0) {
            console.log('\n✅ All migrations are up to date!');
        } else {
            console.log(`\n✅ Successfully ran ${runCount} migration(s)`);
        }
        
    } catch (error) {
        console.error('\n❌ Migration failed:', error);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

// Run migrations
migrate();
