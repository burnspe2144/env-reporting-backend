const bcrypt = require('bcrypt');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('sslmode') ? { rejectUnauthorized: false } : false
});

async function hashPasswords() {
    const saltRounds = 10;
    try {
        const users = await pool.query('SELECT id, username, password FROM public.users');
        console.log(`Found ${users.rows.length} users`);

        for (const user of users.rows) {
            if (user.password.startsWith('$2b$')) {
                console.log(`User ${user.username} (ID: ${user.id}) already has hashed password`);
                continue;
            }

            const hashedPassword = await bcrypt.hash(user.password, saltRounds);
            await pool.query(
                'UPDATE public.users SET password = $1 WHERE id = $2',
                [hashedPassword, user.id]
            );
            console.log(`Hashed password for user ${user.username} (ID: ${user.id})`);
        }
        console.log('Password migration complete');
    } catch (error) {
        console.error('Error during password migration:', error.message, error.stack);
    } finally {
        await pool.end();
    }
}

hashPasswords();