const express = require('express');
const router = express.Router();
const DirectoryManager = require('../modules/directoryManager');
const ErrorLogger = require('../modules/errorLogger');
const GEEIntegration = require('../modules/geeIntegration');
const SaveManager = require('../modules/saveManager');

// GET /api/figures - List all figures
router.get('/', async (req, res) => {
    const { projectId } = req.query;
    try {
        const files = await DirectoryManager.getDirContents(projectId);
        const figures = files.map(file => {
            const [figureNumber, ...nameParts] = file.split('_');
            const name = nameParts.join('_').replace(/\.(png|json)$/, '');
            return {
                id: file,
                figureNumber: figureNumber.replace('Figure_', ''),
                name,
                editable: file.endsWith('.json'),
                creationDate: new Date().toISOString(), // Placeholder; use fs.stat for real date
            };
        });
        res.json({ data: figures });
    } catch (error) {
        ErrorLogger.logError(`Failed to list figures: ${error.message}`, 'ERROR');
        res.status(500).json({ error: 'Failed to fetch figures' });
    }
});

// DELETE /api/figures/:id - Delete a figure
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const { projectId } = req.query;
    try {
        const baseName = id.replace(/\.(png|json)$/, ''); // Strip extension
        const jsonPath = DirectoryManager.createPath(projectId, `${baseName}.json`);
        const pngPath = DirectoryManager.createPath(projectId, `${baseName}.png`);
        await Promise.all([
            DirectoryManager.deleteFile(jsonPath),
            DirectoryManager.deleteFile(pngPath),
        ]);
        res.json({ message: `Deleted figure ${id}` });
    } catch (error) {
        ErrorLogger.logError(`Failed to delete figure ${id}: ${error.message}`, 'ERROR');
        res.status(500).json({ error: 'Failed to delete figure' });
    }
});

// POST /api/figures/bulk - Bulk delete
router.post('/bulk', async (req, res) => {
    const { projectId, action, ids } = req.body;
    if (action !== 'delete' || !ids.length) {
        return res.status(400).json({ error: 'Invalid action or no IDs provided' });
    }
    try {
        await Promise.all(ids.map(id => {
            const baseName = id.replace(/\.(png|json)$/, '');
            const jsonPath = DirectoryManager.createPath(projectId, `${baseName}.json`);
            const pngPath = DirectoryManager.createPath(projectId, `${baseName}.png`);
            return Promise.all([
                DirectoryManager.deleteFile(jsonPath),
                DirectoryManager.deleteFile(pngPath),
            ]);
        }));
        res.json({ message: `Deleted ${ids.length} figure(s)` });
    } catch (error) {
        ErrorLogger.logError(`Bulk delete failed: ${error.message}`, 'ERROR');
        res.status(500).json({ error: 'Bulk delete failed' });
    }
});

// GET /api/figures/refresh - Force directory scan
router.get('/refresh', async (req, res) => {
    const { projectId } = req.query;
    try {
        await DirectoryManager.ensureDir(projectId); // Just ensures dir exists
        res.json({ message: 'Directory refreshed' });
    } catch (error) {
        ErrorLogger.logError(`Refresh failed: ${error.message}`, 'ERROR');
        res.status(500).json({ error: 'Refresh failed' });
    }
});

// GET /api/figures/tile - Fetch GEE tile URL
router.get('/tile', async (req, res) => {
    const { baseMapType } = req.query;
    try {
        const tileUrl = await GEEIntegration.getTileUrl(baseMapType || 'topo');
        res.json({ tileUrl });
    } catch (error) {
        ErrorLogger.logError(`Failed to fetch GEE tile: ${error.message}`, 'ERROR');
        res.status(500).json({ error: 'Failed to fetch GEE tiles' });
    }
});

// POST /api/figures - Save a new figure
router.post('/', async (req, res) => {
    const { projectId, metadata, mapState } = req.body;
    console.log('Received POST /api/figures:', { projectId, metadata, mapState }); // Debug
    try {
        if (!projectId || !metadata || !mapState) {
            return res.status(400).json({ error: 'Missing required fields: projectId, metadata, or mapState' });
        }
        const paths = await SaveManager.saveFigure(projectId, metadata, mapState);
        res.json({ message: 'Figure saved', paths });
    } catch (error) {
        console.error('Error saving figure:', error);
        ErrorLogger.logError(`Failed to save figure: ${error.message}`, 'ERROR');
        res.status(500).json({ error: 'Failed to save figure' });
    }
});

module.exports = router;