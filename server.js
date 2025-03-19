const express = require("express");
const cors = require("cors");
require("dotenv").config({ path: __dirname + '/.env' });

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
const geeRoutes = require("./routes/gee");
const dataRoutes = require("./routes/data");
const pdfRoutes = require("./routes/pdf");
const importRoutes = require("./routes/import");
const figureRoutes = require("./routes/figures"); // Ensure this is included

app.use("/api/gee", geeRoutes);
app.use("/api/data", dataRoutes);
app.use("/api/lab-results/pdf", pdfRoutes);
app.use("/api/import", importRoutes);
app.use("/api/figures", figureRoutes); // Mount the figures route

// Root endpoint
app.get("/", (req, res) => {
  res.json({ data: "Server is running!", error: null });
});

// Debug environment variables
console.log("Environment variables loaded:");
console.log("DATABASE_URL:", process.env.DATABASE_URL);
console.log("PORT:", process.env.PORT);
console.log("GEE_PRIVATE_KEY:", process.env.GEE_PRIVATE_KEY ? "Loaded" : "Not loaded");

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});