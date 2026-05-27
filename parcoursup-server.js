const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
let WAClient, WALocalAuth;
let waLoadError = null; // diagnostic: error from require('whatsapp-web.js')
let waInitError = null; // diagnostic: error from WhatsApp client init/launch
try {
  const wwjs = require('whatsapp-web.js');
  WAClient = wwjs.Client;
  WALocalAuth = wwjs.LocalAuth;
} catch(e) {
  waLoadError = e.message;
  console.log('[WhatsApp] whatsapp-web.js non disponible:', e.message);
}
let QRCode;
try { QRCode = require('qrcode'); } catch(e) {}

const app = express();
const PORT = process.env.PORT || 3012;

// ============ WHATSAPP CLIENT ============
let waClient = null;
let waStatus = 'disconnected'; // disconnected, qr_pending, connected, error
let waQRCode = null; // base64 QR image
let waInfo = null; // connected phone info

function initWhatsApp() {
  if (!WAClient || !WALocalAuth) {
    waStatus = 'unavailable';
    console.log('[WhatsApp] Client non disponible - emails uniquement');
    return;
  }
  // Nettoie les processus Chromium orphelins + les lock files laisses par un
  // crash precedent (cause typique d'erreur "The browser is already running
  // for ... userDataDir"). La session WhatsApp (IndexedDB, cookies auth) reste
  // intacte car on ne touche qu'aux fichiers Singleton* et aux processus
  // Chromium attaches a .wwebjs_auth.
  try {
    const { execSync } = require('child_process');
    // 1. Tuer tout Chromium zombie qui tient encore la session WhatsApp
    try {
      execSync('pkill -9 -f wwebjs_auth', { stdio: 'ignore', timeout: 5000 });
      console.log('[WhatsApp] Processus Chromium orphelins nettoyes');
    } catch(_) { /* pkill retourne 1 si aucun process matche, ignore */ }
  } catch(e) {
    console.log('[WhatsApp] pkill indisponible (non bloquant):', e.message);
  }
  try {
    const authDir = path.join(__dirname, 'data', '.wwebjs_auth');
    if (fs.existsSync(authDir)) {
      const sessions = fs.readdirSync(authDir).filter(n => n.startsWith('session'));
      for (const sessionName of sessions) {
        for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
          const lockPath = path.join(authDir, sessionName, lockName);
          try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch(_) {}
        }
      }
    }
  } catch(e) {
    console.log('[WhatsApp] Nettoyage des lock files echoue (non bloquant):', e.message);
  }
  // Reset waInitError for cette nouvelle tentative
  waInitError = null;
  try {
    waClient = new WAClient({
      authStrategy: new WALocalAuth({ dataPath: path.join(__dirname, 'data', '.wwebjs_auth') }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run'],
        // Augmente le timeout RPC Chromium (defaut 30s) — evite l'erreur
        // "Runtime.callFunctionOn timed out" quand WhatsApp Web est en pleine
        // sync au moment d'un envoi (typique apres reconnexion).
        protocolTimeout: 120000,
      }
    });

    waClient.on('qr', async (qr) => {
      waStatus = 'qr_pending';
      if (QRCode) waQRCode = await QRCode.toDataURL(qr);
      console.log('[WhatsApp] QR Code généré - scannez-le depuis l\'interface');
    });

    waClient.on('ready', () => {
      waStatus = 'connected';
      waQRCode = null;
      waInfo = waClient.info;
      console.log(`[WhatsApp] Connecté ! Numéro: ${waClient.info.wid.user}`);
    });

    // ============ CAPTURE MESSAGES WHATSAPP ENTRANTS ============
    waClient.on('message', async (msg) => {
      try {
        if (msg.fromMe) return; // Ignorer nos propres messages
        const from = msg.from; // format: 33612345678@c.us
        if (!from || !from.endsWith('@c.us')) return;
        const phone = from.replace('@c.us', '');
        // Convertir 33xxx en 0xxx pour matcher les candidats
        let phoneLocal = phone;
        if (phoneLocal.startsWith('33')) phoneLocal = '0' + phoneLocal.substring(2);

        // Chercher le candidat par téléphone
        const candidates = loadJSON('parcoursup-candidates.json');
        const matchedCandidates = candidates.filter(c => {
          const cp = (c.telephone || '').replace(/[\s\-\.]/g, '');
          return cp === phoneLocal || cp === phone || cp === '+' + phone;
        });
        if (matchedCandidates.length === 0) return; // Pas un candidat connu

        const relances = loadJSON('parcoursup-relances.json');
        const now = new Date().toISOString();
        const msgBody = (msg.body || '').substring(0, 500); // Limiter la taille

        for (const candidate of matchedCandidates) {
          relances.push({
            id: genId(),
            candidateId: candidate.id,
            type: 'whatsapp',
            date: now,
            notes: `[REÇU] ${msgBody}`,
            result: 'repondu',
            createdBy: `${candidate.prenom || ''} ${candidate.nom || ''}`.trim()
          });
          console.log(`[WhatsApp] Message reçu de ${candidate.prenom} ${candidate.nom} (${phoneLocal}): ${msgBody.substring(0, 80)}...`);
        }
        saveJSON('parcoursup-relances.json', relances);
        broadcast('relances');
      } catch (e) {
        console.error('[WhatsApp] Erreur capture message entrant:', e.message);
      }
    });

    waClient.on('authenticated', () => {
      console.log('[WhatsApp] Authentifié avec succès');
    });

    waClient.on('auth_failure', (msg) => {
      waStatus = 'error';
      console.error('[WhatsApp] Erreur d\'authentification:', msg);
    });

    waClient.on('disconnected', (reason) => {
      waStatus = 'disconnected';
      waQRCode = null;
      waInfo = null;
      console.log('[WhatsApp] Déconnecté:', reason);
      // Auto-reconnect after 5s (only if not in cloud without Chromium)
      if (reason !== 'NAVIGATION') {
        setTimeout(() => {
          console.log('[WhatsApp] Tentative de reconnexion...');
          initWhatsApp();
        }, 5000);
      }
    });

    waClient.initialize().catch(err => {
      waStatus = 'unavailable';
      waInitError = err.message;
      waClient = null;
      console.error('[WhatsApp] Erreur init (Chromium absent ?):', err.message);
    });
    console.log('[WhatsApp] Initialisation en cours...');
  } catch (e) {
    waStatus = 'unavailable';
    waInitError = e.message;
    waClient = null;
    console.error('[WhatsApp] Erreur init:', e.message);
  }
}

// Start WhatsApp client
initWhatsApp();

async function sendWhatsApp(phone, message) {
  if (!waClient || waStatus !== 'connected') {
    throw new Error('WhatsApp non connecté. Scannez le QR code dans Automatisations.');
  }
  // Normalize phone: remove spaces, ensure country code
  let cleanPhone = phone.replace(/[\s\-\.]/g, '');
  if (cleanPhone.startsWith('0')) cleanPhone = '33' + cleanPhone.substring(1);
  if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);
  // WhatsApp format: countrycode + number + @c.us
  const chatId = cleanPhone + '@c.us';

  // Note: on a retire le pre-flight isRegisteredUser, qui est lent et peut
  // timeout sur Puppeteer. Si le numero n'est pas sur WhatsApp, sendMessage
  // levera une erreur explicite qui sera catchee par l'appelant.
  await waClient.sendMessage(chatId, message);
  return chatId;
}

app.use(express.json({ limit: '10mb' }));
// Only serve specific static assets, not the full public folder (to avoid conflicts with main server's index.html)
app.use('/parcoursup/assets/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/parcoursup/assets/images', express.static(path.join(__dirname, 'public', 'images')));
app.get('/parcoursup/assets/modele-import-parcoursup.csv', (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="modele-import-parcoursup.csv"');
  res.sendFile(path.join(__dirname, 'public', 'modele-import-parcoursup.csv'));
});

// ============ CRM EXTERNE - VERIFICATION ============
const http = require('http');

// Cache des candidats CRM externe (rafraîchi toutes les 10 min)
let crmExterneCache = { clem: [], will: [], lastFetch: 0 };

async function fetchCrmExterneLists() {
  const now = Date.now();
  // Cache 10 minutes
  if (now - crmExterneCache.lastFetch < 10 * 60 * 1000 && (crmExterneCache.clem.length > 0 || crmExterneCache.will.length > 0)) {
    return crmExterneCache;
  }

  const fetchSchool = (school) => new Promise((resolve) => {
    const req = http.get(`http://localhost:3001/admission/api/all/${school}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const all = [];
          (json.views || []).forEach(v => {
            (v.candidates || []).forEach(c => all.push(c));
          });
          resolve(all);
        } catch (e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(15000, () => { req.destroy(); resolve([]); });
  });

  try {
    const [clem, will] = await Promise.all([fetchSchool('clem'), fetchSchool('will')]);
    crmExterneCache = { clem, will, lastFetch: now };
    console.log(`[CRM Check] Cache rafraîchi: ${clem.length} CLEM, ${will.length} CLEM`);
  } catch (e) {
    console.log('[CRM Check] Erreur fetch CRM externe:', e.message);
  }
  return crmExterneCache;
}

function normalize(str) {
  return (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function checkCandidateInCRM(candidate) {
  const cache = await fetchCrmExterneLists();
  const allCrmCandidates = [...cache.clem, ...cache.will];

  if (allCrmCandidates.length === 0) return false;

  const email = normalize(candidate.email);
  const nom = normalize(candidate.nom);
  const prenom = normalize(candidate.prenom);

  // 1ère couche : matching par email
  if (email) {
    const found = allCrmCandidates.find(c => normalize(c.email) === email);
    if (found) return true;
  }

  // 2ème couche : matching par nom + prénom
  if (nom && prenom) {
    const found = allCrmCandidates.find(c =>
      normalize(c.nom) === nom && normalize(c.prenom) === prenom
    );
    if (found) return true;
  }

  return false;
}

// Vérifie un candidat et le bascule si trouvé dans le CRM
async function autoCheckAndMoveToCRM(candidateId) {
  try {
    const candidates = loadJSON('parcoursup-candidates.json');
    const idx = candidates.findIndex(c => c.id === candidateId);
    if (idx === -1) return;

    const candidate = candidates[idx];
    if (candidate.statutCRM) return; // Déjà marqué

    const inCRM = await checkCandidateInCRM(candidate);
    if (inCRM) {
      candidates[idx].statutCRM = true;
      candidates[idx].stage = 'candidature_crm';
      candidates[idx].updatedAt = new Date().toISOString();
      saveJSON('parcoursup-candidates.json', candidates);
      broadcast('candidates');
      console.log(`[CRM Check] ${candidate.prenom} ${candidate.nom} trouvé dans CRM → Candidature CRM`);
    }
  } catch (e) {
    console.log('[CRM Check] Erreur vérification:', e.message);
  }
}

// ============ VERIFICATION CRM PERIODIQUE (toutes les 30 min) ============
const CRM_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes

async function periodicCRMCheck() {
  try {
    // Forcer le refresh du cache CRM
    crmExterneCache.lastFetch = 0;
    const cache = await fetchCrmExterneLists();
    const totalCRM = cache.clem.length + cache.will.length;
    if (totalCRM === 0) {
      console.log('[CRM Periodic] CRM externe non accessible, skip');
      return;
    }

    const candidates = loadJSON('parcoursup-candidates.json');
    const toCheck = candidates.filter(c => !c.statutCRM);
    let moved = 0;

    for (const candidate of toCheck) {
      const inCRM = await checkCandidateInCRM(candidate);
      if (inCRM) {
        const idx = candidates.findIndex(c => c.id === candidate.id);
        if (idx !== -1) {
          candidates[idx].statutCRM = true;
          candidates[idx].stage = 'candidature_crm';
          candidates[idx].updatedAt = new Date().toISOString();
          moved++;
          console.log(`[CRM Periodic] ${candidate.prenom} ${candidate.nom} → Candidature CRM`);
        }
      }
    }

    if (moved > 0) {
      saveJSON('parcoursup-candidates.json', candidates);
      broadcast('candidates');
    }
    console.log(`[CRM Periodic] Vérification terminée : ${toCheck.length} vérifiés, ${moved} déplacés (${totalCRM} fiches CRM)`);
  } catch (e) {
    console.log('[CRM Periodic] Erreur:', e.message);
  }
}

// Lancer la vérification périodique après le démarrage
setTimeout(() => {
  periodicCRMCheck(); // Premier check 1 min après le démarrage
  setInterval(periodicCRMCheck, CRM_CHECK_INTERVAL); // Puis toutes les 30 min
}, 60 * 1000);

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============ PIN AUTH ============
const PARCOURSUP_PIN = process.env.PARCOURSUP_PIN || 'CLEM2026';
const activeSessions = new Map(); // token -> { createdAt }

app.post('/parcoursup/api/auth', (req, res) => {
  const { pin } = req.body;
  if (pin === PARCOURSUP_PIN) {
    const token = genId() + genId();
    activeSessions.set(token, { createdAt: new Date() });
    // Clean old sessions (>24h)
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const [t, s] of activeSessions) {
      if (new Date(s.createdAt).getTime() < dayAgo) activeSessions.delete(t);
    }
    return res.json({ success: true, token });
  }
  res.status(401).json({ success: false, error: 'Code PIN incorrect' });
});

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token && activeSessions.has(token)) return next();
  res.status(401).json({ error: 'Non authentifié' });
}

// Apply auth to all API routes except /auth and /health
app.use('/parcoursup/api', (req, res, next) => {
  if (req.path === '/auth' || req.path === '/health' || req.path === '/events') return next();
  requireAuth(req, res, next);
});

// ============ SSE (Server-Sent Events) for real-time sync ============
const sseClients = new Set();

app.get('/parcoursup/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('data: connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(event = 'update') {
  const msg = `data: ${event}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch(e) { sseClients.delete(client); }
  }
}

// JSON helpers
const DATA_DIR = path.join(__dirname, 'data');

function loadJSON(filename) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(filepath)) return filename.endsWith('config.json') ? {} : [];
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    console.error(`Error loading ${filename}:`, e.message);
    return filename.endsWith('config.json') ? {} : [];
  }
}

function saveJSON(filename, data) {
  const filepath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// ============ DEFAULT CONFIG (used when data file doesn't exist, e.g. fresh Render deploy) ============
const DEFAULT_PARCOURSUP_CONFIG = {
  ecoles: {
    "CLEM": { color: "#DDDF4B", formations: { "BTS COMMUNICATION": { conseiller: null }, "BTS GPME": { conseiller: null }, "BTS MCO": { conseiller: null }, "BTS NDRC": { conseiller: null } } }
  },
  chargesAdmission: [],
  stages: [
    { id: "voeu_recu", label: "Voeu reçu", color: "#9B59B6", order: 0 },
    { id: "relance_mail_n1", label: "Relance mail N°1", color: "#3498DB", order: 1 },
    { id: "contacte", label: "Contacté", color: "#3498DB", order: 2 },
    { id: "rdv_planifie", label: "RDV Planifié", color: "#F39C12", order: 3 },
    { id: "admis", label: "Admis", color: "#2ECC71", order: 4 },
    { id: "inscrit", label: "Inscrit", color: "#27AE60", order: 5 },
    { id: "refuse", label: "Refusé", color: "#E74C3C", order: 6 },
    { id: "abandonne", label: "Abandonné", color: "#95A5A6", order: 7 }
  ],
  relanceTypes: [
    { id: "telephone", label: "Téléphone", icon: "phone" },
    { id: "mail", label: "Mail", icon: "mail" },
    { id: "whatsapp", label: "WhatsApp", icon: "message-circle" },
    { id: "courrier", label: "Courrier", icon: "send" }
  ],
  relanceResults: [
    { id: "repondu", label: "Répondu" },
    { id: "no_answer", label: "Pas de réponse" },
    { id: "message_laisse", label: "Message laissé" },
    { id: "envoye", label: "Envoyé" },
    { id: "autre", label: "Autre" }
  ],
  automations: {
    voeu_recu: {
      enabled: true, id: "voeu_recu",
      actions: [
        { channel: "mail", subject: "", message: "Bonjour {{prenom}}\nParcoursup TEST\nLaurent ", delayMinutes: 6 },
        { channel: "whatsapp", subject: "", message: "Bonjour {{prenom}} {{nom}}\nWelcome Test via Parcoursup \nLaurent ", delayMinutes: 5 }
      ]
    },
    relance_mail_n1: {
      enabled: true, id: "relance_mail_n1",
      actions: [
        { channel: "mail", subject: "", message: "Bonjour{{prenom}} j'espère que tu vas bien ? \nTest auto à 10mn \nBienvenue dans chez {{ecole}} dans la {{formation}}\nWelcome", delayMinutes: 10 },
        { channel: "whatsapp", subject: "", message: "Bonjour{{prenom}} j'espère que tu vas bien ? peux tu me dire si tu as bien reçu ce Whatsapp la bistte ", delayMinutes: 5 }
      ]
    },
    contacte: {
      enabled: true, id: "contacte",
      actions: [
        { channel: "mail", subject: "bienvenue chez {{ecole}} ...appelle moi vite", message: "Bonjour {{prenom}}Appelle moi vite car je dois échanger avec toi sur ta formation en  {{formation}} chez {{ecole}}\nBelle journée Laurent ", delayMinutes: 3 },
        { channel: "whatsapp", subject: "", message: "Bonjour {{prenom}}Appelle moi vite car je dois échanger avec toi sur ta formation en  {{formation}} chez {{ecole}}\nBelle journée Laurent ", delayMinutes: 2 }
      ]
    }
  }
};

// ============ LOGOS ECOLES + PARCOURSUP (base64 pour courrier PDF) ============
const LOGOS_BASE64 = {};
let LOGO_PARCOURSUP_BASE64 = '';
try {
  const logoCLEM = fs.readFileSync(path.join(__dirname, 'public/images/logo-clem-courrier.png'));
  LOGOS_BASE64['CLEM'] = 'data:image/png;base64,' + logoCLEM.toString('base64');
  LOGOS_BASE64['CLEM'] = LOGOS_BASE64['CLEM'];
  const logoWill = fs.readFileSync(path.join(__dirname, 'public/images/logo-clem-courrier.png'));
  LOGOS_BASE64['CLEM'] = 'data:image/png;base64,' + logoWill.toString('base64');
  console.log('[Courrier] Logos courrier chargés en base64');
} catch(e) {
  console.log('[Courrier] Logos non trouvés:', e.message);
}
// Logo Parcoursup embarqué directement en base64 (pas de dépendance fichier externe)
LOGO_PARCOURSUP_BASE64 = 'data:image/png;base64,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';
console.log('[Courrier] Logo Parcoursup charge (embarqué dans le code)');
// Legacy: compat fallback en cas de regeneration depuis fichier
try {
  const logoParcoursup = fs.readFileSync(path.join(__dirname, 'public/images/logo-parcoursup.png'));
  LOGO_PARCOURSUP_BASE64 = 'data:image/png;base64,' + logoParcoursup.toString('base64');
} catch(e) {
  // Fichier absent : on garde la version embarquée ci-dessus
}

// ============ MODELES COURRIER PAR DEFAUT ============
const DEFAULT_COURRIER_TEMPLATES = {
  'courrier_multi_voeux': {
    label: 'Courrier Multi Voeux',
    builtIn: true,
    content: `Objet : Votre candidature en {{formation}} - {{ecole}}

{{genre_civilite}} {{prenom}} {{nom}},

Nous avons bien pris note de votre candidature pour intégrer la formation {{formation}} au sein de notre établissement {{ecole}}.

Nous avons remarqué que vous avez émis plusieurs vœux sur Parcoursup. Nous souhaitions vous informer que notre équipe pédagogique reste à votre entière disposition pour échanger sur votre projet de formation et vous accompagner dans votre choix.

N'hésitez pas à nous contacter au {{telCharge}} ou par email pour convenir d'un rendez-vous.

Dans l'attente de votre réponse, nous vous prions d'agréer, {{genre_civilite}} {{prenom}} {{nom}}, l'expression de nos salutations distinguées.

{{chargeAdmission}}
Service Admissions
{{ecole}}
{{adresseEcole}}
{{cpEcole}} {{villeEcole}}`
  },
  'courrier_admission_voeu_unique': {
    label: 'Courrier Admission Voeu Unique',
    builtIn: true,
    content: `Objet : Confirmation de votre candidature en {{formation}} - {{ecole}}

{{genre_civilite}} {{prenom}} {{nom}},

Nous avons le plaisir de vous confirmer la bonne réception de votre candidature pour la formation {{formation}} au sein de {{ecole}}.

Votre dossier est actuellement en cours d'examen par notre commission pédagogique. Nous tenons à vous remercier pour l'intérêt que vous portez à notre établissement.

Afin de finaliser votre dossier, nous vous invitons à prendre contact avec votre conseiller en formation {{conseillerFormation}} pour planifier un entretien d'admission.

Vous pouvez nous joindre au {{telCharge}} ou vous rendre directement dans nos locaux situés au {{adresseEcole}}, {{cpEcole}} {{villeEcole}}.

Dans l'attente de vous rencontrer, nous vous prions d'agréer, {{genre_civilite}} {{prenom}} {{nom}}, l'expression de nos salutations les meilleures.

{{chargeAdmission}}
Service Admissions
{{ecole}}
{{adresseEcole}}
{{cpEcole}} {{villeEcole}}`
  }
};

// ============ TEMPLATE VARS HELPER ============
// Adresses des écoles
const ECOLES_ADRESSES = {
  'CLEM': { adresse: '95 quai de Bacalan', codePostal: '33300', ville: 'Bordeaux' },
  'CLEM': { adresse: '11-15 cours Edouard Vaillant', codePostal: '33300', ville: 'Bordeaux' },
  'CLEM': { adresse: '4 rue des Remparts', codePostal: '40000', ville: 'Mont de Marsan' }
};

function replaceTemplateVars(text, candidate, config) {
  if (!text) return '';
  const coordonnees = config?.coordonnees || {};
  const chargeInfo = coordonnees[candidate.chargeAdmission] || {};
  const conseillerInfo = coordonnees[candidate.conseillerFormation] || {};
  const ecoleAddr = ECOLES_ADRESSES[candidate.ecole] || {};
  return text
    .replace(/\{\{prenom\}\}/g, candidate.prenom || '')
    .replace(/\{\{nom\}\}/g, candidate.nom || '')
    .replace(/\{\{formation\}\}/g, candidate.formation || '')
    .replace(/\{\{ecole\}\}/g, candidate.ecole || '')
    .replace(/\{\{email\}\}/g, candidate.email || '')
    .replace(/\{\{telephone\}\}/g, candidate.telephone || '')
    .replace(/\{\{chargeAdmission\}\}/g, candidate.chargeAdmission || '')
    .replace(/\{\{conseillerFormation\}\}/g, candidate.conseillerFormation || '')
    .replace(/\{\{telCharge\}\}/g, chargeInfo.telephone || '')
    .replace(/\{\{mailCharge\}\}/g, chargeInfo.email || '')
    .replace(/\{\{telConseiller\}\}/g, conseillerInfo.telephone || '')
    .replace(/\{\{mailConseiller\}\}/g, conseillerInfo.email || '')
    .replace(/\{\{adresse\}\}/g, candidate.adresse || '')
    .replace(/\{\{codePostal\}\}/g, candidate.codePostal || '')
    .replace(/\{\{ville\}\}/g, candidate.ville || '')
    .replace(/\{\{adresseEcole\}\}/g, ecoleAddr.adresse || '')
    .replace(/\{\{cpEcole\}\}/g, ecoleAddr.codePostal || '')
    .replace(/\{\{villeEcole\}\}/g, ecoleAddr.ville || '')
    .replace(/\{\{dateJour\}\}/g, new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }))
    .replace(/\{\{genre_civilite\}\}/g, candidate.genre === 'F' ? 'Madame' : candidate.genre === 'G' ? 'Monsieur' : 'Madame, Monsieur');
}

// ============ CONFIG ============
app.get('/parcoursup/api/config', (req, res) => {
  const cfg = loadJSON('parcoursup-config.json');
  // If config is empty or missing key sections (fresh deploy), merge with defaults
  if (!cfg.stages || !cfg.ecoles) {
    // Deep merge: keep user overrides, fill missing with defaults
    const merged = { ...DEFAULT_PARCOURSUP_CONFIG, ...cfg };
    // Ensure automations are preserved: if user has none, use defaults
    if (!cfg.automations || Object.keys(cfg.automations).length === 0) {
      merged.automations = DEFAULT_PARCOURSUP_CONFIG.automations;
    }
    saveJSON('parcoursup-config.json', merged);
    return res.json(merged);
  }
  res.json(cfg);
});

app.post('/parcoursup/api/config', (req, res) => {
  saveJSON('parcoursup-config.json', req.body);
  res.json({ success: true });
});

// ============ CANDIDATES ============
app.get('/parcoursup/api/candidates', (req, res) => {
  let candidates = loadJSON('parcoursup-candidates.json');
  const { ecole, formation, stage, charge, conseiller, search } = req.query;
  if (ecole) candidates = candidates.filter(c => c.ecole === ecole);
  if (formation) candidates = candidates.filter(c => c.formation === formation);
  if (stage) candidates = candidates.filter(c => c.stage === stage);
  if (charge) candidates = candidates.filter(c => c.chargeAdmission === charge);
  if (conseiller) candidates = candidates.filter(c => c.conseillerFormation === conseiller);
  if (search) {
    const s = search.toLowerCase();
    candidates = candidates.filter(c =>
      (c.nom || '').toLowerCase().includes(s) ||
      (c.prenom || '').toLowerCase().includes(s) ||
      (c.email || '').toLowerCase().includes(s) ||
      (c.telephone || '').includes(s)
    );
  }
  res.json(candidates);
});

app.post('/parcoursup/api/candidates', (req, res) => {
  const candidates = loadJSON('parcoursup-candidates.json');
  const now = new Date().toISOString();
  const candidate = {
    id: genId(),
    numeroDossier: req.body.numeroDossier || '',
    genre: req.body.genre || '',
    dateNaissance: req.body.dateNaissance || '',
    nom: req.body.nom || '',
    prenom: req.body.prenom || '',
    telephone: req.body.telephone || '',
    email: req.body.email || '',
    adresse: req.body.adresse || '',
    codePostal: req.body.codePostal || '',
    ville: req.body.ville || '',
    ecole: req.body.ecole || '',
    formation: req.body.formation || '',
    conseillerFormation: req.body.conseillerFormation || '',
    chargeAdmission: req.body.chargeAdmission || '',
    stage: req.body.stage || 'sas_entree',
    statutCRM: req.body.statutCRM || false,
    notes: req.body.notes || '',
    rating: req.body.rating || 0,
    createdAt: now,
    updatedAt: now
  };
  candidates.push(candidate);
  saveJSON('parcoursup-candidates.json', candidates);
  // Trigger automation for initial stage (e.g. sas_entree)
  triggerAutomation(candidate.id, candidate.stage);
  broadcast('candidates');
  res.json(candidate);
  // Vérification CRM externe en arrière-plan
  autoCheckAndMoveToCRM(candidate.id);
});

app.put('/parcoursup/api/candidates/:id', (req, res) => {
  const candidates = loadJSON('parcoursup-candidates.json');
  const idx = candidates.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Candidat non trouvé' });
  candidates[idx] = { ...candidates[idx], ...req.body, updatedAt: new Date().toISOString() };
  saveJSON('parcoursup-candidates.json', candidates);
  broadcast('candidates');
  res.json(candidates[idx]);
});

app.patch('/parcoursup/api/candidates/:id/stage', (req, res) => {
  const candidates = loadJSON('parcoursup-candidates.json');
  const idx = candidates.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Candidat non trouvé' });
  const oldStage = candidates[idx].stage;
  const newStage = req.body.stage;
  candidates[idx].stage = newStage;
  candidates[idx].updatedAt = new Date().toISOString();
  saveJSON('parcoursup-candidates.json', candidates);

  // Trigger automations if stage changed
  if (oldStage !== newStage) {
    triggerAutomation(candidates[idx].id, newStage);
  }

  broadcast('candidates');
  res.json(candidates[idx]);
});

// Helper to trigger automation inline
function triggerAutomation(candidateId, stageId) {
  try {
    const config = loadJSON('parcoursup-config.json');
    const candidates = loadJSON('parcoursup-candidates.json');
    const queue = loadJSON('parcoursup-queue.json');
    const candidate = candidates.find(c => c.id === candidateId);
    if (!candidate) return;

    const automations = config.automations || {};
    const stageAutos = automations[stageId];
    if (!stageAutos || !stageAutos.enabled) return;

    const stageInfo = (config.stages || []).find(s => s.id === stageId);
    const now = new Date();

    // Avoid duplicates: only block if same candidate+stage automation is pending or was sent in the last 10 minutes
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const alreadyQueued = queue.some(q =>
      q.candidateId === candidateId && q.stageId === stageId && q.automationId &&
      (q.status === 'pending' || (q.status === 'sent' && q.createdAt > tenMinAgo))
    );
    if (alreadyQueued) return;

    (stageAutos.actions || []).forEach(action => {
      const delayMs = (action.delayMinutes || 0) * 60 * 1000;
      const scheduledAt = new Date(now.getTime() + delayMs);

      let message = replaceTemplateVars(action.message, candidate, config);
      let subject = replaceTemplateVars(action.subject, candidate, config);

      queue.push({
        id: genId(), candidateId: candidate.id,
        candidateName: `${candidate.prenom} ${candidate.nom}`,
        candidateEmail: candidate.email || '', candidatePhone: candidate.telephone || '',
        channel: action.channel || 'mail', subject, message, stageId,
        imageUrl: action.imageUrl || '',
        stageLabel: stageInfo?.label || stageId,
        scheduledAt: scheduledAt.toISOString(), status: 'pending',
        createdAt: now.toISOString(), sentAt: null, error: null,
        automationId: stageAutos.id || stageId
      });
    });

    saveJSON('parcoursup-queue.json', queue);
    console.log(`[Auto] Automation triggered for ${candidate.prenom} ${candidate.nom} -> ${stageId}`);
  } catch (e) {
    console.error('[Auto] Error triggering automation:', e.message);
  }
}

app.delete('/parcoursup/api/candidates/:id', (req, res) => {
  let candidates = loadJSON('parcoursup-candidates.json');
  candidates = candidates.filter(c => c.id !== req.params.id);
  saveJSON('parcoursup-candidates.json', candidates);
  // Also remove relances
  let relances = loadJSON('parcoursup-relances.json');
  relances = relances.filter(r => r.candidateId !== req.params.id);
  saveJSON('parcoursup-relances.json', relances);
  broadcast('candidates');
  res.json({ success: true });
});

// Bulk import
app.post('/parcoursup/api/candidates/bulk', (req, res) => {
  const existing = loadJSON('parcoursup-candidates.json');
  const now = new Date().toISOString();
  const newCandidates = (req.body.candidates || []).map(c => ({
    id: genId(),
    numeroDossier: c.numeroDossier || '',
    genre: c.genre || '',
    dateNaissance: c.dateNaissance || '',
    nom: c.nom || '',
    prenom: c.prenom || '',
    telephone: c.telephone || '',
    email: c.email || '',
    adresse: c.adresse || '',
    codePostal: c.codePostal || '',
    ville: c.ville || '',
    ecole: c.ecole || '',
    formation: c.formation || '',
    conseillerFormation: c.conseillerFormation || '',
    chargeAdmission: c.chargeAdmission || '',
    stage: c.stage || 'sas_entree',
    statutCRM: c.statutCRM || false,
    notes: c.notes || '',
    createdAt: now,
    updatedAt: now
  }));
  const all = [...existing, ...newCandidates];
  saveJSON('parcoursup-candidates.json', all);
  // Trigger automations for each imported candidate
  newCandidates.forEach(c => triggerAutomation(c.id, c.stage));
  broadcast('candidates');
  res.json({ imported: newCandidates.length, total: all.length });
  // Vérification CRM externe en arrière-plan pour chaque candidat importé
  newCandidates.forEach(c => autoCheckAndMoveToCRM(c.id));
});

// ============ CRM CHECK ENDPOINT ============
// Vérifie tous les candidats non-CRM contre le CRM externe
app.post('/parcoursup/api/crm-check', async (req, res) => {
  try {
    // Force refresh du cache
    crmExterneCache.lastFetch = 0;
    const cache = await fetchCrmExterneLists();
    const totalCRM = cache.clem.length + cache.will.length;

    if (totalCRM === 0) {
      return res.json({ ok: false, error: 'CRM externe non accessible. Vérifiez la connexion sur le Hub Admission (port 3001).' });
    }

    const candidates = loadJSON('parcoursup-candidates.json');
    const toCheck = candidates.filter(c => !c.statutCRM);
    let moved = 0;

    for (const candidate of toCheck) {
      const inCRM = await checkCandidateInCRM(candidate);
      if (inCRM) {
        const idx = candidates.findIndex(c => c.id === candidate.id);
        if (idx !== -1) {
          candidates[idx].statutCRM = true;
          candidates[idx].stage = 'candidature_crm';
          candidates[idx].updatedAt = new Date().toISOString();
          moved++;
          console.log(`[CRM Check] ${candidate.prenom} ${candidate.nom} → Candidature CRM`);
        }
      }
    }

    if (moved > 0) {
      saveJSON('parcoursup-candidates.json', candidates);
      broadcast('candidates');
    }

    res.json({ ok: true, checked: toCheck.length, moved, crmTotal: totalCRM });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ============ ADRESSES ECOLES ============
app.get('/parcoursup/api/ecoles-adresses', (req, res) => {
  res.json(ECOLES_ADRESSES);
});

// ============ MODELES COURRIER (API) ============
app.get('/parcoursup/api/courrier/templates', requireAuth, (req, res) => {
  const config = loadJSON('parcoursup-config.json');
  // Fusionner les modèles par défaut avec ceux sauvegardés
  const saved = config.courrierTemplates || {};
  const templates = { ...DEFAULT_COURRIER_TEMPLATES };
  // Écraser les modèles par défaut si modifiés, ajouter les customs
  Object.entries(saved).forEach(([key, tmpl]) => {
    templates[key] = { ...templates[key], ...tmpl };
  });
  res.json(templates);
});

app.post('/parcoursup/api/courrier/templates', requireAuth, (req, res) => {
  try {
    const { templates } = req.body;
    if (!templates) return res.status(400).json({ error: 'Templates manquants' });
    const config = loadJSON('parcoursup-config.json');
    config.courrierTemplates = templates;
    saveJSON('parcoursup-config.json', config);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ GENERATEUR HTML COURRIER (factorisation) ============
function generateCourrierHTML({ title, pages, single }) {
  const pageCount = pages.length;
  const pagesHTML = pages.map((p, idx) => {
    const civilite = p.candidate.genre === 'F' ? 'Mme' : p.candidate.genre === 'G' ? 'M.' : '';
    return `
      <div class="page">
        <div class="logos-bar">
          ${p.logoSrc ? `<img src="${p.logoSrc}" alt="Logo ${p.ecole}" class="logo-ecole">` : `<span></span>`}
          ${LOGO_PARCOURSUP_BASE64 ? `<img src="${LOGO_PARCOURSUP_BASE64}" alt="Parcoursup" class="logo-parcoursup">` : ''}
        </div>
        <div class="expediteur">
          <strong>${p.ecole}</strong><br>
          ${p.ecoleAddr.adresse || ''}<br>
          ${p.ecoleAddr.codePostal || ''} ${p.ecoleAddr.ville || ''}
        </div>
        <div class="destinataire">
          <strong>${civilite} ${p.candidate.prenom || ''} ${p.candidate.nom || ''}</strong><br>
          ${p.candidate.adresse || ''}<br>
          ${p.candidate.codePostal || ''} ${p.candidate.ville || ''}
        </div>
        <div class="date-lieu">${p.ecoleAddr.ville || 'Bordeaux'}, le ${p.dateJour}</div>
        <div class="content">${p.content}</div>
      </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>${title}</title>
<style>
  /* Police systeme 100% fiable pour accents francais (UTF-8 complet).
     Pas de Google Fonts car stylesheet distante peut echouer dans popup Blob. */
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', 'Helvetica Neue', 'Arial Unicode MS', 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif;
    font-size: 10pt;
    line-height: 1.3;
    color: #222;
    margin: 0;
    padding: 0;
  }
  /* Toolbar impression */
  .print-toolbar {
    display: flex; justify-content: flex-end; gap: 10px;
    padding: 10px 20px; background: #f8f9fa; border-bottom: 1px solid #ddd;
    position: sticky; top: 0; z-index: 100;
  }
  .print-toolbar button {
    padding: 8px 20px; border: none; border-radius: 6px;
    font-size: 13px; font-weight: 600; cursor: pointer;
    font-family: 'Segoe UI', Arial, sans-serif;
  }
  .btn-print { background: #9B59B6; color: white; }
  .btn-print:hover { background: #8E44AD; }
  .btn-close { background: #95A5A6; color: white; }
  .btn-close:hover { background: #7F8C8D; }
  /* Page A4 - dimensions exactes pour calibrage précis
     Padding interne : 15mm haut, 18mm droite, 12mm bas, 20mm gauche */
  .page {
    width: 210mm;
    height: 297mm;
    padding: 15mm 18mm 12mm 20mm;
    page-break-after: always;
    position: relative;
    overflow: hidden;
    margin: 0 auto;
  }
  .page:last-child { page-break-after: avoid; }
  /* Double logos : ecole a gauche, Parcoursup a droite */
  .logos-bar {
    display: flex; justify-content: space-between; align-items: center;
    height: 18mm;
    margin-bottom: 3mm;
  }
  .logo-ecole { max-height: 16mm; max-width: 55mm; object-fit: contain; }
  .logo-parcoursup { max-height: 14mm; max-width: 45mm; object-fit: contain; margin-right: 25mm; }
  /* Expediteur en haut a gauche */
  .expediteur {
    font-size: 8.5pt;
    line-height: 1.3;
    color: #444;
    margin-bottom: 2mm;
    max-width: 85mm;
  }
  .expediteur strong { font-size: 9.5pt; color: #222; }
  /* Destinataire : position absolue, calibrée sur la norme AFNOR NF Z 10-011
     pour enveloppe DL à fenêtre droite (110x220mm).
     - top: 45mm depuis le haut de la page A4
     - left: 110mm depuis le bord gauche
     - Taille zone adresse : 85mm x 35mm
     Ces valeurs sont testées pour rester visibles dans la fenêtre lors du pliage
     accordéon standard d'une feuille A4 en enveloppe DL. */
  .destinataire {
    position: absolute;
    top: 55mm;
    left: 110mm;
    width: 85mm;
    min-height: 35mm;
    font-size: 10pt;
    line-height: 1.4;
    color: #000;
  }
  .destinataire strong { font-size: 10.5pt; }
  /* Date + lieu - positionné en dessous de la zone d'adresse */
  .date-lieu {
    margin-left: 90mm;
    margin-top: 55mm;
    margin-bottom: 5mm;
    font-size: 9.5pt;
    color: #555;
  }
  /* Contenu lettre - optimisé pour tenir sur 1 page */
  .content {
    white-space: pre-wrap;
    text-align: justify;
    font-size: 9.5pt;
    line-height: 1.3;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  /* Impression */
  @media print {
    .print-toolbar { display: none !important; }
    body { padding: 0; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { margin: 0; box-shadow: none; }
  }
  /* Ecran : apercu avec ombre page */
  @media screen {
    body { background: #e5e5e5; padding: 20px 0; }
    .page { background: white; box-shadow: 0 2px 12px rgba(0,0,0,0.15); margin: 0 auto 20px; }
  }
</style>
</head><body>
<div class="print-toolbar">
  <button class="btn-print" onclick="window.print()">Imprimer / PDF${pageCount > 1 ? ` (${pageCount} pages)` : ''}</button>
  <button class="btn-close" onclick="window.close()">Fermer</button>
</div>
${pagesHTML}
</body></html>`;
}

// ============ GENERATION PDF COURRIER ============
app.post('/parcoursup/api/courrier/pdf', (req, res) => {
  try {
    const { candidateId, content, type } = req.body;
    const candidates = loadJSON('parcoursup-candidates.json');
    const candidate = candidates.find(c => c.id === candidateId);
    if (!candidate) return res.status(404).json({ error: 'Candidat non trouvé' });

    const config = loadJSON('parcoursup-config.json');
    const ecoleAddr = ECOLES_ADRESSES[candidate.ecole] || {};
    const finalContent = replaceTemplateVars(content, candidate, config);
    const dateJour = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const logoSrc = LOGOS_BASE64[candidate.ecole] || '';

    // Historiser l'action comme relance
    const relances = loadJSON('parcoursup-relances.json');
    relances.push({
      id: genId(),
      candidateId,
      type: 'courrier',
      date: new Date().toISOString(),
      notes: `[COURRIER] ${type || 'Courrier'} généré en PDF`,
      result: 'envoye',
      createdBy: req.body.createdBy || ''
    });
    saveJSON('parcoursup-relances.json', relances);
    broadcast('relances');

    // Générer le HTML du PDF avec double logo + mise en page enveloppe
    const html = generateCourrierHTML({
      title: `Courrier - ${candidate.prenom || ''} ${candidate.nom || ''}`,
      pages: [{
        logoSrc,
        ecole: candidate.ecole || '',
        ecoleAddr,
        candidate,
        dateJour,
        content: finalContent
      }],
      single: true
    });

    res.json({ ok: true, html, candidateName: `${candidate.prenom} ${candidate.nom}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ GENERATION PDF COURRIER MULTI-FICHES ============
app.post('/parcoursup/api/courrier/pdf-multi', (req, res) => {
  try {
    const { candidateIds, content, type } = req.body;
    if (!candidateIds || !Array.isArray(candidateIds) || candidateIds.length === 0) {
      return res.status(400).json({ error: 'candidateIds requis' });
    }
    const candidates = loadJSON('parcoursup-candidates.json');
    const config = loadJSON('parcoursup-config.json');
    const relances = loadJSON('parcoursup-relances.json');
    const pages = [];

    candidateIds.forEach(cid => {
      const candidate = candidates.find(c => c.id === cid);
      if (!candidate) return;
      const ecoleAddr = ECOLES_ADRESSES[candidate.ecole] || {};
      const finalContent = replaceTemplateVars(content, candidate, config);
      const dateJour = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
      const logoSrc = LOGOS_BASE64[candidate.ecole] || '';

      // Historiser chaque courrier
      relances.push({
        id: genId(),
        candidateId: cid,
        type: 'courrier',
        date: new Date().toISOString(),
        notes: `[COURRIER] ${type || 'Courrier'} généré en PDF`,
        result: 'envoye',
        createdBy: req.body.createdBy || ''
      });

      pages.push({
        logoSrc,
        ecole: candidate.ecole || '',
        ecoleAddr,
        candidate,
        dateJour,
        content: finalContent
      });
    });

    saveJSON('parcoursup-relances.json', relances);
    broadcast('relances');

    const html = generateCourrierHTML({
      title: `Courriers - ${candidateIds.length} fiche(s)`,
      pages,
      single: false
    });

    res.json({ ok: true, html, count: pages.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ RELANCES ============
app.get('/parcoursup/api/relances', (req, res) => {
  let relances = loadJSON('parcoursup-relances.json');
  if (req.query.candidateId) {
    relances = relances.filter(r => r.candidateId === req.query.candidateId);
  }
  res.json(relances);
});

app.post('/parcoursup/api/relances', (req, res) => {
  const relances = loadJSON('parcoursup-relances.json');
  const relance = {
    id: genId(),
    candidateId: req.body.candidateId,
    type: req.body.type || 'telephone',
    date: req.body.date || new Date().toISOString(),
    notes: req.body.notes || '',
    result: req.body.result || 'autre',
    createdBy: req.body.createdBy || ''
  };
  relances.push(relance);
  saveJSON('parcoursup-relances.json', relances);
  broadcast('relances');
  res.json(relance);
});

app.delete('/parcoursup/api/relances/:id', (req, res) => {
  let relances = loadJSON('parcoursup-relances.json');
  relances = relances.filter(r => r.id !== req.params.id);
  saveJSON('parcoursup-relances.json', relances);
  res.json({ success: true });
});

// ============ DUPLICATES ============
function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '').replace(/^33/, '0');
}

function normalizeEmail(email) {
  return (email || '').toLowerCase().trim();
}

function normalizeName(nom, prenom) {
  return ((nom || '') + (prenom || '')).toLowerCase().replace(/\s+/g, '').trim();
}

app.get('/parcoursup/api/duplicates', (req, res) => {
  const candidates = loadJSON('parcoursup-candidates.json');
  const groups = [];
  const visited = new Set();

  for (let i = 0; i < candidates.length; i++) {
    if (visited.has(i)) continue;
    const group = [candidates[i]];
    visited.add(i);

    for (let j = i + 1; j < candidates.length; j++) {
      if (visited.has(j)) continue;
      let matches = 0;
      const a = candidates[i], b = candidates[j];

      if (normalizeEmail(a.email) && normalizeEmail(a.email) === normalizeEmail(b.email)) matches++;
      if (normalizePhone(a.telephone) && normalizePhone(a.telephone) === normalizePhone(b.telephone)) matches++;
      if (normalizeName(a.nom, a.prenom) && normalizeName(a.nom, a.prenom) === normalizeName(b.nom, b.prenom)) matches++;

      if (matches >= 2) {
        group.push(candidates[j]);
        visited.add(j);
      }
    }
    if (group.length > 1) groups.push(group);
  }
  res.json({ groups, total: groups.length });
});

app.post('/parcoursup/api/duplicates/merge', (req, res) => {
  const { keepId, removeIds } = req.body;
  let candidates = loadJSON('parcoursup-candidates.json');
  let relances = loadJSON('parcoursup-relances.json');

  // Transfer relances to kept candidate
  relances = relances.map(r =>
    removeIds.includes(r.candidateId) ? { ...r, candidateId: keepId } : r
  );

  // Remove duplicate candidates
  candidates = candidates.filter(c => !removeIds.includes(c.id));

  saveJSON('parcoursup-candidates.json', candidates);
  saveJSON('parcoursup-relances.json', relances);
  broadcast('candidates');
  res.json({ success: true, remaining: candidates.length });
});

// ============ STATS ============
app.get('/parcoursup/api/stats', (req, res) => {
  const allCandidates = loadJSON('parcoursup-candidates.json');
  const allRelances = loadJSON('parcoursup-relances.json');
  const ecoleFilter = req.query.ecole || null;
  const candidates = ecoleFilter ? allCandidates.filter(c => c.ecole === ecoleFilter) : allCandidates;
  const candidateIds = new Set(candidates.map(c => c.id));
  const relances = ecoleFilter ? allRelances.filter(r => candidateIds.has(r.candidateId)) : allRelances;

  // Par ecole (toujours toutes les ecoles pour le filtre)
  const parEcole = {};
  allCandidates.forEach(c => {
    parEcole[c.ecole] = (parEcole[c.ecole] || 0) + 1;
  });

  // Par stage
  const parStage = {};
  candidates.forEach(c => {
    parStage[c.stage] = (parStage[c.stage] || 0) + 1;
  });

  // Par formation
  const parFormation = {};
  candidates.forEach(c => {
    const key = `${c.ecole} - ${c.formation}`;
    parFormation[key] = (parFormation[key] || 0) + 1;
  });

  // Conversion
  const total = candidates.length;
  const inscrits = candidates.filter(c => c.stage === 'inscrit').length;
  const admis = candidates.filter(c => c.stage === 'admis').length;

  // Relances par type
  const relancesParType = {};
  relances.forEach(r => {
    relancesParType[r.type] = (relancesParType[r.type] || 0) + 1;
  });

  // Par charge admission
  const parCharge = {};
  candidates.forEach(c => {
    if (!c.chargeAdmission) return;
    if (!parCharge[c.chargeAdmission]) {
      parCharge[c.chargeAdmission] = { total: 0, inscrits: 0, contactes: 0 };
    }
    parCharge[c.chargeAdmission].total++;
    if (c.stage === 'inscrit') parCharge[c.chargeAdmission].inscrits++;
    if (c.stage !== 'voeu_recu') parCharge[c.chargeAdmission].contactes++;
  });

  // Relances par jour (30 derniers jours)
  const now = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const relancesParJour = {};
  relances.forEach(r => {
    const d = new Date(r.date);
    if (d >= thirtyDaysAgo) {
      const key = d.toISOString().split('T')[0];
      relancesParJour[key] = (relancesParJour[key] || 0) + 1;
    }
  });

  // Doublons
  let doublons = 0;
  const visited = new Set();
  for (let i = 0; i < candidates.length; i++) {
    if (visited.has(i)) continue;
    let hasDouble = false;
    for (let j = i + 1; j < candidates.length; j++) {
      if (visited.has(j)) continue;
      let matches = 0;
      const a = candidates[i], b = candidates[j];
      if (normalizeEmail(a.email) && normalizeEmail(a.email) === normalizeEmail(b.email)) matches++;
      if (normalizePhone(a.telephone) && normalizePhone(a.telephone) === normalizePhone(b.telephone)) matches++;
      if (normalizeName(a.nom, a.prenom) && normalizeName(a.nom, a.prenom) === normalizeName(b.nom, b.prenom)) matches++;
      if (matches >= 2) {
        visited.add(j);
        hasDouble = true;
      }
    }
    if (hasDouble) doublons++;
  }

  // Par ecole et stage (pour graphiques croises)
  const parEcoleStage = {};
  candidates.forEach(c => {
    if (!parEcoleStage[c.ecole]) parEcoleStage[c.ecole] = {};
    parEcoleStage[c.ecole][c.stage] = (parEcoleStage[c.ecole][c.stage] || 0) + 1;
  });

  // ===== STATS DÉTAILLÉES PAR CHARGÉ D'ADMISSION =====
  const config = loadJSON('parcoursup-config.json');
  const stages = config.stages || [];

  // Périodes : aujourd'hui, cette semaine (lundi), ce mois
  const todayStr = now.toISOString().split('T')[0];
  const dayOfWeek = now.getDay(); // 0=dim, 1=lun...
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - mondayOffset);
  weekStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Actions détaillées par chargé d'admission
  const chargeDetails = {};
  const allCharges = [...new Set(candidates.map(c => c.chargeAdmission).filter(Boolean))];

  allCharges.forEach(charge => {
    const myCandidates = candidates.filter(c => c.chargeAdmission === charge);
    const myRelances = relances.filter(r => myCandidates.some(c => c.id === r.candidateId));
    const myCandidateIds = new Set(myCandidates.map(c => c.id));

    // Actions par période
    const relancesToday = myRelances.filter(r => r.date && r.date.startsWith(todayStr));
    const relancesWeek = myRelances.filter(r => r.date && new Date(r.date) >= weekStart);
    const relancesMonth = myRelances.filter(r => r.date && new Date(r.date) >= monthStart);

    // Actions par type
    const actionsByType = {};
    myRelances.forEach(r => {
      actionsByType[r.type] = (actionsByType[r.type] || 0) + 1;
    });

    // Pipeline (combien dans chaque colonne)
    const pipeline = {};
    stages.forEach(s => {
      pipeline[s.id] = myCandidates.filter(c => c.stage === s.id).length;
    });

    // Taux de transformation CRM
    const crmCount = myCandidates.filter(c => c.statutCRM).length;
    const tauxCRM = myCandidates.length > 0 ? Math.round((crmCount / myCandidates.length) * 100) : 0;

    // Taux d'inscrits
    const inscritCount = myCandidates.filter(c => c.stage === 'inscrit').length;
    const tauxInscrit = myCandidates.length > 0 ? Math.round((inscritCount / myCandidates.length) * 100) : 0;

    // Temps moyen par stage (basé sur relances: temps entre création candidat et première relance)
    const tempsTraitement = {};
    stages.forEach(s => {
      const stageCandidates = myCandidates.filter(c => c.stage === s.id);
      if (stageCandidates.length === 0) return;
      let totalHours = 0;
      let counted = 0;
      stageCandidates.forEach(c => {
        const cRelances = myRelances.filter(r => r.candidateId === c.id);
        if (cRelances.length > 0 && c.createdAt) {
          const firstRelance = cRelances.sort((a, b) => new Date(a.date) - new Date(b.date))[0];
          const diffMs = new Date(firstRelance.date) - new Date(c.createdAt);
          totalHours += diffMs / (1000 * 60 * 60);
          counted++;
        }
      });
      if (counted > 0) {
        tempsTraitement[s.id] = Math.round((totalHours / counted) * 10) / 10;
      }
    });

    // Relances par jour (7 derniers jours) pour sparkline
    const last7Days = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      last7Days[key] = 0;
    }
    myRelances.forEach(r => {
      if (r.date) {
        const key = r.date.substring(0, 10);
        if (key in last7Days) last7Days[key]++;
      }
    });

    // Candidats sans aucune relance (à traiter)
    const sansRelance = myCandidates.filter(c => !myRelances.some(r => r.candidateId === c.id)).length;

    chargeDetails[charge] = {
      totalCandidats: myCandidates.length,
      relancesTotal: myRelances.length,
      relancesToday: relancesToday.length,
      relancesWeek: relancesWeek.length,
      relancesMonth: relancesMonth.length,
      actionsByType,
      pipeline,
      crmCount,
      tauxCRM,
      inscritCount,
      tauxInscrit,
      tempsTraitement,
      last7Days,
      sansRelance
    };
  });

  // Classement global: actions cette semaine
  const classementSemaine = allCharges
    .map(charge => ({ charge, actions: chargeDetails[charge].relancesWeek }))
    .sort((a, b) => b.actions - a.actions);

  // Taux basculement CRM global
  const totalCRM = candidates.filter(c => c.statutCRM).length;
  const tauxCRMGlobal = total > 0 ? Math.round((totalCRM / total) * 100) : 0;

  // Temps moyen global par stage
  const tempsGlobalParStage = {};
  stages.forEach(s => {
    const stageCandidates = candidates.filter(c => c.stage === s.id);
    if (stageCandidates.length === 0) return;
    let totalH = 0, cnt = 0;
    stageCandidates.forEach(c => {
      const cRel = relances.filter(r => r.candidateId === c.id);
      if (cRel.length > 0 && c.createdAt) {
        const first = cRel.sort((a, b) => new Date(a.date) - new Date(b.date))[0];
        const diff = new Date(first.date) - new Date(c.createdAt);
        totalH += diff / (1000 * 60 * 60);
        cnt++;
      }
    });
    if (cnt > 0) tempsGlobalParStage[s.id] = Math.round((totalH / cnt) * 10) / 10;
  });

  res.json({
    total,
    inscrits,
    admis,
    conversion: total > 0 ? Math.round((inscrits / total) * 100) : 0,
    parEcole,
    parStage,
    parFormation,
    relancesTotal: relances.length,
    relancesParType,
    parCharge,
    relancesParJour,
    doublons,
    parEcoleStage,
    // Nouvelles stats
    chargeDetails,
    classementSemaine,
    totalCRM,
    tauxCRMGlobal,
    tempsGlobalParStage
  });
});

// ============ AUTOMATIONS ============

// Get automations
app.get('/parcoursup/api/automations', (req, res) => {
  const config = loadJSON('parcoursup-config.json');
  res.json(config.automations || {});
});

// Save automations (keyed by stageId)
app.post('/parcoursup/api/automations', (req, res) => {
  const config = loadJSON('parcoursup-config.json');
  config.automations = req.body;
  saveJSON('parcoursup-config.json', config);
  res.json({ success: true });
});

// ============ SEND QUEUE ============

// Get queue
app.get('/parcoursup/api/queue', (req, res) => {
  const queue = loadJSON('parcoursup-queue.json');
  res.json(queue);
});

// Add to queue (manual bulk send or automation trigger)
app.post('/parcoursup/api/queue', (req, res) => {
  const queue = loadJSON('parcoursup-queue.json');
  const items = req.body.items || [];
  const now = new Date();
  items.forEach(item => {
    queue.push({
      id: genId(),
      candidateId: item.candidateId,
      candidateName: item.candidateName || '',
      candidateEmail: item.candidateEmail || '',
      candidatePhone: item.candidatePhone || '',
      channel: item.channel || 'mail', // mail, whatsapp
      subject: item.subject || '',
      message: item.message || '',
      imageUrl: item.imageUrl || '',
      stageId: item.stageId || '',
      stageLabel: item.stageLabel || '',
      scheduledAt: item.scheduledAt || now.toISOString(),
      status: 'pending', // pending, sent, failed
      createdAt: now.toISOString(),
      sentAt: null,
      error: null,
      automationId: item.automationId || null
    });
  });
  saveJSON('parcoursup-queue.json', queue);
  res.json({ queued: items.length, total: queue.length });
});

// Cancel a queued item
app.delete('/parcoursup/api/queue/:id', (req, res) => {
  let queue = loadJSON('parcoursup-queue.json');
  queue = queue.filter(q => q.id !== req.params.id);
  saveJSON('parcoursup-queue.json', queue);
  res.json({ success: true });
});

// Process queue - uses the shared processQueue function
app.post('/parcoursup/api/queue/process', async (req, res) => {
  await processQueue();
  res.json({ ok: true });
});

// Trigger automation for a candidate entering a stage
app.post('/parcoursup/api/automations/trigger', (req, res) => {
  const { candidateId, stageId } = req.body;
  const config = loadJSON('parcoursup-config.json');
  const candidates = loadJSON('parcoursup-candidates.json');
  const queue = loadJSON('parcoursup-queue.json');

  const candidate = candidates.find(c => c.id === candidateId);
  if (!candidate) return res.status(404).json({ error: 'Candidat non trouvé' });

  const automations = config.automations || {};
  const stageAutos = automations[stageId];
  if (!stageAutos || !stageAutos.enabled) return res.json({ triggered: 0 });

  const stageInfo = (config.stages || []).find(s => s.id === stageId);
  const now = new Date();
  let triggered = 0;

  // Check if automation already triggered for this candidate+stage (avoid duplicates)
  const alreadyQueued = queue.some(q =>
    q.candidateId === candidateId &&
    q.stageId === stageId &&
    q.automationId &&
    (q.status === 'pending' || q.status === 'sent')
  );
  if (alreadyQueued) return res.json({ triggered: 0, reason: 'already_queued' });

  (stageAutos.actions || []).forEach(action => {
    const delayMs = (action.delayMinutes || 0) * 60 * 1000;
    const scheduledAt = new Date(now.getTime() + delayMs);

    // Replace template variables
    let message = replaceTemplateVars(action.message, candidate, config);
    let subject = replaceTemplateVars(action.subject, candidate, config);

    queue.push({
      id: genId(),
      candidateId: candidate.id,
      candidateName: `${candidate.prenom} ${candidate.nom}`,
      candidateEmail: candidate.email || '',
      candidatePhone: candidate.telephone || '',
      channel: action.channel || 'mail',
      subject,
      message,
      imageUrl: action.imageUrl || '',
      stageId,
      stageLabel: stageInfo?.label || stageId,
      scheduledAt: scheduledAt.toISOString(),
      status: 'pending',
      createdAt: now.toISOString(),
      sentAt: null,
      error: null,
      automationId: stageAutos.id || stageId
    });
    triggered++;
  });

  saveJSON('parcoursup-queue.json', queue);
  res.json({ triggered });
});

// Trigger automation for ALL candidates currently in a stage (retroactive)
// Accepte optionnellement candidateIds: string[] pour cibler un sous-ensemble
// (par ex. seulement les candidats d'une formation precise).
app.post('/parcoursup/api/automations/trigger-all', (req, res) => {
  const { stageId, candidateIds } = req.body;
  const config = loadJSON('parcoursup-config.json');
  const candidates = loadJSON('parcoursup-candidates.json');
  const queue = loadJSON('parcoursup-queue.json');

  const automations = config.automations || {};
  const stageAutos = automations[stageId];
  if (!stageAutos || !stageAutos.enabled) {
    return res.json({ triggered: 0, reason: 'automation_disabled' });
  }

  // Si candidateIds fourni, on intersecte avec stage (l'automatisation est
  // toujours liee au stage, on ne la deborde pas vers des candidats hors stage).
  let stageCandidates;
  if (Array.isArray(candidateIds) && candidateIds.length > 0) {
    const idSet = new Set(candidateIds);
    stageCandidates = candidates.filter(c => idSet.has(c.id) && c.stage === stageId);
  } else {
    stageCandidates = candidates.filter(c => c.stage === stageId);
  }
  const stageInfo = (config.stages || []).find(s => s.id === stageId);
  const now = new Date();
  let totalTriggered = 0;

  stageCandidates.forEach(candidate => {
    // Check if automation already triggered for this candidate+stage
    const alreadyQueued = queue.some(q =>
      q.candidateId === candidate.id &&
      q.stageId === stageId &&
      q.automationId &&
      (q.status === 'pending' || q.status === 'sent')
    );
    if (alreadyQueued) return;

    (stageAutos.actions || []).forEach(action => {
      const delayMs = (action.delayMinutes || 0) * 60 * 1000;
      const scheduledAt = new Date(now.getTime() + delayMs);

      let message = replaceTemplateVars(action.message, candidate, config);
      let subject = replaceTemplateVars(action.subject, candidate, config);

      queue.push({
        id: genId(), candidateId: candidate.id,
        candidateName: `${candidate.prenom} ${candidate.nom}`,
        candidateEmail: candidate.email || '', candidatePhone: candidate.telephone || '',
        channel: action.channel || 'mail', subject, message, stageId,
        imageUrl: action.imageUrl || '',
        stageLabel: stageInfo?.label || stageId,
        scheduledAt: scheduledAt.toISOString(), status: 'pending',
        createdAt: now.toISOString(), sentAt: null, error: null,
        automationId: stageAutos.id || stageId
      });
      totalTriggered++;
    });
  });

  saveJSON('parcoursup-queue.json', queue);
  console.log(`[Auto] Retroactive trigger: ${totalTriggered} action(s) for ${stageCandidates.length} candidate(s) in ${stageId}`);
  res.json({ triggered: totalTriggered, candidates: stageCandidates.length });
});

// Bulk send to candidates in a stage (avec filtrage optionnel)
// Accepte optionnellement candidateIds: string[] pour cibler un sous-ensemble
// du stage (par ex. uniquement la formation BTS MCO de la colonne PDR).
// Si candidateIds est absent ou vide, comportement legacy: tous les candidats du stage.
app.post('/parcoursup/api/queue/bulk-send', (req, res) => {
  const { stageId, channel, subject, message, delayMinutes, imageUrl, candidateIds } = req.body;
  const candidates = loadJSON('parcoursup-candidates.json');
  const config = loadJSON('parcoursup-config.json');
  const queue = loadJSON('parcoursup-queue.json');

  let stageCandidates;
  if (Array.isArray(candidateIds) && candidateIds.length > 0) {
    const idSet = new Set(candidateIds);
    stageCandidates = candidates.filter(c => idSet.has(c.id));
  } else {
    stageCandidates = candidates.filter(c => c.stage === stageId);
  }
  const stageInfo = (config.stages || []).find(s => s.id === stageId);
  const now = new Date();
  const delayMs = (delayMinutes || 0) * 60 * 1000;
  const scheduledAt = new Date(now.getTime() + delayMs);

  stageCandidates.forEach(candidate => {
    let msg = replaceTemplateVars(message, candidate, config);
    let subj = replaceTemplateVars(subject, candidate, config);

    queue.push({
      id: genId(),
      candidateId: candidate.id,
      candidateName: `${candidate.prenom} ${candidate.nom}`,
      candidateEmail: candidate.email || '',
      candidatePhone: candidate.telephone || '',
      channel: channel || 'mail',
      subject: subj,
      message: msg,
      imageUrl: imageUrl || '',
      stageId,
      stageLabel: stageInfo?.label || stageId,
      scheduledAt: scheduledAt.toISOString(),
      status: 'pending',
      createdAt: now.toISOString(),
      sentAt: null,
      error: null,
      automationId: null
    });
  });

  saveJSON('parcoursup-queue.json', queue);
  res.json({ queued: stageCandidates.length });
});

// ============ SMTP CONFIG ============

function getSmtpConfig() {
  // 1. Config sauvegardee via l'interface (prioritaire sur les vars d'env)
  const pConfig = loadJSON('parcoursup-config.json');
  if (pConfig.smtp && pConfig.smtp.host && pConfig.smtp.user && pConfig.smtp.pass) {
    return pConfig.smtp;
  }
  // 2. Variables d'environnement (fallback pour deploiements cloud)
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      fromName: process.env.SMTP_FROM_NAME || 'Service Admissions'
    };
  }
  // 3. Fallback config admission partagee
  const aConfig = loadJSON('admission-config.json');
  if (aConfig.smtp && aConfig.smtp.host) return aConfig.smtp;
  return null;
}

app.get('/parcoursup/api/smtp-config', (req, res) => {
  const smtp = getSmtpConfig();
  if (!smtp) return res.json({ configured: false, host: '', port: 587, user: '', fromName: 'CRM Parcoursup' });
  res.json({
    host: smtp.host || '',
    port: smtp.port || 587,
    user: smtp.user ? smtp.user.substring(0, 5) + '***' : '',
    fromName: smtp.fromName || 'CRM Parcoursup',
    configured: !!(smtp.host && smtp.user && smtp.pass),
  });
});

app.post('/parcoursup/api/smtp-config', (req, res) => {
  const config = loadJSON('parcoursup-config.json');
  const { host, port, user, pass, fromName } = req.body;
  config.smtp = { host, port: parseInt(port) || 587, user, pass, fromName: fromName || 'CRM Parcoursup' };
  saveJSON('parcoursup-config.json', config);
  res.json({ ok: true, message: 'Configuration SMTP sauvegardée' });
});

app.post('/parcoursup/api/smtp-test', async (req, res) => {
  const smtp = getSmtpConfig();
  if (!smtp || !smtp.host) return res.json({ ok: false, error: 'SMTP non configuré' });
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host, port: smtp.port || 587, secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
    });
    await transporter.verify();
    res.json({ ok: true, message: 'Connexion SMTP réussie !' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/parcoursup/api/send-email', async (req, res) => {
  const smtp = getSmtpConfig();
  if (!smtp || !smtp.host) return res.status(400).json({ error: 'SMTP non configuré' });
  const { to, subject, body, imageUrl, replyTo } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'Champs requis: to, subject, body' });
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host, port: smtp.port || 587, secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
    });
    let htmlBody = body.replace(/\n/g, '<br>');
    if (imageUrl) {
      htmlBody += `<br><br><img src="${imageUrl}" alt="" style="max-width:100%;height:auto;border-radius:8px;" />`;
    }
    const mailOptions = {
      from: `"${smtp.fromName || 'CRM Parcoursup'}" <${smtp.user}>`,
      to, subject,
      html: htmlBody,
    };
    if (replyTo) mailOptions.replyTo = replyTo;
    const info = await transporter.sendMail(mailOptions);
    res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ WHATSAPP API ============

app.get('/parcoursup/api/whatsapp/status', (req, res) => {
  res.json({
    status: waStatus,
    qrCode: waQRCode,
    phone: waInfo ? waInfo.wid.user : null,
    name: waInfo ? waInfo.pushname : null,
  });
});

// Envoi WhatsApp manuel a 1 candidat (depuis la fiche). Permet d'envoyer
// un message personnalise (eventuellement issu d'un modele par stage) via
// le compte WhatsApp connecte au serveur. Log automatiquement une relance.
app.post('/parcoursup/api/whatsapp/send-individual', async (req, res) => {
  const { candidateId, message } = req.body || {};
  if (!candidateId || !message || !String(message).trim()) {
    return res.status(400).json({ ok: false, error: 'candidateId et message requis' });
  }
  const candidates = loadJSON('parcoursup-candidates.json');
  const candidate = candidates.find(c => c.id === candidateId);
  if (!candidate) return res.status(404).json({ ok: false, error: 'Candidat introuvable' });
  if (!candidate.telephone) return res.status(400).json({ ok: false, error: 'Aucun telephone sur la fiche du candidat' });

  // Substitution des variables du template ({{prenom}}, etc.)
  const config = loadJSON('parcoursup-config.json');
  const finalMessage = replaceTemplateVars(String(message), candidate, config);

  try {
    const chatId = await sendWhatsApp(candidate.telephone, finalMessage);
    // Log relance
    const relances = loadJSON('parcoursup-relances.json');
    relances.push({
      id: genId(),
      candidateId: candidate.id,
      type: 'whatsapp',
      date: new Date().toISOString(),
      notes: `[INDIVIDUEL] ${finalMessage.substring(0, 200)}${finalMessage.length > 200 ? '...' : ''}`,
      result: 'envoye',
      createdBy: 'Manuel'
    });
    saveJSON('parcoursup-relances.json', relances);
    broadcast('relances');
    res.json({ ok: true, chatId, sent: finalMessage });
  } catch (e) {
    console.error('[WhatsApp individuel] Erreur envoi a', candidate.telephone, ':', e.message);
    // Log la tentative ratee aussi
    const relances = loadJSON('parcoursup-relances.json');
    relances.push({
      id: genId(),
      candidateId: candidate.id,
      type: 'whatsapp',
      date: new Date().toISOString(),
      notes: `[INDIVIDUEL ECHEC] ${e.message}`,
      result: 'echoue',
      createdBy: 'Manuel'
    });
    saveJSON('parcoursup-relances.json', relances);
    broadcast('relances');
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/parcoursup/api/whatsapp/reconnect', (req, res) => {
  if (waClient) {
    try { waClient.destroy(); } catch(e) {}
  }
  waStatus = 'disconnected';
  waQRCode = null;
  waInfo = null;
  setTimeout(initWhatsApp, 1000);
  res.json({ ok: true, message: 'Reconnexion lancée...' });
});

app.post('/parcoursup/api/whatsapp/logout', async (req, res) => {
  try {
    if (waClient) await waClient.logout();
    waStatus = 'disconnected';
    waQRCode = null;
    waInfo = null;
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ============ SYNCHRONISATION HISTORIQUE WHATSAPP ============
// Récupère les messages récents (reçus + envoyés manuellement) pour tous les
// candidats dont le téléphone correspond à un chat WhatsApp, et les injecte
// dans l'historique des relances s'ils ne sont pas déjà présents.
// Utile si le serveur a été down ou si le chargé a répondu depuis son téléphone.
app.post('/parcoursup/api/whatsapp/sync', async (req, res) => {
  if (!waClient || waStatus !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp non connecté. Connectez-vous d\'abord.' });
  }
  try {
    const daysBack = Math.min(parseInt(req.body.days) || 7, 30);
    const cutoff = Date.now() - daysBack * 24 * 3600 * 1000;
    const candidates = loadJSON('parcoursup-candidates.json');
    const relances = loadJSON('parcoursup-relances.json');
    let imported = 0;
    let scanned = 0;

    for (const candidate of candidates) {
      if (!candidate.telephone) continue;
      let phone = candidate.telephone.replace(/[\s\-\.]/g, '');
      if (phone.startsWith('0')) phone = '33' + phone.substring(1);
      if (phone.startsWith('+')) phone = phone.substring(1);
      if (!/^\d{8,15}$/.test(phone)) continue;
      const chatId = phone + '@c.us';

      try {
        const chat = await waClient.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: 50 });
        scanned++;

        for (const msg of messages) {
          const msgTs = (msg.timestamp || 0) * 1000;
          if (msgTs < cutoff) continue;
          const msgBody = (msg.body || '').substring(0, 500);
          if (!msgBody) continue;
          const marker = msg.fromMe ? '[ENVOYE]' : '[REÇU]';

          // Dedup : pas de doublon si même candidat + même type + fenêtre ±60s + même début de message
          const bodyPrefix = msgBody.substring(0, 40);
          const dup = relances.some(r =>
            r.candidateId === candidate.id &&
            r.type === 'whatsapp' &&
            Math.abs(new Date(r.date).getTime() - msgTs) < 60000 &&
            (r.notes || '').includes(bodyPrefix)
          );
          if (dup) continue;

          relances.push({
            id: genId(),
            candidateId: candidate.id,
            type: 'whatsapp',
            date: new Date(msgTs).toISOString(),
            notes: `${marker} ${msgBody}`,
            result: msg.fromMe ? 'envoye' : 'repondu',
            createdBy: msg.fromMe ? 'Synchro WhatsApp' : `${candidate.prenom || ''} ${candidate.nom || ''}`.trim()
          });
          imported++;
        }
      } catch (e) {
        // Chat inexistant, candidat pas sur WhatsApp, ou erreur réseau : on ignore
      }
    }

    if (imported > 0) {
      saveJSON('parcoursup-relances.json', relances);
      broadcast('relances');
    }
    console.log(`[WhatsApp Sync] ${scanned} chats scannés, ${imported} messages importés`);
    res.json({ ok: true, imported, scanned, daysBack });
  } catch (e) {
    console.error('[WhatsApp Sync] Erreur:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ QUEUE PROCESSOR (auto-run every 30s) ============

async function sendEmail(to, subject, body, imageUrl, replyTo) {
  const smtp = getSmtpConfig();
  if (!smtp || !smtp.host) throw new Error('SMTP non configuré');
  const transporter = nodemailer.createTransport({
    host: smtp.host, port: smtp.port || 587, secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  let htmlBody = body.replace(/\n/g, '<br>');
  if (imageUrl) {
    htmlBody += `<br><br><img src="${imageUrl}" alt="" style="max-width:100%;height:auto;border-radius:8px;" />`;
  }
  const mailOptions = {
    from: `"${smtp.fromName || 'CRM Parcoursup'}" <${smtp.user}>`,
    to, subject: subject || '(sans objet)',
    html: htmlBody,
  };
  if (replyTo) mailOptions.replyTo = replyTo;
  const info = await transporter.sendMail(mailOptions);
  return info.messageId;
}

async function processQueue() {
  const queue = loadJSON('parcoursup-queue.json');
  const relances = loadJSON('parcoursup-relances.json');
  const candidates = loadJSON('parcoursup-candidates.json');
  const config = loadJSON('parcoursup-config.json');
  const coordonnees = config.coordonnees || {};
  const now = new Date();
  let processed = 0;
  let errors = 0;

  for (const item of queue) {
    if (item.status !== 'pending') continue;
    const scheduledTime = new Date(item.scheduledAt);
    if (scheduledTime > now) continue;

    // Resolve Reply-To from candidate's chargé d'admission
    const candidate = candidates.find(c => c.id === item.candidateId);
    const chargeEmail = candidate?.chargeAdmission ? (coordonnees[candidate.chargeAdmission] || {}).email : null;

    // Attempt real send for email channel
    if (item.channel === 'mail' && item.candidateEmail) {
      try {
        const messageId = await sendEmail(item.candidateEmail, item.subject, item.message, item.imageUrl, chargeEmail || null);
        item.status = 'sent';
        item.sentAt = now.toISOString();
        item.messageId = messageId;
        console.log(`[Queue] Email envoyé à ${item.candidateEmail} (${messageId})`);
      } catch (e) {
        item.status = 'failed';
        item.error = e.message;
        item.sentAt = now.toISOString();
        errors++;
        console.error(`[Queue] Erreur email ${item.candidateEmail}: ${e.message}`);
      }
    } else if (item.channel === 'whatsapp' && item.candidatePhone) {
      try {
        const chatId = await sendWhatsApp(item.candidatePhone, item.message);
        item.status = 'sent';
        item.sentAt = now.toISOString();
        console.log(`[Queue] WhatsApp envoyé à ${item.candidatePhone} (${chatId})`);
      } catch (e) {
        item.status = 'failed';
        item.error = e.message;
        item.sentAt = now.toISOString();
        errors++;
        console.error(`[Queue] Erreur WhatsApp ${item.candidatePhone}: ${e.message}`);
      }
      // Anti-ban: pause aleatoire entre chaque envoi WhatsApp pour eviter les
      // flags anti-spam de WhatsApp lors d'envois en masse depuis un compte
      // perso. Configurable via WHATSAPP_MIN_DELAY_MS / WHATSAPP_MAX_DELAY_MS,
      // defaut 3-8 secondes.
      const minDelay = parseInt(process.env.WHATSAPP_MIN_DELAY_MS) || 3000;
      const maxDelay = parseInt(process.env.WHATSAPP_MAX_DELAY_MS) || 8000;
      const wait = minDelay + Math.floor(Math.random() * Math.max(0, maxDelay - minDelay));
      if (wait > 0) {
        console.log(`[Queue] Pause anti-ban WhatsApp: ${Math.round(wait/100)/10}s`);
        await new Promise(r => setTimeout(r, wait));
      }
    } else {
      item.status = 'sent';
      item.sentAt = now.toISOString();
    }

    processed++;

    // Auto-log relance
    relances.push({
      id: genId(),
      candidateId: item.candidateId,
      type: item.channel,
      date: now.toISOString(),
      notes: `[AUTO${item.status === 'failed' ? ' ÉCHEC' : ''}] ${item.stageLabel ? item.stageLabel + ' | ' : ''}${item.subject ? item.subject + ' | ' : ''}${item.message.substring(0, 120)}`,
      result: item.status === 'failed' ? 'echoue' : 'envoye',
      createdBy: 'Automatisation'
    });
  }

  if (processed > 0) {
    saveJSON('parcoursup-queue.json', queue);
    saveJSON('parcoursup-relances.json', relances);
    console.log(`[Queue] ${processed} message(s) traité(s) (${processed - errors} envoyé(s), ${errors} erreur(s))`);
  }
}

setInterval(processQueue, 30000);

// ============ SERVE HTML ============
app.get('/health', (req, res) => {
  // Diagnostic etendu : expose les erreurs WhatsApp et le chemin Chromium
  // pour pouvoir debugger depuis l'exterieur (pas de donnees sensibles).
  const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  let chromiumExists = null;
  try {
    if (chromiumPath) chromiumExists = fs.existsSync(chromiumPath);
  } catch(_) {}
  let wwjsInstalled = null;
  try {
    wwjsInstalled = fs.existsSync(path.join(__dirname, 'node_modules', 'whatsapp-web.js'));
  } catch(_) {}
  res.json({
    status: 'ok',
    whatsapp: waStatus,
    whatsappLoadError: waLoadError,
    whatsappInitError: waInitError,
    chromiumPath,
    chromiumExists,
    wwjsInstalled,
    nodeVersion: process.version,
    ts: Date.now(),
  });
});

app.get('/', (req, res) => {
  res.redirect('/crm');
});

// Handler unique : sert la même UI sous /crm (URL publique CLEM) et /parcoursup (URL legacy).
// Les routes API et assets statiques restent sous /parcoursup/* pour ne rien casser côté frontend.
const serveCrmUi = (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'parcoursup.html'));
};
app.get('/crm', serveCrmUi);
app.get('/parcoursup', serveCrmUi);

app.listen(PORT, () => {
  console.log(`\n  Parcoursup CRM running on http://localhost:${PORT}/parcoursup\n`);
});
