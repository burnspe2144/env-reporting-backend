const express = require("express");
const router = express.Router();
const ee = require("@google/earthengine");
const { authenticateGEE } = require("../utils/geeAuth");

let privateKey;
try {
    if (!process.env.GEE_PRIVATE_KEY) {
        throw new Error("GEE_PRIVATE_KEY is not defined in .env");
    }
    privateKey = JSON.parse(process.env.GEE_PRIVATE_KEY);
} catch (error) {
    console.error("Failed to parse GEE_PRIVATE_KEY:", error.message);
    process.exit(1);
}

router.get("/auth", (req, res) => {
    authenticateGEE(privateKey)
        .then(() => res.json({ success: true, message: "GEE authenticated" }))
        .catch(err => res.status(500).json({ error: "GEE auth failed: " + err }));
});

router.get("/tile", async (req, res) => {
    const { lat, lon } = req.query;
    if (!lat || !lon) {
        return res.status(400).json({ error: "Missing lat or lon parameters" });
    }
    try {
        const startTime = Date.now();
        console.log(`Starting GEE tile request for lat: ${lat}, lon: ${lon}`);
        const latNum = parseFloat(lat);
        const lonNum = parseFloat(lon);
        const bbox = ee.Geometry.Rectangle([lonNum - 0.5, latNum - 0.5, lonNum + 0.5, latNum + 0.5]);

        let image = ee.ImageCollection("LANDSAT/LC08/C02/T1_TOA")
            .filterBounds(bbox)
            .filterDate("2020-01-01", "2025-03-16")
            .sort("CLOUD_COVER")
            .first();
        let imageInfo = await image.getInfo();

        if (!imageInfo) {
            console.log("No Landsat TOA imagery, trying Sentinel-2...");
            image = ee.ImageCollection("COPERNICUS/S2")
                .filterBounds(bbox)
                .filterDate("2020-01-01", "2025-03-16")
                .sort("CLOUDY_PIXEL_PERCENTAGE")
                .first();
            imageInfo = await image.getInfo();
            if (!imageInfo) {
                console.log("No Sentinel-2 imagery, trying MODIS...");
                image = ee.ImageCollection("MODIS/006/MOD09GA")
                    .filterBounds(bbox)
                    .filterDate("2020-01-01", "2025-03-16")
                    .sort("system:time_start")
                    .first();
                imageInfo = await image.getInfo();
                if (!imageInfo) {
                    return res.status(404).json({ error: "No imagery available for this location" });
                }
            }
        }

        console.log("Using image ID:", imageInfo.id);
        const visParams = imageInfo.id.includes("LANDSAT/LC08")
            ? { bands: ["B4", "B3", "B2"], min: 0.02, max: 0.3, gamma: 1.3 }
            : imageInfo.id.includes("COPERNICUS/S2")
                ? { bands: ["B4", "B3", "B2"], min: 0, max: 3000, gamma: 1.5 }
                : { bands: ["sur_refl_b01", "sur_refl_b04", "sur_refl_b03"], min: 0, max: 3000, gamma: 1.5 };

        const mapId = await image.getMapId(visParams);
        const tileUrl = `https://earthengine.googleapis.com/v1alpha/${mapId.mapid}/tiles/{z}/{x}/{y}`;
        console.log("Generated tile URL template:", tileUrl);
        console.log(`GEE tile request completed in ${Date.now() - startTime}ms`);
        res.json({ tileUrl });
    } catch (error) {
        console.error("Error generating GEE tile URL:", error);
        res.status(500).json({ error: "Failed to generate GEE tile URL: " + error.message });
    }
});

module.exports = router;