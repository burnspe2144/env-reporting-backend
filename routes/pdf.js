const express = require("express");
const router = express.Router();
const puppeteer = require("puppeteer");
const fs = require("fs");
const { pool } = require("../config/db");

router.get("/", async (req, res) => {
    console.log("Generating PDF with Puppeteer...");
    const { project, chemicalClass, media, excludePqlOnly } = req.query;
    if (!project || !chemicalClass || !media) {
        return res.status(400).json({ data: null, error: "Missing filter parameters" });
    }

    let browser;
    const pdfPath = "output.pdf";
    try {
        const joinedQuery = `
            SELECT
                lr.sample_id, lr.cas, lr.parameter AS chemical_name, lr.matrix,
                CASE
                    WHEN lr.results = 'ND' THEN '<' || COALESCE(NULLIF(CAST(lr.quantitation_limit AS TEXT), ''), 'PQL')
                    ELSE lr.results
                END AS formatted_results,
                lr.collected_date, lr.depth_1, lr.depth_2,
                sl.exposure_scenario, sl.screening_level
            FROM lab_results lr
            LEFT JOIN screening_levels sl
                ON lr.cas = sl.cas AND lr.matrix = sl.matrix
            WHERE lr.project_number = $1 AND lr.chemical_class = $2 AND lr.matrix = $3
            ORDER BY lr.sample_id, lr.cas, sl.exposure_scenario
        `;
        const result = await pool.query(joinedQuery, [project, chemicalClass, media]);
        if (result.rows.length === 0) {
            return res.status(404).json({ data: null, error: "No matching lab results found" });
        }

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
                        acc[r.exposure_scenario] = r.screening_level;
                    }
                    return acc;
                }, {})
            };
        });

        let chemicals = [...new Set(pivotedData.map(item => item.chemical_name))].sort();
        if (excludePqlOnly === "true") {
            chemicals = chemicals.filter(chem =>
                pivotedData.some(item => item.chemical_name === chem && !item.formatted_results.startsWith("<"))
            );
        }

        const samples = [...new Set(pivotedData.map(item => item.sample_id))];
        const screeningOptions = [...new Set(result.rows.map(r => r.exposure_scenario).filter(Boolean))];
        const screeningLevels = pivotedData.reduce((acc, item) => {
            const screening = item.screening_levels || {};
            Object.entries(screening).forEach(([scenario, level]) => {
                acc[scenario] = { ...acc[scenario], [item.chemical_name]: level };
            });
            return acc;
        }, {});

        const dataBySample = samples.map(sampleId => {
            const sampleData = pivotedData.filter(item => item.sample_id === sampleId);
            const row = { sample_id: sampleId };
            chemicals.forEach(chem => {
                const result = sampleData.find(item => item.chemical_name === chem);
                row[chem] = result ? result.formatted_results : "ND";
            });
            const firstSample = sampleData[0];
            row.collected_date = firstSample && firstSample.collected_date
                ? new Date(firstSample.collected_date).toISOString().split("T")[0]
                : "";
            row.depth_interval = firstSample ? `${firstSample.depth_1 || ""} - ${firstSample.depth_2 || ""}` : "";
            return row;
        });

        const parseLabResult = value => {
            if (!value || value === "ND") return null;
            if (value.startsWith("<")) return null;
            return parseFloat(value) || null;
        };

        const getExceedanceLevel = (chem, value) => {
            const numericValue = parseLabResult(value);
            if (numericValue === null) return 0;
            const levels = screeningOptions.map(scenario => screeningLevels[scenario]?.[chem]).filter(Boolean).map(parseFloat);
            return levels.filter(level => numericValue > level).length;
        };

        const columnsPerPage = 58;
        const chemicalChunks = [];
        for (let i = 0; i < chemicals.length; i += columnsPerPage) {
            chemicalChunks.push(chemicals.slice(i, i + columnsPerPage));
        }

        let html = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Calibri, Arial, sans-serif; margin: 30px; font-size: 16pt; -webkit-font-smoothing: antialiased; }
                    table { border-collapse: collapse; width: auto; table-layout: fixed; page-break-after: always; transform: translateZ(0); }
                    table:last-child { page-break-after: auto; }
                    th, td { border: 1px solid black; padding: 8px; text-align: center; overflow: hidden; white-space: nowrap; text-overflow: clip; box-sizing: border-box; line-height: 1.2; box-shadow: none; border-style: solid; }
                    th { background-color: lightskyblue; }
                    th.sample-id { width: 160px; }
                    th.sample-date { width: 133px; }
                    th.depth-interval { width: 160px; }
                    th.chemical { height: 200px; width: 96px; vertical-align: bottom; }
                    th.chemical div { transform: rotate(-90deg); transform-origin: center; width: 32px; margin: 0 auto; font-weight: bold; }
                    th.screening, td.screening { text-align: left; width: 453px; }
                    td.chemical-data { width: 96px; }
                    td.exceedance-2 { color: blue; font-weight: bold; }
                    td.exceedance-3 { color: red; font-weight: bold; }
                    td.exceedance-4 { background-color: yellow; color: red; font-weight: bold; }
                    tr.separator td { background-color: black; }
                    td.screening-level-3 { color: blue; font-weight: bold; }
                    td.screening-level-4 { color: red; font-weight: bold; }
                </style>
            </head>
            <body>
        `;

        chemicalChunks.forEach(chunk => {
            html += `
                <table>
                    <thead>
                        <tr>
                            <th class="sample-id">Sample ID</th>
                            <th class="sample-date">Sample Date</th>
                            <th class="depth-interval">Depth Interval</th>
                            ${chunk.map(chem => `<th class="chemical"><div>${chem}</div></th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${screeningOptions.map((scenario, idx) => `
                            <tr>
                                <td class="screening" colspan="3">${scenario}</td>
                                ${chunk.map(chem => {
                const level = screeningLevels[scenario]?.[chem] || "NP";
                const className = idx + 1 === 3 ? "screening-level-3" : idx + 1 >= 4 ? "screening-level-4" : "";
                return `<td class="chemical-data ${className}">${level}</td>`;
            }).join('')}
                            </tr>
                        `).join('')}
                        <tr class="separator">
                            <td colspan="3"></td>
                            ${chunk.map(() => `<td class="chemical-data"></td>`).join('')}
                        </tr>
                        ${dataBySample.map(row => `
                            <tr>
                                <td>${row.sample_id}</td>
                                <td>${row.collected_date}</td>
                                <td>${row.depth_interval}</td>
                                ${chunk.map(chem => {
                const result = row[chem];
                const exceedanceLevel = getExceedanceLevel(chem, result);
                let className = "chemical-data";
                if (exceedanceLevel === 2) className += " exceedance-2";
                else if (exceedanceLevel === 3) className += " exceedance-3";
                else if (exceedanceLevel >= 4) className += " exceedance-4";
                return `<td class="${className}">${result}</td>`;
            }).join('')}
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
        });

        html += `</body></html>`;

        browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
        const page = await browser.newPage();
        await page.setViewport({ width: 4224, height: 6528, deviceScaleFactor: 4 });
        await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });
        await page.pdf({
            path: pdfPath,
            width: "11in",
            height: "17in",
            landscape: true,
            margin: { top: "30px", right: "30px", bottom: "30px", left: "30px" },
            printBackground: true,
            preferCSSPageSize: false
        });

        const pdfBuffer = fs.readFileSync(pdfPath);
        res.setHeader("Content-Disposition", "attachment; filename=lab_results.pdf");
        res.setHeader("Content-Type", "application/pdf");
        res.send(pdfBuffer);
    } catch (error) {
        console.error("Error generating PDF with Puppeteer:", error.stack);
        res.status(500).json({ data: null, error: "Internal Server Error: " + error.message });
    } finally {
        if (browser) await browser.close();
        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    }
});

module.exports = router;