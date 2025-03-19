const fs = require('fs').promises;
const path = require('path');
const DirectoryManager = require('./directoryManager'); // No destructuring needed since it’s a singleton
const ErrorLogger = require('./errorLogger'); // Import as default since it’s exported as a singleton

class SaveManager {
    async saveFigure(projectId, metadata, mapState) {
        try {
            await DirectoryManager.ensureDir(projectId);
            const fileName = `Figure_${metadata.figureNumber}_${metadata.name}`;
            const jsonPath = DirectoryManager.createPath(projectId, `${fileName}.json`);
            const pngPath = DirectoryManager.createPath(projectId, `${fileName}.png`);

            const figureData = { metadata, mapState };
            console.log('Saving figure data:', figureData); // Debug
            await fs.writeFile(jsonPath, JSON.stringify(figureData, null, 2));
            await fs.writeFile(pngPath, ''); // Placeholder PNG

            return { jsonPath, pngPath };
        } catch (error) {
            ErrorLogger.logError(`Save failed: ${error.message}`, 'ERROR');
            console.error('Save error in SaveManager:', error); // Debug
            throw error;
        }
    }
}

module.exports = new SaveManager();