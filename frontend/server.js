/**
 * Root & Fruit — Frontend Static Server
 * Serves the HTML app and injects the backend URL at runtime.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8081';

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Serve static assets (CSS, images, etc.) with cache headers
app.use('/static', express.static(path.join(__dirname, 'public/static'), {
  maxAge: '7d',
  immutable: true
}));

/**
 * Assemble the runtime config injected into every HTML response.
 * Firebase web-app config values are PUBLIC (not secrets) and are included only
 * when FIREBASE_API_KEY is set; otherwise `firebase` is null and the frontend
 * disables its auth UI gracefully.
 * @returns {object}  the __RF_CONFIG__ object (backendUrl, version, env, firebase)
 */
function buildRuntimeConfig() {
  const firebase = process.env.FIREBASE_API_KEY ? {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
    // Optional; only needed if the app later uses Storage / FCM.
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || ''
  } : null;

  return {
    backendUrl: BACKEND_URL,
    version: process.env.APP_VERSION || '1.0.0',
    env: process.env.NODE_ENV || 'production',
    firebase
  };
}

// Main app — inject runtime config into HTML at request time
app.get('*', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');

  try {
    let html = fs.readFileSync(htmlPath, 'utf-8');

    // Inject config as a global JS variable before </head>. JSON.stringify keeps
    // it injection-safe; escaping `<` prevents a value from closing the script.
    const json = JSON.stringify(buildRuntimeConfig()).replace(/</g, '\\u003c');
    const configScript = `\n<script>window.__RF_CONFIG__ = ${json};</script>`;

    html = html.replace('</head>', configScript + '\n</head>');
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); // HTML never cached
    res.send(html);
  } catch (err) {
    console.error('Failed to read index.html:', err);
    res.status(500).send('Server error');
  }
});

app.listen(PORT, () => {
  console.log(`Frontend server running on port ${PORT}`);
  console.log(`Backend URL: ${BACKEND_URL}`);
});