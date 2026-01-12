"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getApiKey = getApiKey;
exports.setApiKey = setApiKey;
exports.clearApiKey = clearApiKey;
const SECRET_KEY = 'opencodeZen.apiKey';
async function getApiKey(secrets) {
    const stored = await secrets.get(SECRET_KEY);
    return stored ?? undefined;
}
async function setApiKey(secrets, apiKey) {
    await secrets.store(SECRET_KEY, apiKey);
}
async function clearApiKey(secrets) {
    await secrets.delete(SECRET_KEY);
}
//# sourceMappingURL=secrets.js.map