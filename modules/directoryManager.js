// env-reporting-backend/modules/directoryManager.js
const fs = require('fs').promises;
const path = require('path');
const { logError } = require('./errorLogger');

const BASE_DIR = path.join(__dirname, '..', 'projects');

class DirectoryManager {
    async ensureDir(projectId) {
        const dirPath = path.join(BASE_DIR, projectId, 'figures');
        try {
            await fs.mkdir(dirPath, { recursive: true });
            return dirPath;
        } catch (err) {
            await logError(`Failed to create directory ${dirPath}: ${err.message}`, 'error');
            throw new Error(`Directory creation failed: ${err.message}`);
        }
    }

    async getDirContents(projectId) {
        const dirPath = path.join(BASE_DIR, projectId, 'figures');
        try {
            return await fs.readdir(dirPath);
        } catch (err) {
            if (err.code === 'ENOENT') return [];
            await logError(`Failed to read directory ${dirPath}: ${err.message}`, 'error');
            throw new Error(`Directory read failed: ${err.message}`);
        }
    }

    createPath(projectId, fileName) {
        return path.join(BASE_DIR, projectId, 'figures', fileName);
    }

    async deleteFile(filePath) {
        try {
            await fs.unlink(filePath);
            console.log(`Deleted file: ${filePath}`); // Debug
        } catch (err) {
            if (err.code === 'ENOENT') {
                console.log(`File not found, skipping: ${filePath}`); // Debug
                return; // Silently skip if file doesn’t exist
            }
            await logError(`Failed to delete file ${filePath}: ${err.message}`, 'error');
            throw new Error(`File deletion failed: ${err.message}`);
        }
    }
}

module.exports = new DirectoryManager();