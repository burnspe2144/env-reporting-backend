const express = require("express");  // Import Express
const cors = require("cors");  // Import CORS for cross-origin requests
const pg = require("pg");  // Import PostgreSQL client
require("dotenv").config();  // Load environment variables

const app = express();  // ✅ Define the Express app
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL Client Setup
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,  // Required for Railway hosted PostgreSQL
    },
});

// ✅ Basic API Route
app.get("/", (req, res) => {
    res.send("Server is running!");
});

// ✅ API Route for Screening Levels
app.get("/screening_levels", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM screening_levels"); // Ensure this table exists
        res.json(result.rows);
    } catch (error) {
        console.error("Database query error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
