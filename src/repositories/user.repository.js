import { User } from '../models/index.js';
import { Op } from 'sequelize';

export class UserRepository {
    async findAll() {
        return await User.findAll({
            where: {
                role: { [Op.ne]: 'admin' } // Exclude admin users
            },
            attributes: { exclude: ['password'] },
            order: [['created_at', 'DESC']],
        });
    }

    async findById(id) {
        return await User.findByPk(id, {
            attributes: { exclude: ['password'] },
        });
    }

    async findByEmail(email) {
        return await User.findOne({
            where: { email },
        });
    }

    async findByEmailWithPassword(email) {
        return await User.findOne({
            where: { email },
        });
    }

    async findByGoogleId(googleId) {
        return await User.findOne({
            where: { google_id: googleId },
        });
    }

    async create(userData) {
        return await User.create(userData);
    }

    async update(id, userData) {
        const user = await User.findByPk(id);
        if (!user) return null;
        
        // Transform camelCase to snake_case for database
        const updateData = {};
        if (userData.firstName !== undefined) updateData.first_name = userData.firstName;
        if (userData.lastName !== undefined) updateData.last_name = userData.lastName;
        if (userData.email !== undefined) updateData.email = userData.email;
        if (userData.gender !== undefined) updateData.gender = userData.gender || null;
        if (userData.phone !== undefined) updateData.phone = userData.phone || null;
        if (userData.image !== undefined) updateData.image = userData.image || null;
        
        await user.update(updateData);
        return await User.findByPk(id, {
            attributes: { exclude: ['password'] },
        });
    }

    async delete(id) {
        const user = await User.findByPk(id);
        if (!user) return false;
        
        await user.destroy();
        return true;
    }

    async getTotalUsersCount() {
        return await User.count({
            where: {
                role: { [Op.ne]: 'admin' } // Exclude admin users from count
            }
        });
    }

    async getGoogleUsersCount() {
        return await User.count({
            where: { 
                google_id: { [Op.ne]: null },
                role: { [Op.ne]: 'admin' } // Exclude admin users
            }
        });
    }

    async getNewUsersCount(days = 30) {
        const date = new Date();
        date.setDate(date.getDate() - days);
        
        return await User.count({
            where: {
                created_at: { [Op.gte]: date },
                role: { [Op.ne]: 'admin' } // Exclude admin users
            }
        });
    }
}
