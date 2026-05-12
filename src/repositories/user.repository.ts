import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
const withoutPassword = {
    password: false,
};
const normalizeUserPayload = (userData) => {
    const updateData = {};
    if (userData.firstName !== undefined)
        updateData.first_name = userData.firstName;
    if (userData.first_name !== undefined)
        updateData.first_name = userData.first_name;
    if (userData.lastName !== undefined)
        updateData.last_name = userData.lastName;
    if (userData.last_name !== undefined)
        updateData.last_name = userData.last_name;
    if (userData.email !== undefined)
        updateData.email = userData.email;
    if (userData.password !== undefined)
        updateData.password = userData.password;
    if (userData.gender !== undefined)
        updateData.gender = userData.gender || null;
    if (userData.phone !== undefined)
        updateData.phone = userData.phone || null;
    if (userData.image !== undefined)
        updateData.image = userData.image || null;
    if (userData.role !== undefined)
        updateData.role = userData.role;
    if (userData.google_id !== undefined)
        updateData.google_id = userData.google_id || null;
    if (userData.facebook_id !== undefined)
        updateData.facebook_id = userData.facebook_id || null;
    if (userData.apple_id !== undefined)
        updateData.apple_id = userData.apple_id || null;
    return updateData;
};
export class UserRepository {
    async findAll() {
        const users = await prisma.user.findMany({
            where: {
                role: {
                    not: 'admin',
                },
            },
            omit: withoutPassword,
            orderBy: {
                created_at: 'desc',
            },
        });
        return serializePrisma(users);
    }
    async findById(id) {
        const user = await prisma.user.findUnique({
            where: {
                id: BigInt(id),
            },
            omit: withoutPassword,
        });
        return serializePrisma(user);
    }
    async findByEmail(email) {
        const user = await prisma.user.findUnique({
            where: { email },
        });
        return serializePrisma(user);
    }
    async findByEmailWithPassword(email) {
        return this.findByEmail(email);
    }
    async findByGoogleId(googleId) {
        const user = await prisma.user.findFirst({
            where: {
                google_id: googleId,
            },
        });
        return serializePrisma(user);
    }
    async create(userData) {
        const user = await prisma.user.create({
            data: normalizeUserPayload(userData),
        });
        return serializePrisma(user);
    }
    async update(id, userData) {
        const existingUser = await prisma.user.findUnique({
            where: {
                id: BigInt(id),
            },
        });
        if (!existingUser)
            return null;
        const user = await prisma.user.update({
            where: {
                id: BigInt(id),
            },
            data: normalizeUserPayload(userData),
            omit: withoutPassword,
        });
        return serializePrisma(user);
    }
    async delete(id) {
        const existingUser = await prisma.user.findUnique({
            where: {
                id: BigInt(id),
            },
            select: { id: true },
        });
        if (!existingUser)
            return false;
        await prisma.user.delete({
            where: {
                id: BigInt(id),
            },
        });
        return true;
    }
    async getTotalUsersCount() {
        return prisma.user.count({
            where: {
                role: {
                    not: 'admin',
                },
            },
        });
    }
    async getGoogleUsersCount() {
        return prisma.user.count({
            where: {
                google_id: {
                    not: null,
                },
                role: {
                    not: 'admin',
                },
            },
        });
    }
    async getNewUsersCount(days = 30) {
        const date = new Date();
        date.setDate(date.getDate() - days);
        return prisma.user.count({
            where: {
                created_at: {
                    gte: date,
                },
                role: {
                    not: 'admin',
                },
            },
        });
    }
}
