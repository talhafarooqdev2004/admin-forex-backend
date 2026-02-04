import bcrypt from 'bcrypt';
import { User, sequelize } from './src/models/index.js';

async function createAdminUser() {
    try {
        console.log('🔄 Creating admin user...\n');
        
        // Wait a bit for models to initialize
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Test database connection
        await sequelize.authenticate();
        console.log('✅ Database connection established\n');
        
        const email = 'admin123@gmail.com';
        const password = '12345678';
        
        // Check if user already exists
        const existingUser = await User.findOne({
            where: { email }
        });
        
        if (existingUser) {
            // Update existing user to admin
            const hashedPassword = await bcrypt.hash(password, 10);
            await existingUser.update({
                password: hashedPassword,
                role: 'admin'
            });
            console.log(`✅ Updated existing user ${email} to admin role`);
        } else {
            // Create new admin user
            const hashedPassword = await bcrypt.hash(password, 10);
            const adminUser = await User.create({
                first_name: 'Admin',
                last_name: 'User',
                email: email,
                password: hashedPassword,
                role: 'admin'
            });
            console.log(`✅ Created admin user: ${email}`);
            console.log(`   User ID: ${adminUser.id}`);
        }
        
        console.log('\n✅ Admin user setup complete!');
        console.log(`   Email: ${email}`);
        console.log(`   Password: ${password}`);
        console.log(`   Role: admin`);
        
    } catch (error) {
        console.error('\n❌ Error creating admin user:', error);
        console.error('Error details:', error.message);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

createAdminUser();
