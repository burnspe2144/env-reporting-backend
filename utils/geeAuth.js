const ee = require("@google/earthengine");

function authenticateGEE(privateKey) {
    return new Promise((resolve, reject) => {
        ee.data.authenticateViaPrivateKey(
            privateKey,
            () => {
                ee.initialize(
                    null,
                    null,
                    () => resolve(),
                    err => reject("GEE initialization failed: " + err)
                );
            },
            err => reject("GEE auth failed: " + err)
        );
    });
}

module.exports = { authenticateGEE };