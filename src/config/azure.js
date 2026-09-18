// src/config/azure.js
let aiClient = null;

function initApplicationInsights() {
  if (!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) return;
  try {
    const ai = require('applicationinsights');
    ai.setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
      .setAutoDependencyCorrelation(true)
      .setAutoCollectRequests(true)
      .setAutoCollectExceptions(true)
      .setAutoCollectConsole(true, true)
      .start();
    aiClient = ai.defaultClient;
    console.log('[Azure] Application Insights OK ✓');
  } catch (e) {
    console.warn('[Azure] App Insights no disponible:', e.message);
  }
}

function trackEvent(name, props = {}) {
  if (aiClient) aiClient.trackEvent({ name, properties: props });
}

function trackException(err, props = {}) {
  if (aiClient) aiClient.trackException({ exception: err, properties: props });
  else console.error('[ERROR]', err.message, props);
}

module.exports = { initApplicationInsights, trackEvent, trackException };
