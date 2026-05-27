/**
 * Admission Hub - Serveur autonome
 * Proxy vers les CRM CLEM & CLEM + interface Admission Hub
 */
const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3011;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Configuration CRM ──────────────────────────────────────────────────────
// Les cookies de session sont stockés ici (configurés via l'interface /admission)
const CONFIG_FILE = path.join(__dirname, 'data', 'admission-config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) { console.error('Config load error:', e.message); }
  return { clem: { cookie: '', baseUrl: 'https://crm.clem-formation.fr' }, will: { cookie: '', baseUrl: 'https://crm.clem-formation.fr' } };
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ─── HTML Scraper ────────────────────────────────────────────────────────────
function fetchCrmPage(baseUrl, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(urlPath, baseUrl);
    const mod = fullUrl.protocol === 'https:' ? https : http;
    const req = mod.get(fullUrl.href, {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'AdmissionHub/1.0',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 15000,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redir = res.headers.location;
        if (redir.includes('/login') || redir.includes('/connexion') || redir === '/') {
          reject(new Error('SESSION_EXPIRED'));
          return;
        }
        fetchCrmPage(baseUrl, redir, cookie).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
  });
}

// Parse the HTML table from /listeV2 pages
function parseListeV2(html) {
  const candidates = [];
  // Match table rows with onclick containing candidat ID
  const rowRegex = /onclick="window\.location\.href='\/candidat\/(\d+)'"[^>]*>([\s\S]*?)<\/tr>/g;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const id = match[1];
    const rowHtml = match[2];
    // Extract TD contents
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const cells = [];
    let tdMatch;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      // Strip HTML tags and trim
      cells.push(tdMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    }
    if (cells.length >= 6) {
      candidates.push({
        id: parseInt(id),
        nom: cells[1] || '',
        prenom: cells[2] || '',
        email: cells[3] || '',
        statut: cells[4] || '',
        dateStatut: cells[5] || '',
        formation: cells[6] || '',
        type: cells[7] || '',
        annee: cells[8] || '',
        rappel: cells[9] || '',
        parrainEmail: cells[10] || ''
      });
    }
  }
  // Extract total count
  const totalMatch = html.match(/sur (\d+) éléments/);
  const total = totalMatch ? parseInt(totalMatch[1]) : candidates.length;

  return { candidates, total };
}

// Parse the dashboard /tdb page for KPIs
function parseDashboard(html) {
  const kpis = {};
  // Extract big numbers with their labels
  const blockRegex = /<div class="number">\s*(\d+)\s*<\/div>[\s\S]*?<div class="name">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = blockRegex.exec(html)) !== null) {
    const value = parseInt(m[1]);
    const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (label.includes('Prospect')) kpis.prospects = value;
    else if (label.includes('Candidat')) kpis.candidats = value;
    else if (label.includes('Admis')) kpis.admis = value;
    else if (label.includes('Frais')) kpis.fraisPayes = value;
    else if (label.includes('Offres')) kpis.offres = value;
    else if (label.includes('Etudiant') || label.includes('placé')) kpis.etudiantsPlaces = value;
    else if (label.includes('Abandon')) kpis.abandons = value;
  }
  // Alternative: try simpler number extraction from cards
  const cardRegex = /<div[^>]*class="[^"]*card[^"]*"[^>]*>[\s\S]*?<[^>]*>(\d+)<[\s\S]*?<[^>]*>([\w\s()\/\-éèêàùô]+)/gi;
  while ((m = cardRegex.exec(html)) !== null) {
    const value = parseInt(m[1]);
    const label = m[2].trim();
    if (!kpis.prospects && label.includes('Prospect')) kpis.prospects = value;
  }
  // Extract action items from sidebar
  const actions = [];
  const actionRegex = /<a[^>]*href="([^"]*)"[^>]*>[\s]*(?:<[^>]*>)?(\d+)[\s]*(?:<[^>]*>)?[\s]*([\w\sàéèêùô']+)/g;
  while ((m = actionRegex.exec(html)) !== null) {
    actions.push({ count: parseInt(m[2]), label: m[3].trim(), href: m[1] });
  }
  return { kpis, actions };
}

// Parse individual candidate page
function parseCandidate(html) {
  const data = {};
  // Extract name from h1 or header
  const nameMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (nameMatch) {
    data.fullName = nameMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }
  // Extract form field values
  const inputRegex = /name="contact_prospect\[([^\]]+)\](?:\[([^\]]*)\])?"[^>]*value="([^"]*)"/g;
  let m;
  while ((m = inputRegex.exec(html)) !== null) {
    const key = m[2] ? `${m[1]}.${m[2]}` : m[1];
    data[key] = m[3];
  }
  // Extract selected options
  const selectRegex = /name="contact_prospect\[([^\]]+)\](?:\[([^\]]*)\])?"[\s\S]*?<option[^>]*selected[^>]*>([^<]*)/g;
  while ((m = selectRegex.exec(html)) !== null) {
    const key = m[2] ? `${m[1]}.${m[2]}` : m[1];
    data[key] = m[3].trim();
  }
  // Extract status badge
  const statusMatch = html.match(/class="[^"]*badge[^"]*"[^>]*>(\w[^<]*)/);
  if (statusMatch) data.statut = statusMatch[1].trim();

  return data;
}

// ─── API ROUTES ──────────────────────────────────────────────────────────────

// Health check
app.get('/admission/api/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// Get/Set config (session cookies)
app.get('/admission/api/config', (req, res) => {
  const config = loadConfig();
  // Mask cookie values for security (show only first/last 4 chars)
  const masked = JSON.parse(JSON.stringify(config));
  for (const school of ['clem', 'will']) {
    if (masked[school]?.cookie) {
      const c = masked[school].cookie;
      masked[school].cookie = c.length > 10 ? c.substring(0, 4) + '...' + c.substring(c.length - 4) : '***';
      masked[school].connected = true;
    } else {
      masked[school].connected = false;
    }
  }
  res.json(masked);
});

app.post('/admission/api/config', (req, res) => {
  const config = loadConfig();
  const { school, cookie } = req.body;
  if (!school || !['clem', 'will'].includes(school)) {
    return res.status(400).json({ error: 'School must be clem or will' });
  }
  config[school].cookie = cookie || '';
  saveConfig(config);
  res.json({ ok: true, message: `Cookie ${school} sauvegardé` });
});

// Test CRM connection
app.get('/admission/api/test/:school', async (req, res) => {
  const config = loadConfig();
  const school = req.params.school;
  if (!['clem', 'will'].includes(school)) {
    return res.status(400).json({ error: 'School invalide' });
  }
  const { cookie, baseUrl } = config[school];
  if (!cookie) {
    return res.json({ connected: false, error: 'Aucun cookie configuré' });
  }
  try {
    const html = await fetchCrmPage(baseUrl, '/tdb', cookie);
    if (html.includes('Tableau de bord') || html.includes('Prospect')) {
      const dashboard = parseDashboard(html);
      return res.json({ connected: true, dashboard });
    }
    return res.json({ connected: false, error: 'Page non reconnue (session expirée ?)' });
  } catch (e) {
    return res.json({ connected: false, error: e.message });
  }
});

// Fetch dashboard KPIs
app.get('/admission/api/dashboard/:school', async (req, res) => {
  const config = loadConfig();
  const school = req.params.school;
  if (!['clem', 'will'].includes(school)) return res.status(400).json({ error: 'School invalide' });
  const { cookie, baseUrl } = config[school];
  if (!cookie) return res.status(401).json({ error: 'Non connecté' });
  try {
    const html = await fetchCrmPage(baseUrl, '/tdb', cookie);
    const dashboard = parseDashboard(html);
    res.json(dashboard);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch candidate list
app.get('/admission/api/liste/:school', async (req, res) => {
  const config = loadConfig();
  const school = req.params.school;
  if (!['clem', 'will'].includes(school)) return res.status(400).json({ error: 'School invalide' });
  const { cookie, baseUrl } = config[school];
  if (!cookie) return res.status(401).json({ error: 'Non connecté' });

  const view = req.query.view || 'prospect';
  const page = req.query.page || 1;
  const sort = req.query.sort || 'A0';

  try {
    const html = await fetchCrmPage(baseUrl, `/listeV2?view=${view}&p=${page}&s=${sort}`, cookie);
    const result = parseListeV2(html);
    res.json({ school, view, page: parseInt(page), ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch all views combined (prospects + candidats + admis)
app.get('/admission/api/all/:school', async (req, res) => {
  const config = loadConfig();
  const school = req.params.school;
  if (!['clem', 'will'].includes(school)) return res.status(400).json({ error: 'School invalide' });
  const { cookie, baseUrl } = config[school];
  if (!cookie) return res.status(401).json({ error: 'Non connecté' });

  try {
    const views = ['prospect', 'candidats', 'admis', 'abandon'];
    const results = await Promise.all(views.map(async v => {
      try {
        const html = await fetchCrmPage(baseUrl, `/listeV2?view=${v}&p=1`, cookie);
        return { view: v, ...parseListeV2(html) };
      } catch (e) {
        return { view: v, candidates: [], total: 0, error: e.message };
      }
    }));

    // Also get dashboard KPIs
    let dashboard = {};
    try {
      const dashHtml = await fetchCrmPage(baseUrl, '/tdb', cookie);
      dashboard = parseDashboard(dashHtml);
    } catch (e) { /* ignore */ }

    res.json({ school, views: results, dashboard });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch individual candidate
app.get('/admission/api/candidat/:school/:id', async (req, res) => {
  const config = loadConfig();
  const school = req.params.school;
  if (!['clem', 'will'].includes(school)) return res.status(400).json({ error: 'School invalide' });
  const { cookie, baseUrl } = config[school];
  if (!cookie) return res.status(401).json({ error: 'Non connecté' });

  try {
    const html = await fetchCrmPage(baseUrl, `/candidat/${req.params.id}`, cookie);
    const candidate = parseCandidate(html);
    res.json({ school, id: req.params.id, ...candidate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Combined data for both schools
app.get('/admission/api/combined', async (req, res) => {
  const config = loadConfig();
  const results = {};

  for (const school of ['clem', 'will']) {
    const { cookie, baseUrl } = config[school];
    if (!cookie) {
      results[school] = { connected: false, error: 'Non connecté' };
      continue;
    }
    try {
      const [dashHtml, prospectHtml, candidatHtml, admisHtml] = await Promise.all([
        fetchCrmPage(baseUrl, '/tdb', cookie),
        fetchCrmPage(baseUrl, '/listeV2?view=prospect&p=1', cookie),
        fetchCrmPage(baseUrl, '/listeV2?view=candidats&p=1', cookie),
        fetchCrmPage(baseUrl, '/listeV2?view=admis&p=1', cookie),
      ]);
      results[school] = {
        connected: true,
        dashboard: parseDashboard(dashHtml),
        prospects: parseListeV2(prospectHtml),
        candidats: parseListeV2(candidatHtml),
        admis: parseListeV2(admisHtml),
      };
    } catch (e) {
      results[school] = { connected: false, error: e.message };
    }
  }
  res.json(results);
});

// ─── Email SMTP ──────────────────────────────────────────────────────────────

// Save/load SMTP config
app.get('/admission/api/smtp-config', (req, res) => {
  const config = loadConfig();
  const smtp = config.smtp || {};
  res.json({
    host: smtp.host || '',
    port: smtp.port || 587,
    user: smtp.user ? smtp.user.substring(0, 3) + '***' : '',
    configured: !!(smtp.host && smtp.user && smtp.pass),
    fromName: smtp.fromName || 'Admission Hub',
  });
});

app.post('/admission/api/smtp-config', (req, res) => {
  const config = loadConfig();
  const { host, port, user, pass, fromName } = req.body;
  config.smtp = { host, port: parseInt(port) || 587, user, pass, fromName: fromName || 'Admission Hub' };
  saveConfig(config);
  res.json({ ok: true, message: 'Configuration SMTP sauvegardée' });
});

// Test SMTP connection
app.post('/admission/api/smtp-test', async (req, res) => {
  const config = loadConfig();
  const smtp = config.smtp;
  if (!smtp || !smtp.host) return res.json({ ok: false, error: 'SMTP non configuré' });
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host, port: smtp.port || 587, secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
    });
    await transporter.verify();
    res.json({ ok: true, message: 'Connexion SMTP réussie' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Send email
app.post('/admission/api/send-email', async (req, res) => {
  const config = loadConfig();
  const smtp = config.smtp;
  if (!smtp || !smtp.host) return res.status(400).json({ error: 'SMTP non configuré' });
  const { to, subject, body, cc } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'Champs requis: to, subject, body' });
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host, port: smtp.port || 587, secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.pass },
    });
    const info = await transporter.sendMail({
      from: `"${smtp.fromName || 'Admission Hub'}" <${smtp.user}>`,
      to, cc: cc || undefined, subject,
      html: body.replace(/\n/g, '<br>'),
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Persistance Leads & Pipeline ────────────────────────────────────────────
const LEADS_FILE = path.join(__dirname, 'data', 'admission-leads.json');
const PIPELINE_FILE = path.join(__dirname, 'data', 'admission-pipeline.json');
const TEAM_FILE = path.join(__dirname, 'data', 'admission-team.json');

function loadJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
  return fallback;
}
function saveJSON(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// GET leads
app.get('/admission/api/leads', (req, res) => {
  res.json(loadJSON(LEADS_FILE, []));
});

// POST save all leads
app.post('/admission/api/leads', (req, res) => {
  const { leads } = req.body;
  if (!Array.isArray(leads)) return res.status(400).json({ error: 'leads must be an array' });
  saveJSON(LEADS_FILE, leads);
  res.json({ ok: true, count: leads.length });
});

// GET pipeline stages
app.get('/admission/api/pipeline', (req, res) => {
  res.json(loadJSON(PIPELINE_FILE, ['Nouveau Lead','Contacté','Qualifié','RDV Planifié','Candidat','Admis']));
});

// POST save pipeline stages
app.post('/admission/api/pipeline', (req, res) => {
  const { stages } = req.body;
  if (!Array.isArray(stages)) return res.status(400).json({ error: 'stages must be an array' });
  saveJSON(PIPELINE_FILE, stages);
  res.json({ ok: true, count: stages.length });
});

// GET team members
app.get('/admission/api/team', (req, res) => {
  res.json(loadJSON(TEAM_FILE, []));
});

// POST save team members
app.post('/admission/api/team', (req, res) => {
  const { team } = req.body;
  if (!Array.isArray(team)) return res.status(400).json({ error: 'team must be an array' });
  saveJSON(TEAM_FILE, team);
  res.json({ ok: true, count: team.length });
});

// ─── Email Automations ──────────────────────────────────────────────────────
const AUTOMATIONS_FILE = path.join(__dirname, 'data', 'admission-automations.json');
const QUEUE_FILE = path.join(__dirname, 'data', 'admission-email-queue.json');

// GET automations config
app.get('/admission/api/automations', (req, res) => {
  res.json(loadJSON(AUTOMATIONS_FILE, {}));
});

// POST save automations config
app.post('/admission/api/automations', (req, res) => {
  const { automations } = req.body;
  if (!automations || typeof automations !== 'object') return res.status(400).json({ error: 'automations must be an object' });
  saveJSON(AUTOMATIONS_FILE, automations);
  res.json({ ok: true });
});

// GET email queue
app.get('/admission/api/email-queue', (req, res) => {
  res.json(loadJSON(QUEUE_FILE, []));
});

// POST queue a new email (or whatsapp)
app.post('/admission/api/queue-email', (req, res) => {
  const { leadId, to, leadName, subject, body, message, delayValue, delayUnit, stage, type } = req.body;
  const entryType = type || 'email';

  if (entryType === 'email') {
    if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, body required' });
  } else if (entryType === 'whatsapp') {
    if (!to || !message) return res.status(400).json({ error: 'to, message required for whatsapp' });
  }

  const now = new Date();
  let delayMs = 0;
  const val = parseInt(delayValue) || 0;
  if (delayUnit === 'min') delayMs = val * 60 * 1000;
  else if (delayUnit === 'h') delayMs = val * 3600 * 1000;
  else if (delayUnit === 'j') delayMs = val * 86400 * 1000;
  else if (delayUnit === 'sem') delayMs = val * 7 * 86400 * 1000;

  const scheduledAt = new Date(now.getTime() + delayMs);
  const queue = loadJSON(QUEUE_FILE, []);
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    type: entryType,
    leadId, to, leadName: leadName || '',
    subject: subject || '', body: body || '', message: message || '',
    stage: stage || '',
    createdAt: now.toISOString(),
    scheduledAt: scheduledAt.toISOString(),
    status: delayMs === 0 ? 'sending' : 'pending'
  };
  queue.push(entry);
  saveJSON(QUEUE_FILE, queue);

  // If immediate, process now
  if (delayMs === 0) {
    processQueueEntry(entry);
  }

  res.json({ ok: true, entry });
});

// DELETE cancel a queued email
app.delete('/admission/api/email-queue/:id', (req, res) => {
  let queue = loadJSON(QUEUE_FILE, []);
  const before = queue.length;
  queue = queue.filter(e => e.id !== req.params.id);
  saveJSON(QUEUE_FILE, queue);
  res.json({ ok: true, removed: before - queue.length });
});

// ─── Email/WhatsApp Queue Processor ──────────────────────────────────────────
async function processQueueEntry(entry) {
  const entryType = entry.type || 'email';
  if (entryType === 'whatsapp') {
    return processWhatsApp(entry);
  }
  return sendQueuedEmail(entry);
}

async function sendQueuedEmail(entry) {
  const config = loadConfig();
  const smtp = config.smtp;
  if (!smtp || !smtp.user || smtp.user === 'test') {
    console.log('  ⚠ SMTP non configuré, email non envoyé:', entry.subject);
    markQueueEntry(entry.id, 'failed', 'SMTP non configuré');
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host, port: smtp.port, secure: false,
      auth: { user: smtp.user, pass: smtp.pass }
    });
    await transporter.sendMail({
      from: `"${smtp.fromName || 'Admission Hub'}" <${smtp.user}>`,
      to: entry.to,
      subject: entry.subject,
      html: entry.body.replace(/\n/g, '<br>')
    });
    console.log(`  ✅ Email auto envoyé à ${entry.to}: ${entry.subject}`);
    markQueueEntry(entry.id, 'sent');

    // Update lead timeline
    const leads = loadJSON(LEADS_FILE, []);
    const leadIdx = leads.findIndex(l => l.id === entry.leadId);
    if (leadIdx !== -1) {
      leads[leadIdx].emails = (leads[leadIdx].emails || 0) + 1;
      if (!leads[leadIdx].timeline) leads[leadIdx].timeline = [];
      leads[leadIdx].timeline.push({
        type: 'email', auto: true,
        time: new Date().toISOString(),
        message: `Email automatique envoyé : ${entry.subject}`
      });
      saveJSON(LEADS_FILE, leads);
    }
  } catch (e) {
    console.error(`  ❌ Email auto échoué pour ${entry.to}:`, e.message);
    markQueueEntry(entry.id, 'failed', e.message);
  }
}

async function processWhatsApp(entry) {
  // WhatsApp cannot be auto-sent without an API — log it, record timeline, generate wa.me link
  const phone = (entry.to || '').replace(/[\s\-\.]/g, '').replace(/^0/, '33');
  const waLink = `https://wa.me/${phone}?text=${encodeURIComponent(entry.message || '')}`;
  console.log(`  📱 WhatsApp auto programmé pour ${entry.leadName || entry.to}: ${waLink}`);
  markQueueEntry(entry.id, 'sent_wa', null, waLink);

  // Update lead timeline
  const leads = loadJSON(LEADS_FILE, []);
  const leadIdx = leads.findIndex(l => l.id === entry.leadId);
  if (leadIdx !== -1) {
    leads[leadIdx].sms = (leads[leadIdx].sms || 0) + 1;
    if (!leads[leadIdx].timeline) leads[leadIdx].timeline = [];
    leads[leadIdx].timeline.push({
      type: 'whatsapp', auto: true,
      time: new Date().toISOString(),
      message: `WhatsApp auto programmé : ${(entry.message || '').substring(0, 60)}...`,
      waLink
    });
    saveJSON(LEADS_FILE, leads);
  }
}

function markQueueEntry(id, status, error, waLink) {
  const queue = loadJSON(QUEUE_FILE, []);
  const entry = queue.find(e => e.id === id);
  if (entry) {
    entry.status = status;
    if (error) entry.error = error;
    if (waLink) entry.waLink = waLink;
    entry.processedAt = new Date().toISOString();
    saveJSON(QUEUE_FILE, queue);
  }
}

// Timer: check queue every 30 seconds
setInterval(() => {
  const queue = loadJSON(QUEUE_FILE, []);
  const now = new Date();
  let changed = false;
  queue.forEach(entry => {
    if (entry.status === 'pending' && new Date(entry.scheduledAt) <= now) {
      entry.status = 'sending';
      changed = true;
      processQueueEntry(entry);
    }
  });
  if (changed) saveJSON(QUEUE_FILE, queue);
}, 30000);

// ─── Serve admission.html as default ─────────────────────────────────────────
app.get('/admission', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admission.html'));
});

// ─── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ⚡ Admission Hub lancé sur http://localhost:${PORT}/admission`);
  console.log(`  📊 API disponible sur http://localhost:${PORT}/admission/api/`);
  console.log(`\n  Pour connecter les CRM, configurez les cookies de session :`);
  console.log(`  POST /admission/api/config { school: "clem", cookie: "votre_cookie" }\n`);
});
