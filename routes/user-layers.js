// src/backend/routes/user-layers.js
// Updated to store each feature in a FeatureCollection as a separate row with parent_layer_id
// Supports multiple drawings per layer and individual feature editing

const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid"); // For generating parent_layer_id

// Use JWT_SECRET from .env
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware to verify JWT and extract user_id
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "Access token required" });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        console.log('[user-layers.js] JWT decoded:', decoded);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ error: "Invalid or expired token" });
    }
};

// Utility function to validate GeoJSON (updated for FeatureCollection and single geometries)
const isValidGeoJSON = (geojson) => {
    try {
        if (!geojson || !geojson.type) return false;
        const validTypes = ["Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "FeatureCollection"];
        if (geojson.type === "FeatureCollection") {
            return geojson.features && Array.isArray(geojson.features) && geojson.features.every(feature =>
                feature.type === "Feature" && isValidGeoJSON(feature.geometry)
            );
        }
        return validTypes.includes(geojson.type);
    } catch (error) {
        return false;
    }
};

// Utility function to log history
const logHistory = async (layer, action, modifiedBy) => {
    const query = `
        INSERT INTO user_layers_history (
            layer_id, parent_layer_id, project_number, user_id, layer_name, layer_type, geometry, properties,
            is_visible, z_index, layer_type_group, crs, shared_with, modified_at, modified_by, action
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, $14, $15)
    `;
    await pool.query(query, [
        layer.id,
        layer.parent_layer_id,
        layer.project_number,
        layer.user_id,
        layer.layer_name,
        layer.layer_type,
        layer.geometry,
        layer.properties,
        layer.is_visible,
        layer.z_index,
        layer.layer_type_group,
        layer.crs,
        layer.shared_with,
        modifiedBy,
        action, // Include the action type
    ]);
};

// POST /api/user-layers - Create a new layer with multiple features as separate rows
router.post("/", authenticateToken, async (req, res) => {
    const {
        project_number,
        layer_name,
        layer_type,
        geometry, // Expects a FeatureCollection
        properties,
        is_visible = true,
        z_index = 0,
        layer_type_group,
        crs = "EPSG:4326",
        shared_with = {},
    } = req.body;
    const user_id = req.user.user_id;

    if (!project_number || !layer_name || !layer_type || !geometry) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    if (!["iso-concentration", "potentiometric", "utilities"].includes(layer_type)) {
        return res.status(400).json({ error: "Invalid layer_type" });
    }

    if (!isValidGeoJSON(geometry)) {
        return res.status(400).json({ error: "Invalid GeoJSON geometry" });
    }

    try {
        // Log the incoming request details
        console.log('[user-layers.js] POST /api/user-layers request:', {
            project_number,
            user_id,
            layer_name,
            layer_type,
            geometry_type: geometry.type,
            feature_count: geometry.type === "FeatureCollection" ? geometry.features.length : 1,
        });

        // Check for existing layers with the same layer_name, regardless of project_number and user_id
        const checkQuery = `
            SELECT project_number, user_id, layer_name
            FROM user_layers
            WHERE layer_name = $1
        `;
        const checkResult = await pool.query(checkQuery, [layer_name]);
        console.log('[user-layers.js] Existing layers with this name (any project/user):', {
            layer_name,
            existing_count: checkResult.rows.length,
            existing_layers: checkResult.rows,
        });

        // Check specifically for the current project_number and user_id
        const checkSpecificQuery = `
            SELECT project_number, user_id, layer_name
            FROM user_layers
            WHERE project_number = $1 AND user_id = $2 AND layer_name = $3
        `;
        const checkSpecificResult = await pool.query(checkSpecificQuery, [project_number, user_id, layer_name]);
        console.log('[user-layers.js] Existing layers with this name (specific project/user):', {
            project_number,
            user_id,
            layer_name,
            existing_count: checkSpecificResult.rows.length,
            existing_layers: checkSpecificResult.rows,
        });

        const parent_layer_id = uuidv4(); // Generate unique parent_layer_id for this layer
        const features = geometry.type === "FeatureCollection" ? geometry.features : [{ type: "Feature", geometry, properties: properties || {} }];
        const insertedLayers = [];

        // Insert each feature as a separate row
        for (const feature of features) {
            if (!isValidGeoJSON(feature.geometry)) {
                console.log('[user-layers.js] Skipping invalid feature:', feature);
                continue; // Skip invalid features
            }
            const query = `
                INSERT INTO user_layers (
                    parent_layer_id, project_number, user_id, layer_name, layer_type, geometry, properties,
                    is_visible, z_index, layer_type_group, crs, shared_with
                ) VALUES (
                    $1, $2, $3, $4, $5, ST_GeomFromGeoJSON($6), $7, $8, $9, $10, $11, $12
                ) RETURNING *, ST_AsGeoJSON(geometry) AS geojson
            `;
            const result = await pool.query(query, [
                parent_layer_id,
                project_number,
                user_id,
                layer_name,
                layer_type,
                JSON.stringify(feature.geometry),
                feature.properties || properties || {},
                is_visible,
                z_index,
                layer_type_group,
                crs,
                shared_with,
            ]);

            const newLayer = result.rows[0];
            newLayer.geometry = JSON.parse(newLayer.geojson);
            delete newLayer.geojson;
            insertedLayers.push(newLayer);

            await logHistory(newLayer, "create", user_id);
        }

        if (insertedLayers.length === 0) {
            return res.status(400).json({ error: "No valid features to insert" });
        }

        const io = req.app.get("io");
        insertedLayers.forEach(layer => io.emit("layerCreated", layer));

        // Return a single layer object with all features as a FeatureCollection
        const layerResponse = {
            parent_layer_id,
            layer_name,
            layer_type,
            project_number,
            user_id,
            is_visible,
            z_index,
            layer_type_group,
            crs,
            shared_with,
            geometry: {
                type: "FeatureCollection",
                features: insertedLayers.map(layer => ({
                    type: "Feature",
                    geometry: layer.geometry,
                    properties: layer.properties
                }))
            },
            ids: insertedLayers.map(layer => layer.id) // Include individual feature IDs for editing
        };

        res.json({ data: layerResponse, error: null });
    } catch (error) {
        if (error.code === "23505") {
            console.error('[user-layers.js] Unique constraint violation:', {
                project_number,
                user_id,
                layer_name,
                error: error.message,
            });
            return res.status(409).json({ error: "Layer name already exists for this user and project" });
        }
        console.error('[user-layers.js] POST /api/user-layers error:', error);
        res.status(500).json({ error: "Failed to create layer: " + error.message });
    }
});

// GET /api/user-layers - Retrieve layers for a user and project, grouped by parent_layer_id
router.get("/", authenticateToken, async (req, res) => {
    const { project_number } = req.query;
    const user_id = req.user.user_id;

    if (!project_number) {
        return res.status(400).json({ error: "Missing project_number parameter" });
    }

    try {
        console.log('[user-layers.js] GET /api/user-layers request:', { project_number, user_id });
        const query = `
            SELECT *, ST_AsGeoJSON(geometry) AS geojson
            FROM user_layers
            WHERE project_number = $1 AND user_id = $2
            ORDER BY parent_layer_id, created_at
        `;
        const result = await pool.query(query, [project_number, user_id]);
        console.log('[user-layers.js] Fetched layers:', { count: result.rows.length });

        // Group layers by parent_layer_id
        const layersByParent = result.rows.reduce((acc, row) => {
            const layer = { ...row, geometry: JSON.parse(row.geojson) };
            delete layer.geojson;
            const parentId = layer.parent_layer_id || layer.id; // Fallback for legacy layers
            if (!acc[parentId]) {
                acc[parentId] = {
                    parent_layer_id: parentId,
                    layer_name: layer.layer_name,
                    layer_type: layer.layer_type,
                    project_number: layer.project_number,
                    user_id: layer.user_id,
                    is_visible: layer.is_visible,
                    z_index: layer.z_index,
                    layer_type_group: layer.layer_type_group,
                    crs: layer.crs,
                    shared_with: layer.shared_with,
                    geometry: {
                        type: "FeatureCollection",
                        features: []
                    },
                    ids: []
                };
            }
            acc[parentId].geometry.features.push({
                type: "Feature",
                geometry: layer.geometry,
                properties: layer.properties
            });
            acc[parentId].ids.push(layer.id);
            return acc;
        }, {});

        const layers = Object.values(layersByParent);

        res.json({ data: layers, error: null });
    } catch (error) {
        console.error('[user-layers.js] GET /api/user-layers error:', error);
        res.status(500).json({ error: "Failed to fetch layers: " + error.message });
    }
});

// PUT /api/user-layers/:id - Update a single feature
router.put("/:id", authenticateToken, async (req, res) => {
    const { id } = req.params;
    const {
        layer_name,
        layer_type,
        geometry, // Expect a single geometry or Feature
        properties,
        is_visible,
        z_index,
        layer_type_group,
        crs,
        shared_with,
        project_number,
    } = req.body;
    const user_id = req.user.user_id;

    if (!project_number) {
        return res.status(400).json({ error: "Missing project_number" });
    }

    if (geometry && !isValidGeoJSON(geometry)) {
        return res.status(400).json({ error: "Invalid GeoJSON geometry" });
    }

    if (layer_type && !["iso-concentration", "potentiometric", "utilities"].includes(layer_type)) {
        return res.status(400).json({ error: "Invalid layer_type" });
    }

    try {
        console.log('[user-layers.js] PUT /api/user-layers/:id request:', { id, project_number, user_id, layer_name });
        const existingQuery = `
            SELECT *, ST_AsGeoJSON(geometry) AS geojson
            FROM user_layers WHERE id = $1 AND user_id = $2 AND project_number = $3
        `;
        const existingResult = await pool.query(existingQuery, [id, user_id, project_number]);

        if (existingResult.rows.length === 0) {
            return res.status(404).json({ error: "Feature not found or unauthorized" });
        }

        const existingLayer = existingResult.rows[0];
        existingLayer.geometry = JSON.parse(existingLayer.geojson);
        delete existingLayer.geojson;

        await logHistory(existingLayer, "update", user_id);

        // Build dynamic update query
        const fields = [];
        const values = [];
        let paramIndex = 1;

        if (layer_name) {
            // Check for existing layers with the new layer_name
            const checkQuery = `
                SELECT project_number, user_id, layer_name
                FROM user_layers
                WHERE layer_name = $1 AND project_number = $2 AND user_id = $3 AND id != $4
            `;
            const checkResult = await pool.query(checkQuery, [layer_name, project_number, user_id, id]);
            console.log('[user-layers.js] Existing layers with new name on update:', {
                layer_name,
                project_number,
                user_id,
                existing_count: checkResult.rows.length,
                existing_layers: checkResult.rows,
            });
            if (checkResult.rows.length > 0) {
                return res.status(409).json({ error: "Layer name already exists for this user and project" });
            }
            fields.push(`layer_name = $${paramIndex++}`);
            values.push(layer_name);
        }
        if (layer_type) {
            fields.push(`layer_type = $${paramIndex++}`);
            values.push(layer_type);
        }
        if (geometry) {
            fields.push(`geometry = ST_GeomFromGeoJSON($${paramIndex++})`);
            values.push(JSON.stringify(geometry.type === "Feature" ? geometry.geometry : geometry));
        }
        if (properties) {
            fields.push(`properties = $${paramIndex++}`);
            values.push(properties);
        }
        if (is_visible !== undefined) {
            fields.push(`is_visible = $${paramIndex++}`);
            values.push(is_visible);
        }
        if (z_index !== undefined) {
            fields.push(`z_index = $${paramIndex++}`);
            values.push(z_index);
        }
        if (layer_type_group) {
            fields.push(`layer_type_group = $${paramIndex++}`);
            values.push(layer_type_group);
        }
        if (crs) {
            fields.push(`crs = $${paramIndex++}`);
            values.push(crs);
        }
        if (shared_with) {
            fields.push(`shared_with = $${paramIndex++}`);
            values.push(shared_with);
        }
        fields.push(`updated_at = CURRENT_TIMESTAMP`);

        if (fields.length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        const query = `
            UPDATE user_layers
            SET ${fields.join(", ")}
            WHERE id = $${paramIndex++} AND user_id = $${paramIndex++} AND project_number = $${paramIndex++}
            RETURNING *, ST_AsGeoJSON(geometry) AS geojson
        `;
        values.push(id, user_id, project_number);

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Feature not found or unauthorized" });
        }

        const updatedLayer = result.rows[0];
        updatedLayer.geometry = JSON.parse(updatedLayer.geojson);
        delete updatedLayer.geojson;

        const io = req.app.get("io");
        io.emit("layerUpdated", updatedLayer);

        res.json({ data: updatedLayer, error: null });
    } catch (error) {
        if (error.code === "23505") {
            console.error('[user-layers.js] Unique constraint violation on update:', {
                id,
                project_number,
                user_id,
                layer_name,
                error: error.message,
            });
            return res.status(409).json({ error: "Layer name already exists for this user and project" });
        }
        console.error('[user-layers.js] PUT /api/user-layers/:id error:', error);
        res.status(500).json({ error: "Failed to update layer: " + error.message });
    }
});

// DELETE /api/user-layers/:id - Delete a single feature or all features for a parent_layer_id
router.delete("/:id", authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { project_number, parent_layer_id } = req.query;
    const user_id = req.user.user_id;

    if (!project_number) {
        return res.status(400).json({ error: "Missing project_number" });
    }

    try {
        console.log('[user-layers.js] DELETE /api/user-layers/:id request:', { id, parent_layer_id, project_number, user_id });
        let deletedIds = [];
        let query, values;

        if (parent_layer_id) {
            // Delete all features for the parent_layer_id
            query = `
                SELECT * FROM user_layers
                WHERE parent_layer_id = $1 AND user_id = $2 AND project_number = $3
            `;
            const existingResult = await pool.query(query, [parent_layer_id, user_id, project_number]);

            if (existingResult.rows.length === 0) {
                console.log('[user-layers.js] No layers found to delete:', { parent_layer_id, user_id, project_number });
                return res.status(404).json({ error: "Layer not found or unauthorized" });
            }

            console.log('[user-layers.js] Layers to delete:', {
                parent_layer_id,
                user_id,
                project_number,
                count: existingResult.rows.length,
                layers: existingResult.rows.map(row => ({ id: row.id, layer_name: row.layer_name })),
            });

            for (const layer of existingResult.rows) {
                await logHistory(layer, "delete", user_id);
            }

            query = `
                DELETE FROM user_layers
                WHERE parent_layer_id = $1 AND user_id = $2 AND project_number = $3
                RETURNING id
            `;
            values = [parent_layer_id, user_id, project_number];
        } else {
            // Delete a single feature
            query = `
                SELECT * FROM user_layers
                WHERE id = $1 AND user_id = $2 AND project_number = $3
            `;
            const existingResult = await pool.query(query, [id, user_id, project_number]);

            if (existingResult.rows.length === 0) {
                console.log('[user-layers.js] No feature found to delete:', { id, user_id, project_number });
                return res.status(404).json({ error: "Feature not found or unauthorized" });
            }

            const layer = existingResult.rows[0];
            console.log('[user-layers.js] Feature to delete:', {
                id,
                user_id,
                project_number,
                layer_name: layer.layer_name,
            });

            await logHistory(layer, "delete", user_id);

            query = `
                DELETE FROM user_layers
                WHERE id = $1 AND user_id = $2 AND project_number = $3
                RETURNING id
            `;
            values = [id, user_id, project_number];
        }

        const result = await pool.query(query, values);
        deletedIds = result.rows.map(row => row.id);
        console.log('[user-layers.js] Deleted rows:', deletedIds, { parent_layer_id, user_id, project_number });

        if (deletedIds.length === 0) {
            return res.status(404).json({ error: "Feature or layer not found or unauthorized" });
        }

        const io = req.app.get("io");
        deletedIds.forEach(deletedId => io.emit("layerDeleted", { id: deletedId, project_number, user_id }));

        res.json({ data: { ids: deletedIds }, error: null });
    } catch (error) {
        console.error('[user-layers.js] DELETE /api/user-layers/:id error:', error);
        res.status(500).json({ error: "Failed to delete layer: " + error.message });
    }
});

module.exports = router;