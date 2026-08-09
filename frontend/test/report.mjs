// Ad-hoc verification for the report/electability consistency fixes.
// Boots the frontend, seeds a saved audit with electability data + community
// justifications, loads it, and checks all three surfaces agree — including
// the generated PDF's raw bytes.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = '8096';
const BASE = `http://localhost:${PORT}`;
const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { console.log(`✓ ${l}`); pass++; } else { console.log(`✗ ${l}`); fail++; } };

const server = spawn('node', ['server.js'], {
  cwd: FRONTEND_DIR,
  env: { ...process.env, PORT, BACKEND_URL: 'http://backend.invalid', NODE_ENV: 'test' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

for (let i = 0; i < 40; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(300);
}

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  sessionStorage.setItem('rfRegistered', '1');
  document.getElementById('splashOverlay')?.classList.add('hidden');
});

const SAVED = {
  id: 111, name: 'Billion Godson', subjectType: 'candidate', pathway: 'elected',
  total: 38, verdict: 'THE WORKER', date: '1/1/2026',
  scores: { root: 20, branch: 8, fruit: 10, vis: 7, toxic: 0 },
  fruitVals: [2, 2, 2, 2, 2], visVal: 7,
  rootChecked: [true, true, true, true, false],
  branchChecked: [true, true, false, true, false, false],
  toxicChecked: [false, false, false],
  justifications: {
    root: 'Community felt the housing record was stronger than the AI scored it.',
    fruit: 'Two of the wins were partial, not full implementation.',
    peoples: 'Awarded by unanimous vote at the March assembly.',
  },
  electabilityData: {
    score: 8, tier: 'Strong Contender', trend: 'rising',
    context: 'Leads the primary field by nine points.',
    polls: [{ source: 'Marist', result: '42%', date: 'Feb 2026' }],
  },
};

await page.evaluate((a) => {
  localStorage.setItem('rfAudits', JSON.stringify([a]));
  loadAudit(a.id);
}, SAVED);
await sleep(400);

const vis = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}, sel);

// loadAudit() ends on the Full Report tab, so the Results view is inactive and
// the card has no box yet — assert it was un-hidden, then switch and see it.
ok(
  (await page.evaluate(() => document.getElementById('electabilityCard').style.display)) === 'block',
  'Results card is un-hidden when a saved audit is loaded'
);
await page.evaluate(() => showView('results'));
await sleep(300);
ok(await vis('#electabilityCard'), 'and it renders on the Results tab');
ok(
  (await page.textContent('#electScoreNum')).trim() === '8',
  'Results card shows the saved score'
);
ok(
  (await page.textContent('#electTier')).includes('Strong Contender'),
  'Results card shows the saved tier'
);

await page.evaluate(() => showView('assess'));
await sleep(300);
const reportText = await page.textContent('#reportElectabilityContent');
ok(reportText.includes('Strong Contender'), 'Full Report copy shows the same tier');
ok(reportText.includes('Marist'), 'Full Report copy shows the same poll');

// PDF: stub jsPDF's save() so the document is returned instead of downloaded,
// then search the raw bytes. jsPDF does not compress by default, so drawn text
// appears literally in the content stream.
// jsPDF copies its API onto each instance, so `save` is an OWN property and
// patching the prototype does nothing — wrap the constructor instead.
const dataUri = await page.evaluate(() => {
  let out = null;
  const Orig = window.jspdf.jsPDF;
  window.jspdf.jsPDF = function (...args) {
    const doc = new Orig(...args);
    doc.save = function () { out = this.output('datauristring'); return this; };
    return doc;
  };
  try { exportPDF(); } finally { window.jspdf.jsPDF = Orig; }
  return out;
});
const pdf = Buffer.from(String(dataUri).split(',')[1], 'base64').toString('latin1');

ok(pdf.includes('COMMUNITY ASSESSMENT NOTES'), 'PDF includes the community notes section');
ok(pdf.includes('unanimous vote'), "PDF includes the People's Choice justification");
ok(pdf.includes('partial, not full'), 'PDF includes the Fruit justification');
ok(pdf.includes('ELECTABILITY RATING'), 'PDF includes the electability section');
ok(pdf.includes('Strong Contender'), 'PDF shows the same tier as both UI surfaces');

// A saved audit with no electability must not leave a stale card behind.
await page.evaluate(() => {
  const a = JSON.parse(localStorage.getItem('rfAudits'))[0];
  const b = { ...a, id: 222, name: 'Policy X', subjectType: 'policy', electabilityData: null };
  localStorage.setItem('rfAudits', JSON.stringify([a, b]));
  loadAudit(222);
});
await sleep(300);
ok(!(await vis('#electabilityCard')), 'loading an audit without electability hides the stale card');

ok(errors.length === 0, `no uncaught page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

console.log(`\n${fail === 0 ? '✓ all checks passed' : `✗ ${fail} failed`} (${pass} passed)`);
await browser.close();
server.kill('SIGTERM');
process.exit(fail === 0 ? 0 : 1);
