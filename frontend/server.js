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

// Main app — inject BACKEND_URL into HTML at request time
app.get('*', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');

  try {
    let html = fs.readFileSync(htmlPath, 'utf-8');

    // Inject config as a global JS variable before </head>
    const configScript = `
<script>
  window.__RF_CONFIG__ = {
    backendUrl: "${BACKEND_URL}",
    version: "${process.env.APP_VERSION || '1.0.0'}",
    env: "${process.env.NODE_ENV || 'production'}"
  };
</script>`;

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