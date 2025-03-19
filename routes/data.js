const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");

router.get("/projects", async (req, res) => {
    try {
        const result = await pool.query("SELECT DISTINCT TRIM(project_number) AS project_number FROM lab_results ORDER BY project_number");
        console.log("Fetched projects:", result.rows);
        res.json({ data: result.rows, error: null });
    } catch (error) {
        console.error("Error fetching projects:", error.stack);
        res.status(500).json({ data: null, error: "Internal Server Error: " + error.message });
    }
});

router.get("/chemical-classes", async (req, res) => {
    try {
        const result = await pool.query("SELECT DISTINCT chemical_class FROM lab_results ORDER BY chemical_class");
        console.log("Fetched chemical classes:", result.rows);
        res.json({ data: result.rows, error: null });
    } catch (error) {
        console.error("Error fetching chemical classes:", error.stack);
        res.status(500).json({ data: null, error: "Internal Server Error: " + error.message });
    }
});

router.get("/media-types", async (req, res) => {
    try {
        const result = await pool.query("SELECT DISTINCT matrix FROM lab_results ORDER BY matrix");
        console.log("Fetched media types:", result.rows);
        res.json({ data: result.rows, error: null });
    } catch (error) {
        console.error("Error fetching media types:", error.stack);
        res.status(500).json({ data: null, error: "Internal Server Error: " + error.message });
    }
});

router.get("/screening-options", async (req, res) => {
    const { media } = req.query;
    if (!media) {
        return res.status(400).json({ data: null, error: "Missing media parameter" });
    }
    try {
        const query = `
            SELECT DISTINCT exposure_scenario, regulatory_agency
            FROM screening_levels
            WHERE matrix = $1
            ORDER BY exposure_scenario
        `;
        const result = await pool.query(query, [media]);
        console.log(`Screening options for media=${media}:`, result.rows);
        res.json({ data: result.rows, error: null });
    } catch (error) {
        console.error("Error fetching screening options:", error.stack);
        res.status(500).json({ data: null, error: "Internal Server Error: " + error.message });
    }
});

router.get("/lab-results", async (req, res) => {
    const { project, chemicalClass, media } = req.query;
    if (!project || !chemicalClass || !media) {
        return res.status(400).json({ data: null, error: "Missing filter parameters" });
    }
    try {
        const baseQuery = `
            SELECT
                sample_id, cas, parameter AS chemical_name, matrix,
                CASE
                    WHEN results = 'ND' THEN '<' || COALESCE(NULLIF(CAST(quantitation_limit AS TEXT), ''), 'PQL')
                    ELSE results
                END AS formatted_results,
                collected_date, depth_1, depth_2
            FROM lab_results
            WHERE project_number = $1 AND chemical_class = $2 AND matrix = $3
            ORDER BY sample_id, cas
        `;
        const baseResult = await pool.query(baseQuery, [project, chemicalClass, media]);
        if (baseResult.rows.length === 0) {
            return res.status(404).json({ data: null, error: "No matching lab results found" });
        }

        const joinedQuery = `
            SELECT
                lr.sample_id, lr.cas, lr.parameter AS chemical_name, lr.matrix,
                CASE
                    WHEN lr.results = 'ND' THEN '<' || COALESCE(NULLIF(CAST(quantitation_limit AS TEXT), ''), 'PQL')
                    ELSE lr.results
                END AS formatted_results,
                lr.collected_date, lr.depth_1, lr.depth_2,
                sl.exposure_scenario, sl.screening_level, sl.regulatory_agency
            FROM lab_results lr
            LEFT JOIN screening_levels sl
                ON lr.cas = sl.cas AND lr.matrix = sl.matrix
            WHERE lr.project_number = $1 AND lr.chemical_class = $2 AND lr.matrix = $3
            ORDER BY lr.sample_id, lr.cas, sl.exposure_scenario
        `;
        const result = await pool.query(joinedQuery, [project, chemicalClass, media]);

        console.log(`Query Parameters: project=${project}, chemicalClass=${chemicalClass}, media=${media}`);
        console.log("Base Query Results:", baseResult.rows.length);
        console.log("Joined Query Results:", result.rows.length);

        const pivotedData = baseResult.rows.map(row => {
            const matchingScreening = result.rows.filter(
                r => r.sample_id === row.sample_id && r.cas === row.cas && r.chemical_name === row.chemical_name
            );
            return {
                sample_id: row.sample_id,
                cas: row.cas,
                chemical_name: row.chemical_name,
                matrix: row.matrix,
                formatted_results: row.formatted_results,
                collected_date: row.collected_date,
                depth_1: row.depth_1,
                depth_2: row.depth_2,
                screening_levels: matchingScreening.reduce((acc, r) => {
                    if (r.exposure_scenario && r.screening_level !== null) {
                        acc[r.exposure_scenario] = {
                            level: r.screening_level,
                            regulatory_agency: r.regulatory_agency || "Unknown Agency"
                        };
                    }
                    return acc;
                }, {})
            };
        });

        res.json({ data: pivotedData, error: null });
    } catch (error) {
        console.error("Error fetching lab results:", error.stack);
        res.status(500).json({ data: null, error: "Internal Server Error: " + error.message });
    }
});

// Updated endpoint with simplified and corrected COPC query
router.get("/project/:projectNumber", async (req, res) => {
    const { projectNumber } = req.params;
    if (!projectNumber) {
        return res.status(400).json({ data: null, error: "Missing project number parameter" });
    }
    try {
        const projectQuery = `
            SELECT 
                project_number,
                project_name,
                client_name,
                start_date,
                end_date,
                project_description
            FROM projects
            WHERE project_number = $1
        `;
        const projectResult = await pool.query(projectQuery, [projectNumber]);

        const labQuery = `
            SELECT 
                project_number,
                COUNT(DISTINCT sample_id) AS total_samples,
                COUNT(DISTINCT chemical_class) AS chemical_classes,
                COUNT(DISTINCT matrix) AS media_types,
                MIN(collected_date) AS earliest_date,
                MAX(collected_date) AS latest_date,
                MIN(depth_1) AS min_depth,
                MAX(depth_2) AS max_depth
            FROM lab_results
            WHERE project_number = $1
            GROUP BY project_number
        `;
        const labResult = await pool.query(labQuery, [projectNumber]);

        const copcQuery = `
            SELECT 
                lr.parameter AS chemical_name,
                lr.matrix,
                MAX(CASE 
                    WHEN lr.results = 'ND' THEN NULL
                    WHEN lr.results LIKE '<%' THEN NULL
                    ELSE CAST(lr.results AS FLOAT)
                END) AS max_result,
                COALESCE(
                    json_object_agg(
                        COALESCE(sl.exposure_scenario, 'Unknown'),
                        COALESCE(sl.screening_level, 0)
                    ) FILTER (WHERE sl.exposure_scenario IS NOT NULL AND sl.screening_level IS NOT NULL),
                    '{}'::json
                ) AS screening_levels
            FROM lab_results lr
            LEFT JOIN screening_levels sl ON lr.cas = sl.cas AND lr.matrix = sl.matrix
            WHERE lr.project_number = $1
            GROUP BY lr.parameter, lr.matrix
            HAVING MAX(CASE 
                WHEN lr.results = 'ND' THEN NULL
                WHEN lr.results LIKE '<%' THEN NULL
                ELSE CAST(lr.results AS FLOAT)
            END) IS NOT NULL
        `;
        const copcResult = await pool.query(copcQuery, [projectNumber]);

        const copcs = copcResult.rows
            .map(row => {
                const maxResult = row.max_result;
                const screeningLevels = row.screening_levels || {};
                if (Object.keys(screeningLevels).length === 0) {
                    return null;
                }
                const exceedances = Object.entries(screeningLevels)
                    .filter(([scenario, level]) => level !== null && level !== undefined && !isNaN(parseFloat(level)))
                    .map(([scenario, level]) => ({
                        scenario,
                        level: parseFloat(level),
                        exceeds: maxResult > parseFloat(level)
                    }))
                    .filter(item => item.exceeds);

                return {
                    chemical_name: row.chemical_name,
                    matrix: row.matrix,
                    max_result: maxResult,
                    exceedances: exceedances.length > 0 ? exceedances : null
                };
            })
            .filter(row => row !== null && row.exceedances);

        const projectDetails = projectResult.rows[0] || {};
        const labDetails = labResult.rows[0] || {};
        const combinedDetails = {
            project_number: projectDetails.project_number || projectNumber,
            project_name: projectDetails.project_name || "Unknown Project",
            client_name: projectDetails.client_name || "Unknown Client",
            start_date: projectDetails.start_date || null,
            end_date: projectDetails.end_date || null,
            project_description: projectDetails.project_description || "No description available",
            total_samples: labDetails.total_samples || 0,
            chemical_classes: labDetails.chemical_classes || 0,
            media_types: labDetails.media_types || 0,
            earliest_date: labDetails.earliest_date || null,
            latest_date: labDetails.latest_date || null,
            min_depth: labDetails.min_depth || null,
            max_depth: labDetails.max_depth || null,
            constituents_of_potential_concern: copcs.length > 0 ? copcs : []
        };

        console.log(`Fetched details for project ${projectNumber}:`, combinedDetails);
        res.json({ data: combinedDetails, error: null });
    } catch (error) {
        console.error(`Error fetching details for project ${projectNumber}:`, error.stack);
        res.status(500).json({ data: null, error: "Internal Server Error: " + error.message });
    }
});

module.exports = router;