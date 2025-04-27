const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const JWT_SECRET = process.env.JWT_SECRET;

router.post("/login", async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        console.warn('[auth.js] Login attempt missing credentials:', { username });
        return res.status(400).json({ data: null, error: "Missing username or password" });
    }

    try {
        console.log('[auth.js] Login attempt:', { username });

        const query = `
            SELECT id, username, password, role
            FROM public.users
            WHERE username = $1
        `;
        const result = await pool.query(query, [username]);

        if (result.rows.length === 0) {
            console.log('[auth.js] User not found:', { username });
            return res.status(401).json({ data: null, error: "Invalid username or password" });
        }

        const user = result.rows[0];
        console.log('[auth.js] User found:', { user_id: user.id, username: user.username, role: user.role });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            console.log('[auth.js] Password mismatch for user:', { username });
            return res.status(401).json({ data: null, error: "Invalid username or password" });
        }

        const tokenPayload = { user_id: user.id, username: user.username, role: user.role };
        const token = jwt.sign(
            tokenPayload,
            JWT_SECRET,
            { expiresIn: "1h" }
        );

        console.log('[auth.js] Token generated:', { tokenPayload, expiresIn: "1h" });

        res.json({
            data: { token, user_id: user.id, username: user.username, role: user.role },
            error: null
        });
    } catch (error) {
        console.error('[auth.js] Login error:', error.message);
        res.status(500).json({ data: null, error: "Failed to authenticate: " + error.message });
    }
});

// New endpoint to validate JWT token
router.get("/validate", (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Expect Bearer <token>

    if (!token) {
        console.warn('[auth.js] No token provided for validation');
        return res.status(401).json({ data: null, error: "No token provided" });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        console.log('[auth.js] Token validated:', {
            user_id: decoded.user_id,
            username: decoded.username,
            role: decoded.role
        });
        res.json({
            data: {
                valid: true,
                user_id: decoded.user_id,
                username: decoded.username,
                role: decoded.role
            },
            error: null
        });
    } catch (err) {
        console.error('[auth.js] Token validation failed:', {
            error: err.message,
            tokenLength: token.length
        });
        res.status(401).json({ data: null, error: "Invalid or expired token" });
    }
});

module.exports = router;