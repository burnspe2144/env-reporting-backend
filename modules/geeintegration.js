const ee = require('@google/earthengine');
const ErrorLogger = require('./errorLogger'); // Fixed import

class GEEIntegration {
    constructor() {
        this.initialized = false;
        console.log('Starting GEE initialization');
        try {
            const credentials = JSON.parse(process.env.GEE_PRIVATE_KEY);
            console.log('Credentials parsed:', {
                private_key: credentials.private_key.substring(0, 50) + '...',
                client_email: credentials.client_email,
            });

            ee.data.authenticateViaPrivateKey(
                credentials.private_key,
                () => {
                    console.log('GEE authentication successful');
                    ee.initialize(
                        null,
                        null,
                        () => {
                            this.initialized = true;
                            console.log('GEE initialized successfully');
                        },
                        null,
                        { credentials }
                    );
                },
                (error) => {
                    console.error('GEE authentication failed:', error);
                    ErrorLogger.logError(`GEE authentication failed: ${error}`, 'ERROR');
                    this.initialized = false;
                }
            );

            setTimeout(() => {
                if (!this.initialized) {
                    console.error('GEE initialization timed out after 5 seconds');
                    ErrorLogger.logError('GEE initialization timed out after 5 seconds', 'ERROR');
                    this.initialized = false; // Explicitly mark as failed
                }
            }, 5000);
        } catch (error) {
            console.error('GEE setup failed:', error.message, error.stack);
            ErrorLogger.logError(`GEE setup failed: ${error.message}`, 'ERROR');
            this.initialized = false;
        }
    }

    async getTileUrl(baseMapType) {
        console.log('Starting getTileUrl for:', baseMapType);
        if (!this.initialized) {
            console.log('GEE not initialized, waiting...');
            let attempts = 0;
            const maxAttempts = 50; // 5 seconds
            while (!this.initialized && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
            if (!this.initialized) {
                throw new Error('GEE not initialized after 5 seconds');
            }
        }

        try {
            console.log('Fetching GEE map ID');
            let image;
            if (baseMapType === 'topo') {
                const srtm = ee.Image('USGS/SRTMGL1_003');
                image = ee.Terrain.hillshade(srtm);
            } else {
                image = ee.ImageCollection('COPERNICUS/S2')
                    .filterDate('2023-01-01', '2023-12-31')
                    .median();
            }
            return new Promise((resolve, reject) => {
                image.getMapId(
                    baseMapType === 'topo' ? { min: 0, max: 255 } : { bands: ['B4', 'B3', 'B2'], min: 0, max: 3000 },
                    (mapId) => {
                        if (!mapId || !mapId.mapid) {
                            const errorMsg = 'Invalid mapId returned from GEE';
                            console.error(errorMsg, mapId);
                            reject(new Error(errorMsg));
                            return;
                        }
                        const tileUrl = `https://earthengine.googleapis.com/v1alpha/projects/earthengine-legacy/maps/${mapId.mapid}/tiles/{z}/{x}/{y}`;
                        console.log(`Generated tile URL for ${baseMapType}: ${tileUrl}`);
                        resolve(tileUrl);
                    },
                    (error) => {
                        console.error('GEE getMapId error:', error);
                        ErrorLogger.logError(`GEE tile fetch failed: ${error || 'Unknown error'}`, 'ERROR');
                        reject(new Error(error || 'Unknown GEE error'));
                    }
                );
            });
        } catch (error) {
            console.error('Tile URL generation error:', error.message, error.stack);
            ErrorLogger.logError(`GEE tile fetch failed: ${error.message}`, 'ERROR');
            throw error;
        }
    }
}

module.exports = new GEEIntegration();