/**
 * Script de téléchargement des logos d'entreprises
 * Télécharge en buffer (pas de fichier temporaire), évite les EPERM Windows
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const DOMAIN_OVERRIDES = {
  3:  'bgalocation.fr',
  4:  'restaurant-la-tradizione-bordeaux.fr',
  10: 'mondialmenuiseries.fr',
  13: 'cityzmedia.fr',
  15: '2e-gestion.fr',
  16: 'eraimmo.fr',
  19: 'ami-agence.fr',
  24: 'intens.immo',
  26: 'synergy-scop.fr',
  28: 'agencepierrot.fr',
  29: 'vitalepargne.com',
  30: 'sarlleroy.com',
  32: 'syrade.com',
  38: 'perrineetantoinette.com',
  43: 'gyraya.fr',
  44: 'auxilife.fr',
  53: 'askovet.com',
};

const LOGOS_DIR = path.join(__dirname, 'public', 'images', 'logos');
const DATA_FILE = path.join(__dirname, 'data', 'companies.json');

if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });

/** Télécharge en buffer (gère les redirects, max 5) */
function fetchBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (!redirectsLeft) return reject(new Error('Trop de redirections'));
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return fetchBuffer(next, redirectsLeft - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchLogo(id, domain) {
  const sources = [
    `https://logo.clearbit.com/${domain}?size=200`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    `https://${domain}/favicon.ico`,
    `https://www.${domain}/favicon.ico`,
  ];

  for (const [i, url] of sources.entries()) {
    try {
      const buf = await fetchBuffer(url);
      if (buf.length < 100) continue; // trop petit = probablement vide
      const ext  = url.includes('.ico') ? 'ico' : 'png';
      const dest = path.join(LOGOS_DIR, `${id}.${ext}`);
      fs.writeFileSync(dest, buf);
      const labels = ['Clearbit', 'Google favicon', 'favicon.ico site', 'favicon.ico www'];
      console.log(`  ${['✅','🔵','🟡','🟡'][i]} [${id}] ${labels[i]} → ${domain}`);
      return `${id}.${ext}`;
    } catch { /* essai suivant */ }
  }

  console.log(`  ❌ [${id}] Aucun logo pour ${domain}`);
  return null;
}

function fileOk(p) {
  try { return fs.statSync(p).size > 100; } catch { return false; }
}

async function main() {
  const companies = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  let updated = 0;

  for (const c of companies) {
    if (!c.domain && DOMAIN_OVERRIDES[c.id]) {
      c.domain = DOMAIN_OVERRIDES[c.id];
      updated++;
    }

    if (!c.domain) {
      console.log(`  ⚪ [${c.id}] ${c.nomAffichage || c.nom} — pas de domaine`);
      continue;
    }

    // Logo déjà présent ?
    const existing = [`${c.id}.png`, `${c.id}.ico`].find(f => fileOk(path.join(LOGOS_DIR, f)));
    if (existing) {
      if (!c.logoFile) { c.logoFile = existing; updated++; }
      console.log(`  ⏭️  [${c.id}] ${c.nomAffichage || c.nom} — déjà téléchargé`);
      continue;
    }

    console.log(`→ [${c.id}] ${c.nomAffichage || c.nom} (${c.domain})`);
    const file = await fetchLogo(c.id, c.domain);
    if (file) { c.logoFile = file; updated++; }
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(companies, null, 2), 'utf8');
  console.log(`\n✅ Terminé. ${updated} champs mis à jour dans companies.json`);
  console.log(`📁 Logos : ${LOGOS_DIR}`);
}

main().catch(console.error);
