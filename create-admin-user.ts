/**
 * Creates or updates an admin user (email + bcrypt password). Credentials come from env only.
 *
 *   cd forex-admin-backend
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='YourSecurePassword' npm run create-admin
 *
 * Optional: ADMIN_FIRST_NAME, ADMIN_LAST_NAME
 *
 * Uses the same DATABASE_URL / DB_* rules as the API (see src/config/env.ts).
 */

import "dotenv/config";
import bcrypt from "bcrypt";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";

function buildDatabaseUrl(): string {
    if (process.env.DATABASE_URL) {
        return process.env.DATABASE_URL;
    }
    const user = encodeURIComponent(process.env.DB_USER || "");
    const pass = encodeURIComponent(process.env.DB_PASSWORD || "");
    const host = process.env.DB_HOST || "127.0.0.1";
    const port = process.env.DB_PORT || "5432";
    const database = process.env.DB_NAME || "";
    return `postgresql://${user}:${pass}@${host}:${port}/${database}`;
}

const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD;

if (!adminEmail || !adminPassword) {
    console.error("Missing env: set ADMIN_EMAIL and ADMIN_PASSWORD (see script header).");
    process.exit(1);
}

const databaseUrl = buildDatabaseUrl();
if (!databaseUrl) {
    console.error("Invalid database config: set DATABASE_URL or DB_HOST/DB_NAME/DB_USER/DB_PASSWORD.");
    process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const firstName = process.env.ADMIN_FIRST_NAME?.trim() || "Admin";
const lastName = process.env.ADMIN_LAST_NAME?.trim() || "User";

async function main() {
    const hash = await bcrypt.hash(adminPassword, 10);
    const user = await prisma.user.upsert({
        where: { email: adminEmail },
        create: {
            email: adminEmail,
            first_name: firstName,
            last_name: lastName,
            password: hash,
            role: "admin",
        },
        update: {
            password: hash,
            role: "admin",
            first_name: firstName,
            last_name: lastName,
        },
    });

    console.log("Admin user is ready.");
    console.log("  Email:   ", user.email);
    console.log("  Password: same value you set in ADMIN_PASSWORD");
    console.log("  Dashboard admin login: /admin/login");
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
        await pool.end();
    });
