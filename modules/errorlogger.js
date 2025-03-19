const fs = require('fs').promises;
const path = require('path');

class ErrorLogger {
    constructor() {
        // Set the log file path relative to the module’s location
        this.logFile = path.join(__dirname, '../logs/errors.log');
    }

    async logError(message, severity) {
        const logEntry = `${new Date().toISOString()} [${severity}] ${message}\n`;
        try {
            // Ensure the logs directory exists
            await fs.mkdir(path.dirname(this.logFile), { recursive: true });
            // Append the log entry to the file
            await fs.appendFile(this.logFile, logEntry);
            console.log(`Logged error: ${logEntry.trim()}`); // Debug output to terminal
        } catch (error) {
            // Fallback to console if file write fails
            console.error('Failed to write to error log:', error);
        }
    }
}

module.exports = new ErrorLogger();