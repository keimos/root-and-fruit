/**
 * Firebase Authentication — server-side ID-token verification middleware.
 *
 * The frontend uses the Firebase Auth client SDK to register / sign in / reset
 * passwords directly against Google's identity service, then sends the resulting
 * short-lived **ID token** as `Authorization: Bearer <token>` on API calls. This
 * module verifies that token with the Firebase Admin SDK (signature + audience +
 * expiry) and attaches a minimal `req.user` to the request. The Anthropic key
 * pattern applies: no secret is needed here — verification fetches Google's
 * public signing keys over HTTPS; the Admin SDK authenticates via Application
 * Default Credentials (the Cloud Run runtime service account).
 *
 * Coexistence: `optionalAuth` NEVER rejects — a request with no/invalid token
 * simply arrives without `req.user`, preserving the app's anonymous per-browser
 * flow. `requireAuth` is available for routes that must be signed-in.
 */

const admin = require('firebase-admin');

// Lazily-initialized Admin app + an optional injected verifier (tests use it to
// avoid a live Firebase project). `let` so __setVerifier can swap it in.
let adminApp = null;
let injectedVerifier = null;

/**
 * Lazily initialize (once) and return the Firebase Admin SDK, or null when no
 * project is configured (local dev / tests without Firebase).
 * @returns {import('firebase-admin')|null}  the admin module, or null if unconfigured
 */
function getAdmin() {
  if (adminApp) return admin;
  const projectId = process.env.FIREBASE_PROJECT_ID
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GCLOUD_PROJECT;
  if (!projectId) return null;
  // No explicit credential: applicationDefault() is auto-detected on Cloud Run.
  adminApp = admin.initializeApp({ projectId });
  return admin;
}

/**
 * Test seam: inject a fake ID-token verifier so auth can be exercised without a
 * live Firebase project. Pass null to restore real verification.
 * @param {((token: string) => Promise<object>)|null} fn  verifier returning decoded claims
 * @returns {void}
 */
function __setVerifier(fn) { injectedVerifier = fn; }

/**
 * Verify a Firebase ID token and return its decoded claims.
 * @param {string} token  the raw JWT from the Authorization header
 * @returns {Promise<object>}  decoded token claims (uid, email, email_verified, …)
 * @throws  if unconfigured or the token is invalid/expired
 */
async function verifyIdToken(token) {
  if (injectedVerifier) return injectedVerifier(token);
  const a = getAdmin();
  if (!a) throw new Error('Firebase Auth is not configured');
  return a.auth().verifyIdToken(token);
}

/**
 * Pull the bearer token out of the Authorization header.
 * @param {import('express').Request} req  the incoming request
 * @returns {string|null}  the raw token, or null if absent/malformed
 */
function extractBearer(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Verify the request's bearer token (if any) into a minimal user object.
 * @param {import('express').Request} req  the incoming request
 * @returns {Promise<{uid: string, email: string|null, emailVerified: boolean}|null>}
 *          the verified user, or null when no valid token is present
 */
async function resolveUser(req) {
  const token = extractBearer(req);
  if (!token) return null;
  try {
    const claims = await verifyIdToken(token);
    return {
      uid: claims.uid || claims.sub,
      email: claims.email || null,
      emailVerified: !!claims.email_verified
    };
  } catch (err) {
    // Invalid / expired / unconfigured — caller decides how strict to be.
    return null;
  }
}

/**
 * Middleware: attach `req.user` if a valid token is present, else continue as
 * anonymous. Never rejects — preserves the anonymous flow.
 * @returns {import('express').RequestHandler}  the middleware
 */
function optionalAuth() {
  return async (req, _res, next) => {
    req.user = await resolveUser(req);
    next();
  };
}

/**
 * Middleware: require a valid token. Responds 401 when absent/invalid.
 * @returns {import('express').RequestHandler}  the middleware
 */
function requireAuth() {
  return async (req, res, next) => {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    req.user = user;
    next();
  };
}

module.exports = { optionalAuth, requireAuth, resolveUser, extractBearer, verifyIdToken, __setVerifier };
