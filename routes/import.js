const express = require("express");
const router = express.Router();
const exceljs = require("exceljs");
const fs = require("fs");
const path = require("path");
const { pool } = require("../config/db"); // Updated to use shared pool from config/db.js
const multer = require("multer");
const upload = multer({ dest: "uploads/" }); // Temporary storage

// Helper to validate row data against required fields
const validateRow = (row, tabName) => {
    const requiredFields = {
        projects: ["project_number", "project_name", "start_date"],
        locations: ["sample_location", "project_number"],
        lab_results: ["project_number", "sample_location", "sample_id", "lab_id", "collected_date", "cas", "parameter", "results", "unit", "matrix", "method"],
    };
    const errors = [];
    requiredFields[tabName].forEach(field => {
        if (!row[field] && row[field] !== 0) { // Allow 0 as valid
            errors.push(`Row: ${field} is missing. Please check your '${tabName}' tab.`);
        }
    });
    return errors;
};

// Route to handle Excel file upload and import
router.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file || path.extname(req.file.originalname) !== ".xlsx") {
        return res.status(400).json({ error: "Please upload a valid .xlsx file" });
    }
    const uploadId = Date.now().toString(); // Unique ID for this import
    const filePath = req.file.path;
    const workbook = new exceljs.Workbook();
    const failedRows = [];
    let rowCount = 0;

    try {
        // Log import start
        await pool.query("INSERT INTO import_logs (upload_id, timestamp) VALUES ($1, NOW())", [uploadId]);

        // Stream the Excel file
        await workbook.xlsx.read(fs.createReadStream(filePath));
        const tabs = ["projects", "locations", "lab_results"];

        for (const tabName of tabs) {
            const worksheet = workbook.getWorksheet(tabName);
            if (!worksheet) {
                return res.status(400).json({ error: `Missing '${tabName}' tab in Excel file` });
            }

            const batchSize = 500;
            let batch = [];
            let rowNumber = 2; // Skip header row
            const rows = [];

            // Collect all rows first
            worksheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
                if (rowNum === 1) return; // Skip header

                const rowData = {};
                row.eachCell({ includeEmpty: true }, (cell, colNum) => {
                    const header = worksheet.getRow(1).getCell(colNum).value?.toLowerCase();
                    if (header) rowData[header] = cell.value;
                });

                rows.push({ rowData, rowNumber: rowNumber++ });
            });

            // Process rows in batches
            for (const { rowData, rowNumber } of rows) {
                const errors = validateRow(rowData, tabName);
                if (errors.length > 0) {
                    failedRows.push({ upload_id: uploadId, tab_name: tabName, row_number: rowNumber, error_message: errors.join("; ") });
                    continue;
                }

                batch.push(rowData);
                rowCount++;

                if (batch.length >= batchSize) {
                    await processBatch(tabName, batch, uploadId);
                    batch = [];
                }
            }

            // Process remaining rows
            if (batch.length > 0) {
                await processBatch(tabName, batch, uploadId);
            }
        }

        // Log failed rows
        if (failedRows.length > 0) {
            await pool.query(
                "INSERT INTO failed_imports (upload_id, tab_name, row_number, error_message, timestamp) VALUES " +
                failedRows.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, NOW())`).join(","),
                failedRows.flatMap(r => [r.upload_id, r.tab_name, r.row_number, r.error_message])
            );
        }

        res.json({
            uploadId,
            message: `Imported ${rowCount} rows successfully`,
            failedCount: failedRows.length,
        });

    } catch (error) {
        console.error("Detailed error during import:", error);
        res.status(500).json({ error: "Internal Server Error: " + error.message });
    } finally {
        await require("fs").promises.unlink(filePath);
    }
});

// Process batch insert with upsert logic
async function processBatch(tabName, batch, uploadId) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        if (tabName === "projects") {
            const query = `
                INSERT INTO projects (project_number, project_name, client_name, start_date, end_date, project_description)
                VALUES ${batch.map((_, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`).join(",")}
                ON CONFLICT (project_number) DO UPDATE
                SET project_name = EXCLUDED.project_name, client_name = EXCLUDED.client_name,
                    start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
                    project_description = EXCLUDED.project_description
            `;
            const values = batch.flatMap(row => [
                row.project_number, row.project_name, row.client_name,
                row.start_date, row.end_date, row.project_description
            ]);
            await client.query(query, values);
        } else if (tabName === "locations") {
            const query = `
                INSERT INTO locations (sample_location, project_number, location_type, latitude, longitude, elevation, depth)
                VALUES ${batch.map((_, i) => `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`).join(",")}
                ON CONFLICT (sample_location, project_number) DO NOTHING
            `;
            const values = batch.flatMap(row => [
                row.sample_location, row.project_number, row.location_type,
                row.latitude, row.longitude, row.elevation, row.depth
            ]);
            await client.query(query, values);
        } else if (tabName === "lab_results") {
            const query = `
                INSERT INTO lab_results (project_number, sample_location, sample_id, lab_id, depth_1, depth_2,
                    collected_date, cas, parameter, results, unit, matrix, method, quantitation_limit, chemical_class, qualifier)
                VALUES ${batch.map((_, i) => `($${i * 16 + 1}, $${i * 16 + 2}, $${i * 16 + 3}, $${i * 16 + 4}, $${i * 16 + 5}, $${i * 16 + 6}, $${i * 16 + 7}, $${i * 16 + 8}, $${i * 16 + 9}, $${i * 16 + 10}, $${i * 16 + 11}, $${i * 16 + 12}, $${i * 16 + 13}, $${i * 16 + 14}, $${i * 16 + 15}, $${i * 16 + 16})`).join(",")}
                -- ON CONFLICT (sample_id, cas, matrix, collected_date) DO UPDATE
                -- SET project_number = EXCLUDED.project_number, sample_location = EXCLUDED.sample_location,
                --     lab_id = EXCLUDED.lab_id, depth_1 = EXCLUDED.depth_1, depth_2 = EXCLUDED.depth_2,
                --     parameter = EXCLUDED.parameter, results = EXCLUDED.results, unit = EXCLUDED.unit,
                --     method = EXCLUDED.method, quantitation_limit = EXCLUDED.quantitation_limit,
                --     chemical_class = EXCLUDED.chemical_class, qualifier = EXCLUDED.qualifier
            `;
            const values = batch.flatMap(row => [
                row.project_number, row.sample_location, row.sample_id, row.lab_id,
                row.depth_1, row.depth_2, row.collected_date, row.cas, row.parameter,
                row.results, row.unit, row.matrix, row.method, row.quantitation_limit,
                row.chemical_class, row.qualifier
            ]);
            await client.query(query, values);
        }

        await client.query("COMMIT");

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

module.exports = router;