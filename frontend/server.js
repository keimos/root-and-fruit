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

/**
 * Build the Content-Security-Policy for this deployment.
 *
 * This is the backstop for the app's biggest structural risk: AI-generated text
 * is rendered into innerHTML, so a prompt injection that slipped past the
 * server-side prompt and schema validation could try to emit markup. The upstream
 * defenses stop the model producing it; CSP stops the browser acting on it — and
 * an injected <script src="evil"> is the case that matters, because a stolen
 * Firebase ID token spends the victim's credits.
 *
 * 'unsafe-inline' for script-src is unavoidable: the whole app is one inline
 * <script> by design (see CLAUDE.md's single-file rule), and a nonce would have
 * to be threaded through the same injection that adds __RF_CONFIG__. It still
 * blocks EXTERNAL script loads, which is the vector worth closing.
 * @param {string} backendUrl  the API origin this build talks to
 * @returns {string}  the CSP header value
 */
function buildCsp(backendUrl) {
  const authDomain = process.env.FIREBASE_AUTH_DOMAIN;
  return [
    "default-src 'self'",
    // cdnjs: Font Awesome + jsPDF. gstatic: the Firebase compat SDK.
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://www.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    // data:/blob: — the share card is a <canvas> exported via toDataURL, and
    // jsPDF hands back a blob for download.
    "img-src 'self' data: blob:",
    ["connect-src 'self'", backendUrl,
      'https://identitytoolkit.googleapis.com',
      'https://securetoken.googleapis.com'].join(' '),
    // Firebase compat may open an auth helper iframe on its own domain.
    authDomain ? `frame-src https://${authDomain}` : "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'"
  ].join('; ');
}

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // frame-ancestors supersedes this in modern browsers; kept for older ones,
  // and set to DENY so the two agree rather than contradict.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', buildCsp(BACKEND_URL));
  // Cloud Run is HTTPS-only, so committing to it costs nothing today. NOTE:
  // includeSubDomains binds any future subdomain of a custom domain too.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // The app uses none of these; deny them so injected code cannot either.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
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