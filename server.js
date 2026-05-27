const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3010;
const CRE_PIN        = process.env.CRE_PIN        || 'CRE2026';
const ENTERPRISE_PIN = process.env.ENTERPRISE_PIN || 'Salon2026';
const ADMIN_PIN      = process.env.ADMIN_PIN      || 'NS2026';
const DELETE_COMPANY_PIN = 'PIN1402';
const APP_TITLE      = process.env.APP_TITLE      || 'Jobs Alternance';
const APP_SUBTITLE   = process.env.APP_SUBTITLE   || 'CLEM Formation';
// SHOW_WILL_LOGO : explicite via env var, sinon auto-détecté selon APP_SUBTITLE
const SHOW_WILL_LOGO = process.env.SHOW_WILL_LOGO === 'true' ? true
  : process.env.SHOW_WILL_LOGO === 'false' ? false
  : (APP_SUBTITLE || '').toLowerCase().includes('will');
// SHOW_PLAN_SALON : true par défaut, false si env var explicite
const SHOW_PLAN_SALON = process.env.SHOW_PLAN_SALON !== 'false';

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(express.json());

// JS et CSS : jamais mis en cache navigateur (toujours revalidé)
app.use('/js', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  express.static(path.join(__dirname, 'public/js'))(req, res, next);
});
app.use('/css', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  express.static(path.join(__dirname, 'public/css'))(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health check (keep-alive ping) ───────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));
app.get('/api/config', (req, res) => res.json({ title: APP_TITLE, subtitle: APP_SUBTITLE, showWillLogo: SHOW_WILL_LOGO, showPlanSalon: SHOW_PLAN_SALON }));

// ─── Helper: throw on Supabase error ──────────────────────────────────────────
function sbCheck(result, label) {
  if (result.error) throw new Error((label ? label + ': ' : '') + result.error.message);
  return result.data;
}

// ─── Companies ────────────────────────────────────────────────────────────────
const FILIERE_ALIASES = {
  'SOCIAL':                    'MARKETING / COM / SOCIAL',
  'SOLUTION DIGITALE':         'MARKETING / COM / SOCIAL',
  'Solution numérique':        'MARKETING / COM / SOCIAL',
  'Solution digitale':         'MARKETING / COM / SOCIAL',
  'SOLUTION NUMÉRIQUE':        'MARKETING / COM / SOCIAL',
  'MARKETING / COMMUNICATION': 'MARKETING / COM / SOCIAL',
  'LE COMMERCE SERA':          'COMMERCE CLEM',
};
async function getCompanies() {
  const result = await supabase.from('companies').select('*').order('id');
  const rows = sbCheck(result, 'getCompanies');
  return rows.map(c => ({ ...c, filiere: FILIERE_ALIASES[c.filiere] || c.filiere }));
}

// ─── Students ─────────────────────────────────────────────────────────────────
async function getStudentsForCompany(companyId) {
  const result = await supabase
    .from('students')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at');
  return sbCheck(result, 'getStudentsForCompany');
}

async function getAllStudents() {
  const result = await supabase.from('students').select('*').order('created_at');
  return sbCheck(result, 'getAllStudents');
}

// ─── Ratings ──────────────────────────────────────────────────────────────────
async function getRatingsForCompany(companyId) {
  const result = await supabase
    .from('ratings')
    .select('*')
    .eq('company_id', companyId);
  return sbCheck(result, 'getRatingsForCompany');
}

async function getAllRatings() {
  const result = await supabase.from('ratings').select('*');
  return sbCheck(result, 'getAllRatings');
}

// Build ratings map: { companyId: { studentId: ratingObj } }
function buildRatingsMap(ratingsRows) {
  const map = {};
  for (const r of ratingsRows) {
    const cid = String(r.company_id);
    if (!map[cid]) map[cid] = {};
    map[cid][r.student_id] = {
      met:       r.met,
      rating:    r.rating,
      comment:   r.comment,
      updatedAt: r.updated_at
    };
  }
  return map;
}

// ─── Presence ─────────────────────────────────────────────────────────────────
async function getPresence() {
  const result = await supabase.from('presence').select('*');
  const rows = sbCheck(result, 'getPresence');
  const map = {};
  for (const r of rows) {
    map[r.id] = { present: r.present, nbPersonnes: r.nb_personnes, updatedAt: r.updated_at };
  }
  return map;
}

// ─── Sheet-local ──────────────────────────────────────────────────────────────
async function getSheetLocal() {
  const result = await supabase.from('sheet_local').select('*');
  const rows = sbCheck(result, 'getSheetLocal');
  const map = {};
  for (const r of rows) {
    // Pour les clés postes_company_*, notes_cre contient le JSON des postes
    if (r.key && r.key.startsWith('postes_company_')) {
      let postes = [];
      try { postes = r.notes_cre ? JSON.parse(r.notes_cre) : []; } catch(e) { postes = []; }
      map[r.key] = { postes };
    } else {
      map[r.key] = {
        checkedIn:       r.checked_in,
        checkinAt:       r.checkin_at,
        formationCiblee: r.formation_ciblee,
        notesCRE:        r.notes_cre,
        selfRegistered:  r.self_registered
      };
    }
  }
  return map;
}

async function setSheetLocalKey(key, fields) {
  const now = new Date().toISOString();
  const row = { key, updated_at: now };
  if (fields.checkedIn  !== undefined) row.checked_in      = fields.checkedIn;
  if (fields.checkinAt  !== undefined) row.checkin_at      = fields.checkinAt;
  if (fields.formationCiblee !== undefined) row.formation_ciblee = fields.formationCiblee;
  if (fields.notesCRE   !== undefined) row.notes_cre       = fields.notesCRE;
  if (fields.selfRegistered !== undefined) row.self_registered = fields.selfRegistered;
  // Pour les postes : sérialiser en JSON dans notes_cre
  if (fields.postes !== undefined) row.notes_cre = JSON.stringify(fields.postes);
  const result = await supabase.from('sheet_local').upsert(row, { onConflict: 'key' });
  sbCheck(result, 'setSheetLocalKey');
}

async function deleteSheetLocalKey(key) {
  const result = await supabase.from('sheet_local').delete().eq('key', key);
  sbCheck(result, 'deleteSheetLocalKey');
}

// ─── Self-registrations ───────────────────────────────────────────────────────
async function getSelfRegistrations() {
  const result = await supabase.from('self_registrations').select('*').order('created_at');
  return sbCheck(result, 'getSelfRegistrations');
}

// ─── Sheet cache (in-memory only; refresh from Google Sheets) ─────────────────
let sheetCache = { candidates: [], lastSync: null };

// ─── CSV helper (UTF-8 BOM for Excel) ─────────────────────────────────────────
function toCSV(rows) {
  return '\ufeff' + rows.map(row =>
    row.map(cell => `"${String(cell == null ? '' : cell).replace(/"/g, '""')}"`).join(';')
  ).join('\r\n');
}

const RATING_LABELS_CSV = { hire: "Je l'embauche", retained: 'Retenu(e)', maybe: 'À voir', refused: 'Refusé(e)' };

// ─── Google Sheets fetch ───────────────────────────────────────────────────────
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || 'https://docs.google.com/spreadsheets/d/1rafyD6PubGmF5F_nG2KBPg7g01325kiE7gzKkz8ED08/export?format=csv&gid=596889222';

function fetchURL(url, depth) {
  depth = depth || 0;
  return new Promise(function(resolve, reject) {
    if (depth > 5) return reject(new Error('Too many redirects'));
    var mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, function(res) {
      if ([301,302,303,307,308].indexOf(res.statusCode) !== -1 && res.headers.location) {
        return resolve(fetchURL(res.headers.location, depth + 1));
      }
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve(data); });
    }).on('error', reject);
  });
}

function parseCSVLine(line) {
  var result = [], cur = '', inQ = false;
  for (var i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (line[i] === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += line[i];
  }
  result.push(cur);
  return result;
}

function parseSheetCSV(text) {
  var lines = text.replace(/^\ufeff/, '').trim().split('\n');
  // Ignorer les lignes vides en tête (ex: ligne "Tableau1" vide dans certains exports Google Sheets)
  lines = lines.filter(function(l, i) {
    if (i === 0) return true; // garder pour l'instant, on cherchera le vrai header
    return true;
  });
  // Trouver la première ligne non-vide comme header
  var headerIdx = 0;
  for (var i = 0; i < lines.length; i++) {
    var cells = parseCSVLine(lines[i]).map(function(c) { return c.trim(); });
    if (cells.some(function(c) { return c.length > 0; })) { headerIdx = i; break; }
  }
  var headers = parseCSVLine(lines[headerIdx]).map(function(h) { return h.trim(); });
  if (lines.length <= headerIdx + 1) return [];
  return lines.slice(headerIdx + 1).filter(function(l) { return l.trim(); }).map(function(l) {
    var vals = parseCSVLine(l);
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = (vals[i] || '').trim(); });
    return obj;
  });
}

function mapSheetRow(row) {
  return {
    inscritAt:     row['Horodateur'] || '',
    nom:           (row['Nom'] || '').trim().toUpperCase(),
    prenom:        (row['Prénom'] || '').trim(),
    tel:           (row['Téléphone'] || '').trim(),
    email:         (row['Email'] || '').trim().toLowerCase(),
    diplome:       (row['Ton dernier diplôme obtenu'] || '').trim(),
    domaines:      (row["Le ou les domaines qui t'attirent"] || '').trim(),
    // Ancien sheet : 'Ta situation actuelle' / Nouveau sheet MDM : 'Je suis un étudiant'
    situation:     (row['Ta situation actuelle'] || row['Je suis un étudiant'] || '').trim(),
    notesCandidat: (row['Tu souhaites nous préciser quelque chose ?'] || '').trim(),
  };
}

function isStudentRow(row) {
  // Nouveau format MDM : filtrer uniquement les étudiants (exclure entreprises)
  var jesSuis = row['Je suis'] || '';
  return !jesSuis || jesSuis.toLowerCase().includes('tudiant');
}

function getCandidateKey(c) {
  return (c.email && c.email.indexOf('@') !== -1) ? c.email : (c.nom + '__' + (c.prenom || '').toLowerCase());
}

async function mergeCandidatesWithLocal(candidates) {
  var local = await getSheetLocal();
  var students = await getAllStudents();
  var companies = await getCompanies();

  var compMap = {};
  companies.forEach(function(comp) { compMap[comp.id] = comp; });

  var nameToCompanies = {};
  students.forEach(function(s) {
    var comp = compMap[s.company_id];
    if (!comp) return;
    var k = (s.nom || '').toUpperCase() + '__' + (s.prenom || '').toLowerCase();
    if (!nameToCompanies[k]) nameToCompanies[k] = [];
    nameToCompanies[k].push({ id: comp.id, nom: comp.nomAffichage || comp.nom, filiere: comp.filiere || '' });
  });

  return candidates.map(function(c) {
    var key = getCandidateKey(c);
    var loc = local[key] || {};
    var nameKey = c.nom + '__' + (c.prenom || '').toLowerCase();
    var compList = nameToCompanies[nameKey] || [];
    return Object.assign({}, c, {
      checkedIn:       loc.checkedIn  || false,
      checkinAt:       loc.checkinAt  || null,
      formationCiblee: loc.formationCiblee || '',
      notesCRE:        loc.notesCRE   || '',
      nbCompanies:     compList.length,
      companies:       compList,
    });
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET all companies
app.get('/api/companies', async (req, res) => {
  try {
    const companies = await getCompanies();
    res.json(companies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET one company
app.get('/api/companies/:id', async (req, res) => {
  try {
    const result = await supabase.from('companies').select('*').eq('id', parseInt(req.params.id)).single();
    if (result.error || !result.data) return res.status(404).json({ error: 'Entreprise non trouvée' });
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET students for a company
app.get('/api/companies/:id/students', async (req, res) => {
  try {
    const students = await getStudentsForCompany(parseInt(req.params.id));
    // Construire un index sheet par NOM+prenom pour retrouver tel/email
    const sheetIndex = {};
    (sheetCache.candidates || []).forEach(c => {
      const key = (c.nom || '').toUpperCase() + '__' + (c.prenom || '').toLowerCase().trim();
      sheetIndex[key] = c;
    });
    res.json(students.map(s => {
      const key = (s.nom || '').toUpperCase() + '__' + (s.prenom || '').toLowerCase().trim();
      const sheet = sheetIndex[key] || {};
      return {
        id: s.id,
        nom: s.nom,
        prenom: s.prenom,
        formation: s.formation,
        email: s.email || sheet.email || '',
        phone: s.phone || sheet.tel || '',
        cre: s.cre || '',
        spontaneous: !!s.spontaneous,
        createdAt: s.created_at
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add a student to a company (CRE only)
app.post('/api/companies/:id/students', async (req, res) => {
  try {
    const { pin, nom, prenom, formation, cre } = req.body;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'PIN incorrect' });
    if (!nom || !prenom || !formation) return res.status(400).json({ error: 'Données incomplètes' });

    const student = {
      id: Date.now().toString(),
      company_id: parseInt(req.params.id),
      nom: nom.trim().toUpperCase(),
      prenom: prenom.trim(),
      formation: formation.trim(),
      cre: cre || '',
      spontaneous: false,
      created_at: new Date().toISOString()
    };

    const result = await supabase.from('students').insert(student);
    sbCheck(result, 'insert student');
    res.json({ id: student.id, nom: student.nom, prenom: student.prenom, formation: student.formation, cre: student.cre, createdAt: student.created_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a student (CRE ou Entreprise)
app.delete('/api/companies/:id/students/:studentId', async (req, res) => {
  try {
    const { pin } = req.body;
    if (pin !== CRE_PIN && pin !== ENTERPRISE_PIN)
      return res.status(401).json({ error: 'PIN incorrect' });

    const delResult = await supabase
      .from('students')
      .delete()
      .eq('id', req.params.studentId)
      .eq('company_id', parseInt(req.params.id));
    sbCheck(delResult, 'delete student');

    // Nettoyage du rating associé
    await supabase
      .from('ratings')
      .delete()
      .eq('student_id', req.params.studentId)
      .eq('company_id', parseInt(req.params.id));

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST verify CRE PIN
app.post('/api/auth/cre', (req, res) => {
  const { pin } = req.body;
  res.json({ valid: pin === CRE_PIN });
});

// POST verify Enterprise PIN
app.post('/api/auth/entreprise', (req, res) => {
  const { pin } = req.body;
  res.json({ valid: pin === ENTERPRISE_PIN });
});

// POST verify admin PIN
app.post('/api/auth/admin', (req, res) => {
  const { pin } = req.body;
  res.json({ valid: pin === ADMIN_PIN });
});

// GET ratings for a company (enterprise)
app.get('/api/companies/:id/ratings', async (req, res) => {
  try {
    const { pin } = req.query;
    if (pin !== ENTERPRISE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    const rows = await getRatingsForCompany(parseInt(req.params.id));
    const out = {};
    for (const r of rows) {
      out[r.student_id] = { met: r.met, rating: r.rating, comment: r.comment, updatedAt: r.updated_at };
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST save rating for a student (enterprise)
app.post('/api/companies/:id/ratings/:studentId', async (req, res) => {
  try {
    const { pin, met, rating, comment } = req.body;
    if (pin !== ENTERPRISE_PIN) return res.status(401).json({ error: 'Non autorisé' });

    const row = {
      student_id: req.params.studentId,
      company_id: parseInt(req.params.id),
      met:        met === true || met === 'true',
      rating:     rating || null,
      comment:    comment || '',
      updated_at: new Date().toISOString()
    };

    const result = await supabase.from('ratings').upsert(row, { onConflict: 'student_id,company_id' });
    sbCheck(result, 'upsert rating');
    res.json({ met: row.met, rating: row.rating, comment: row.comment, updatedAt: row.updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add spontaneous candidacy (enterprise)
app.post('/api/companies/:id/students/spontaneous', async (req, res) => {
  try {
    const { pin, nom, prenom, formation, email, phone } = req.body;
    if (pin !== ENTERPRISE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    if (!nom || !prenom || !formation) return res.status(400).json({ error: 'Données incomplètes' });

    const student = {
      id: 'sp_' + Date.now().toString(),
      company_id: parseInt(req.params.id),
      nom: nom.trim().toUpperCase(),
      prenom: prenom.trim(),
      formation: formation.trim(),
      email: (email || '').trim(),
      phone: (phone || '').trim(),
      spontaneous: true,
      cre: '',
      created_at: new Date().toISOString()
    };

    const result = await supabase.from('students').insert(student);
    sbCheck(result, 'insert spontaneous student');
    res.json({ id: student.id, nom: student.nom, prenom: student.prenom, formation: student.formation, email: student.email, phone: student.phone, spontaneous: true, cre: '', createdAt: student.created_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET detail d'une entreprise pour admin (étudiants + ratings)
app.get('/api/admin/companies/:id/detail', async (req, res) => {
  try {
    const { pin } = req.query;
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Non autorisé' });
    const students = await getStudentsForCompany(parseInt(req.params.id));
    const ratingRows = await getRatingsForCompany(parseInt(req.params.id));
    const ratingsMap = {};
    for (const r of ratingRows) {
      ratingsMap[r.student_id] = { met: r.met, rating: r.rating, comment: r.comment, updatedAt: r.updated_at };
    }
    res.json({ students, ratings: ratingsMap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET students detail for admin
app.get('/api/admin/students', async (req, res) => {
  try {
    const { pin } = req.query;
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Non autorisé' });

    const [companies, students, allRatings] = await Promise.all([
      getCompanies(),
      getAllStudents(),
      getAllRatings()
    ]);

    const compMap = {};
    companies.forEach(c => { compMap[c.id] = c; });

    const ratingsMap = buildRatingsMap(allRatings);

    const studentsMap = {};
    for (const s of students) {
      const comp = compMap[s.company_id]; if (!comp) continue;
      const compRatings = ratingsMap[String(s.company_id)] || {};
      const key = `${(s.nom||'').toUpperCase()}__${(s.prenom||'').toLowerCase()}`;
      if (!studentsMap[key]) studentsMap[key] = { nom: s.nom||'', prenom: s.prenom||'', formation: s.formation||'', email: s.email||'', companies: [] };
      if ((s.formation||'').length > (studentsMap[key].formation||'').length) studentsMap[key].formation = s.formation;
      const r = compRatings[s.id] || {};
      studentsMap[key].companies.push({ id: s.company_id, nom: comp.nomAffichage||comp.nom, filiere: comp.filiere||'', salle: comp.salle||'', etage: comp.etage||'', cre: comp.cre||'', spontaneous: !!s.spontaneous, met: r.met===true, rating: r.rating||null, comment: r.comment||'' });
    }

    const result = Object.values(studentsMap).sort((a,b) => (a.nom||'').localeCompare(b.nom||''));
    res.json({ students: result, total: result.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all registrations summary (CRE dashboard)
app.get('/api/registrations', async (req, res) => {
  try {
    const { pin } = req.query;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'PIN incorrect' });
    const students = await getAllStudents();
    // Return in legacy format: { companyId: [students] }
    const out = {};
    for (const s of students) {
      const cid = String(s.company_id);
      if (!out[cid]) out[cid] = [];
      out[cid].push({ id: s.id, nom: s.nom, prenom: s.prenom, formation: s.formation, email: s.email||'', phone: s.phone||'', cre: s.cre||'', spontaneous: !!s.spontaneous, createdAt: s.created_at });
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add a new company (CRE only — last-minute inscription)
app.post('/api/companies', async (req, res) => {
  try {
    const { pin, nom, filiere, contact, secteur, website } = req.body;
    if (pin !== CRE_PIN && pin !== ADMIN_PIN) return res.status(401).json({ error: 'PIN incorrect' });
    if (!nom || !filiere) return res.status(400).json({ error: 'Nom et filière obligatoires' });

    // Get next ID
    const maxResult = await supabase.from('companies').select('id').order('id', { ascending: false }).limit(1);
    const rows = sbCheck(maxResult, 'get max id');
    const newId = rows.length > 0 ? rows[0].id + 1 : 1;

    const newCompany = {
      id: newId,
      nom: nom.trim(),
      nomAffichage: nom.trim(),
      filiere: filiere.trim(),
      cre: '',
      contact: (contact || '').trim(),
      website: (website || '').trim(),
      domain: '',
      secteur: (secteur || '').trim(),
      tagline: '',
      salle: '',
      etage: '',
      description: '',
      histoire: '',
      valeurs: [],
      missions: [],
      concurrents: [],
      chiffres_cles: '',
      recrutement: '',
      questions_rh: [],
      questions_op: [],
      addedLive: true
    };

    const result = await supabase.from('companies').insert(newCompany);
    sbCheck(result, 'insert company');
    res.json(newCompany);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update stand info for a company (CRE admin)
app.patch('/api/companies/:id/stand', async (req, res) => {
  try {
    const { pin, salle, etage } = req.body;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'PIN incorrect' });

    const result = await supabase
      .from('companies')
      .update({ salle: salle || '', etage: etage || '' })
      .eq('id', parseInt(req.params.id))
      .select()
      .single();

    if (result.error || !result.data) return res.status(404).json({ error: 'Non trouvé' });
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update company fields (Admin PIN)
app.patch('/api/companies/:id/meta', async (req, res) => {
  try {
    const { pin, ...fields } = req.body;
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'PIN incorrect' });
    const allowed = ['nom','logoFile','website','filiere','nomAffichage','secteur','tagline','description','histoire',
                     'valeurs','missions','concurrents','chiffres_cles','recrutement','questions_rh','questions_op',
                     'contact','cre','salle','etage'];
    const updates = {};
    allowed.forEach(k => { if (fields[k] !== undefined) updates[k] = fields[k]; });
    const result = await supabase.from('companies').update(updates).eq('id', parseInt(req.params.id));
    sbCheck(result, 'update company meta');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE a company (special PIN)
app.delete('/api/companies/:id', async (req, res) => {
  try {
    const { pin } = req.body;
    if (pin !== DELETE_COMPANY_PIN) return res.status(401).json({ error: 'PIN incorrect' });

    const getResult = await supabase.from('companies').select('*').eq('id', parseInt(req.params.id)).single();
    if (getResult.error || !getResult.data) return res.status(404).json({ error: 'Entreprise non trouvée' });
    const removed = getResult.data;

    const delResult = await supabase.from('companies').delete().eq('id', parseInt(req.params.id));
    sbCheck(delResult, 'delete company');
    res.json({ success: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin Stats ──────────────────────────────────────────────────────────────

app.get('/api/admin/stats', async (req, res) => {
  try {
    const { pin } = req.query;
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Non autorisé' });

    const [companies, students, allRatings] = await Promise.all([
      getCompanies(),
      getAllStudents(),
      getAllRatings()
    ]);

    const ratingsMap = buildRatingsMap(allRatings);

    // Group students by company
    const studentsByComp = {};
    for (const s of students) {
      const cid = String(s.company_id);
      if (!studentsByComp[cid]) studentsByComp[cid] = [];
      studentsByComp[cid].push(s);
    }

    const totalCompanies = companies.length;
    let totalStudents = 0;
    let totalSpontaneous = 0;
    const companiesWithStudents = [];
    const companiesWithout = [];

    for (const company of companies) {
      const compStudents = studentsByComp[String(company.id)] || [];
      const spontaneous  = compStudents.filter(s => s.spontaneous);
      totalStudents    += compStudents.length;
      totalSpontaneous += spontaneous.length;
      if (compStudents.length > 0) companiesWithStudents.push({ company, students: compStudents, spontaneous: spontaneous.length });
      else companiesWithout.push(company);
    }

    let totalMet = 0, totalNotMet = 0, totalHire = 0, totalRetained = 0, totalMaybe = 0, totalRefused = 0, totalRated = 0;
    for (const compRatings of Object.values(ratingsMap)) {
      for (const r of Object.values(compRatings)) {
        if (r.met === true)  totalMet++;
        if (r.met === false) totalNotMet++;
        if (r.rating) totalRated++;
        if (r.rating === 'hire')     totalHire++;
        if (r.rating === 'retained') totalRetained++;
        if (r.rating === 'maybe')    totalMaybe++;
        if (r.rating === 'refused')  totalRefused++;
      }
    }

    const topCompanies = [...companiesWithStudents]
      .sort((a, b) => b.students.length - a.students.length)
      .slice(0, 10)
      .map(({ company, students: compStudents, spontaneous }) => {
        const cRatings = ratingsMap[String(company.id)] || {};
        return {
          id: company.id,
          nom: company.nomAffichage || company.nom,
          filiere: company.filiere,
          logoFile: company.logoFile || null,
          nbStudents: compStudents.length,
          nbSpontaneous: spontaneous,
          nbMet: Object.values(cRatings).filter(r => r.met).length,
          ratings: {
            hire:     Object.values(cRatings).filter(r => r.rating === 'hire').length,
            retained: Object.values(cRatings).filter(r => r.rating === 'retained').length,
            maybe:    Object.values(cRatings).filter(r => r.rating === 'maybe').length,
            refused:  Object.values(cRatings).filter(r => r.rating === 'refused').length,
          }
        };
      });

    const filieres = {};
    for (const c of companies) {
      const f = c.filiere || 'AUTRE';
      if (!filieres[f]) filieres[f] = { companies: 0, students: 0, hire: 0, retained: 0 };
      filieres[f].companies++;
      const compStudents = studentsByComp[String(c.id)] || [];
      filieres[f].students += compStudents.length;
      const cRatings = ratingsMap[String(c.id)] || {};
      filieres[f].hire     += Object.values(cRatings).filter(r => r.rating === 'hire').length;
      filieres[f].retained += Object.values(cRatings).filter(r => r.rating === 'retained').length;
    }

    const companiesDetail = companies.map(c => {
      const compStudents = studentsByComp[String(c.id)] || [];
      const cRatings = ratingsMap[String(c.id)] || {};
      return {
        id: c.id,
        nom: c.nomAffichage || c.nom,
        filiere: c.filiere,
        logoFile: c.logoFile || null,
        nbStudents: compStudents.length,
        nbSpontaneous: compStudents.filter(s => s.spontaneous).length,
        nbMet:    Object.values(cRatings).filter(r => r.met).length,
        hire:     Object.values(cRatings).filter(r => r.rating === 'hire').length,
        retained: Object.values(cRatings).filter(r => r.rating === 'retained').length,
        maybe:    Object.values(cRatings).filter(r => r.rating === 'maybe').length,
        refused:  Object.values(cRatings).filter(r => r.rating === 'refused').length,
      };
    });

    res.json({
      global: {
        totalCompanies,
        companiesWithStudents: companiesWithStudents.length,
        companiesWithout: companiesWithout.length,
        totalStudents,
        totalSpontaneous,
        totalPositioned: totalStudents - totalSpontaneous,
        totalMet,
        totalNotMet,
        totalRated,
        totalHire,
        totalRetained,
        totalMaybe,
        totalRefused,
      },
      topCompanies,
      filieres,
      companiesDetail,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Presence tracking ────────────────────────────────────────────────────────

// GET presence data (CRE)
app.get('/api/cre/presence', async (req, res) => {
  try {
    const { pin } = req.query;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    res.json(await getPresence());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST update presence (CRE)
app.post('/api/cre/presence/:companyId', async (req, res) => {
  try {
    const { pin, present, nbPersonnes } = req.body;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    const companyId = parseInt(req.params.companyId);
    const row = {
      id:          companyId,
      present:     !!present,
      nb_personnes: parseInt(nbPersonnes) || 0,
      updated_at:  new Date().toISOString()
    };
    const result = await supabase.from('presence').upsert(row, { onConflict: 'id' });
    sbCheck(result, 'upsert presence');
    res.json({ present: row.present, nbPersonnes: row.nb_personnes, updatedAt: row.updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET company notes (CRE)
app.get('/api/cre/company-notes', async (req, res) => {
  try {
    const { pin } = req.query;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    const local = await getSheetLocal();
    const notes = {};
    Object.keys(local).forEach(k => {
      if (k.startsWith('co_note_')) {
        const id = parseInt(k.replace('co_note_', ''));
        if (id) notes[id] = local[k].notesCRE || '';
      }
    });
    res.json(notes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST save company note (CRE)
app.post('/api/cre/company-notes/:id', async (req, res) => {
  try {
    const { pin, note } = req.body;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    const id = parseInt(req.params.id);
    await setSheetLocalKey('co_note_' + id, { notesCRE: (note || '').trim() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET CRE student notes (CRE PIN, filtré par companyId optionnel)
app.get('/api/cre/student-notes', async (req, res) => {
  try {
    const { pin, companyId } = req.query;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    const local = await getSheetLocal();
    const notes = {};
    if (companyId) {
      const result = await supabase.from('students').select('id').eq('company_id', parseInt(companyId));
      const students = sbCheck(result, 'getStudents');
      students.forEach(s => {
        const key = 'cre_briefe_' + s.id;
        notes[s.id] = (local[key] && local[key].notesCRE) ? local[key].notesCRE : '';
      });
    } else {
      Object.keys(local).forEach(k => {
        if (k.startsWith('cre_briefe_')) {
          const sid = k.replace('cre_briefe_', '');
          notes[sid] = (local[k] && local[k].notesCRE) || '';
        }
      });
    }
    res.json(notes);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST save CRE student note (CRE PIN)
app.post('/api/cre/student-notes/:studentId', async (req, res) => {
  try {
    const { pin, note } = req.body;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    await setSheetLocalKey('cre_briefe_' + req.params.studentId, { notesCRE: (note || '').trim() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET CRE student notes for a company (pour vue entreprise)
app.get('/api/companies/:id/cre-student-notes', async (req, res) => {
  try {
    const companyId = parseInt(req.params.id);
    const result = await supabase.from('students').select('id').eq('company_id', companyId);
    const students = sbCheck(result, 'getCREStudentNotes');
    const local = await getSheetLocal();
    const notes = {};
    students.forEach(s => {
      const key = 'cre_briefe_' + s.id;
      notes[s.id] = (local[key] && local[key].notesCRE) ? local[key].notesCRE : '';
    });
    res.json(notes);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST save CRE debriefe note from enterprise view (Enterprise PIN)
app.post('/api/companies/:id/cre-student-notes/:studentId', async (req, res) => {
  try {
    const { pin, note } = req.body;
    if (pin !== ENTERPRISE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    await setSheetLocalKey('cre_briefe_' + req.params.studentId, { notesCRE: (note || '').trim() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET export présence (CRE)
app.get('/api/cre/presence/export', async (req, res) => {
  try {
    const { pin } = req.query;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    const [companies, presence, localMap] = await Promise.all([getCompanies(), getPresence(), getSheetLocal()]);
    const rows = [['Entreprise', 'Filière', 'Présent', 'Nb personnes sur le stand', 'Dernière MAJ', 'Note CRE']];
    [...companies]
      .sort((a, b) => (a.nomAffichage || a.nom).localeCompare(b.nomAffichage || b.nom))
      .forEach(c => {
        const p = presence[c.id] || { present: false, nbPersonnes: 0 };
        const noteKey = 'co_note_' + c.id;
        const note = (localMap[noteKey] && localMap[noteKey].notesCRE) || '';
        rows.push([
          c.nomAffichage || c.nom,
          c.filiere || '',
          p.present ? 'Oui' : 'Non',
          p.present ? (p.nbPersonnes || 0) : '',
          p.updatedAt ? new Date(p.updatedAt).toLocaleString('fr-FR') : '',
          note
        ]);
      });
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="presence_entreprises_${date}.csv"`);
    res.send(toCSV(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET export positionnements (CRE) — liste entreprises + nb positionnés + note CRE
app.get('/api/cre/positionnements/export', async (req, res) => {
  try {
    const { pin } = req.query;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    const [companies, localMap, studentsRows] = await Promise.all([
      getCompanies(),
      getSheetLocal(),
      supabase.from('students').select('company_id').then(r => r.data || [])
    ]);
    // Count students per company
    const countByCompany = {};
    for (const s of studentsRows) {
      if (s.company_id) countByCompany[s.company_id] = (countByCompany[s.company_id] || 0) + 1;
    }
    const rows = [['Entreprise', 'Filière', 'Nb étudiants positionnés', 'Note CRE']];
    [...companies]
      .sort((a, b) => (a.nomAffichage || a.nom).localeCompare(b.nomAffichage || b.nom))
      .forEach(c => {
        const noteKey = 'co_note_' + c.id;
        const note = (localMap[noteKey] && localMap[noteKey].notesCRE) || '';
        rows.push([
          c.nomAffichage || c.nom,
          c.filiere || '',
          countByCompany[c.id] || 0,
          note
        ]);
      });
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="positionnements_${date}.csv"`);
    res.send(toCSV(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Export candidates routes ─────────────────────────────────────────────────

// GET export candidates — Entreprise
app.get('/api/companies/:id/export-candidates', async (req, res) => {
  try {
    const { pin } = req.query;
    if (pin !== ENTERPRISE_PIN) return res.status(401).json({ error: 'Non autorisé' });

    const compResult = await supabase.from('companies').select('*').eq('id', parseInt(req.params.id)).single();
    if (compResult.error || !compResult.data) return res.status(404).json({ error: 'Non trouvé' });
    const company = compResult.data;

    const [students, ratingRows] = await Promise.all([
      getStudentsForCompany(parseInt(req.params.id)),
      getRatingsForCompany(parseInt(req.params.id))
    ]);

    const ratingsById = {};
    for (const r of ratingRows) ratingsById[r.student_id] = r;

    const rows = [['Nom', 'Prénom', 'Formation', 'Type', 'Email', 'Téléphone', 'Rencontré(e)', 'Décision', 'Commentaire', 'Date']];
    students.forEach(s => {
      const r = ratingsById[s.id] || {};
      rows.push([s.nom, s.prenom, s.formation,
        s.spontaneous ? 'Candidature spontanée' : 'Positionné(e) CRE',
        s.email || '', s.phone || '',
        r.met === true ? 'Oui' : r.met === false ? 'Non' : '',
        r.rating ? RATING_LABELS_CSV[r.rating] : '',
        r.comment || '',
        new Date(s.created_at).toLocaleDateString('fr-FR')]);
    });
    const slug = (company.nomAffichage || company.nom).replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="candidats_${slug}_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(toCSV(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET export candidates — CRE (une entreprise)
app.get('/api/cre/companies/:id/export-candidates', async (req, res) => {
  try {
    const { pin } = req.query;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });

    const compResult = await supabase.from('companies').select('*').eq('id', parseInt(req.params.id)).single();
    if (compResult.error || !compResult.data) return res.status(404).json({ error: 'Non trouvé' });
    const company = compResult.data;

    const [students, ratingRows, localMap] = await Promise.all([
      getStudentsForCompany(parseInt(req.params.id)),
      getRatingsForCompany(parseInt(req.params.id)),
      getSheetLocal()
    ]);

    const ratingsById = {};
    for (const r of ratingRows) ratingsById[r.student_id] = r;

    const rows = [['Entreprise', 'Filière', 'Nom', 'Prénom', 'Formation', 'Type', 'CRE', 'Rencontré(e)', 'Décision entreprise', 'Commentaire entreprise', 'Débriefe CRE', 'Date']];
    students.forEach(s => {
      const r = ratingsById[s.id] || {};
      const creNote = (localMap['cre_briefe_' + s.id] && localMap['cre_briefe_' + s.id].notesCRE) || '';
      rows.push([company.nomAffichage || company.nom, company.filiere || '',
        s.nom, s.prenom, s.formation,
        s.spontaneous ? 'Spontanée' : 'CRE', s.cre || '',
        r.met === true ? 'Oui' : r.met === false ? 'Non' : '',
        r.rating ? RATING_LABELS_CSV[r.rating] : '',
        r.comment || '',
        creNote,
        new Date(s.created_at).toLocaleDateString('fr-FR')]);
    });
    const slug = (company.nomAffichage || company.nom).replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="CRE_${slug}_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(toCSV(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Google Sheet Integration ─────────────────────────────────────────────────

// GET /api/sheet-candidates
app.get('/api/sheet-candidates', async function(req, res) {
  try {
    var pin = req.query.pin, refresh = req.query.refresh;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'PIN incorrect' });

    var age = sheetCache.lastSync ? (Date.now() - new Date(sheetCache.lastSync).getTime()) : Infinity;
    var needRefresh = refresh === '1' || age > 5*60*1000 || !sheetCache.candidates || !sheetCache.candidates.length;

    async function respond(candidates, offline) {
      const selfRegs = await getSelfRegistrations();
      var validatedSR = selfRegs.filter(function(r) { return r.status === 'validated'; });

      // Index candidats par email et par nom+prénom pour détection doublon
      var emailSet = {}, nameSet = {};
      candidates.forEach(function(x) {
        if (x.email) emailSet[(x.email||'').toLowerCase()] = true;
        var nk = (x.nom||'').toLowerCase().trim() + '__' + (x.prenom||'').toLowerCase().trim();
        nameSet[nk] = true;
      });

      // SRs dédupliquées par email → doublons potentiels
      var dedupByEmail = {};
      validatedSR.filter(function(r) { return r.email && emailSet[(r.email||'').toLowerCase()]; })
        .forEach(function(r) { dedupByEmail[(r.email||'').toLowerCase()] = r; });

      var extra = validatedSR.filter(function(r) { return !r.email || !emailSet[(r.email||'').toLowerCase()]; }).map(function(r) {
        return { nom: r.nom, prenom: r.prenom, email: r.email, tel: r.telephone,
          diplome: r.diplome, domaines: r.domainesInteret,
          situation: 'Inscription sur place', notesCandidat: '', inscritAt: r.created_at,
          selfRegistered: true, selfRegisteredId: r.id };
      });

      // Parmi les extra (pas dédupliqués par email), chercher doublons par nom+prénom
      var dedupByName = {};
      extra.filter(function(r) {
        var nk = (r.nom||'').toLowerCase().trim() + '__' + (r.prenom||'').toLowerCase().trim();
        return nameSet[nk];
      }).forEach(function(r) {
        var nk = (r.nom||'').toLowerCase().trim() + '__' + (r.prenom||'').toLowerCase().trim();
        dedupByName[nk] = r;
      });

      var merged = await mergeCandidatesWithLocal(candidates.concat(extra));

      // Marquer les candidats qui ont un doublon SR
      merged.forEach(function(c) {
        var eKey = (c.email||'').toLowerCase();
        var nKey = (c.nom||'').toLowerCase().trim() + '__' + (c.prenom||'').toLowerCase().trim();
        var sr = (eKey && dedupByEmail[eKey]) || dedupByName[nKey];
        if (sr) {
          c.hasDuplicate = true;
          c.duplicateSR = { id: sr.id, nom: sr.nom, prenom: sr.prenom, email: sr.email||'', tel: sr.telephone||'', createdAt: sr.created_at };
        }
      });

      res.json({ candidates: merged, lastSync: sheetCache.lastSync, total: merged.length, offline: !!offline });
    }

    if (!needRefresh) return await respond(sheetCache.candidates, false);

    try {
      var csvText = await fetchURL(SHEET_CSV_URL);
      var rows = parseSheetCSV(csvText);
      var candidates = rows.filter(isStudentRow).map(mapSheetRow).filter(function(c) { return c.nom && c.prenom; });
      sheetCache = { candidates: candidates, lastSync: new Date().toISOString() };
      await respond(candidates, false);
    } catch (fetchErr) {
      if (sheetCache.candidates && sheetCache.candidates.length) return await respond(sheetCache.candidates, true);
      res.status(500).json({ error: 'Impossible de charger le Google Sheet: ' + fetchErr.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sheet-candidates/list  (autocomplete — CRE + Entreprise)
app.get('/api/sheet-candidates/list', async function(req, res) {
  try {
    var pin = req.query.pin;
    if (pin !== CRE_PIN && pin !== ENTERPRISE_PIN) return res.status(401).json({ error: 'PIN incorrect' });

    // Si le cache est vide, aller chercher le Google Sheet
    if (!sheetCache.candidates || !sheetCache.candidates.length) {
      try {
        var csvText = await fetchURL(SHEET_CSV_URL);
        var rows = parseSheetCSV(csvText);
        var candidates = rows.filter(isStudentRow).map(mapSheetRow).filter(function(c) { return c.nom && c.prenom; });
        sheetCache = { candidates: candidates, lastSync: new Date().toISOString() };
      } catch (fetchErr) {
        // Cache reste vide, on retourne ce qu'on a (self-regs uniquement)
      }
    }

    var list = (sheetCache.candidates || []).map(function(c) {
      return { nom: c.nom, prenom: c.prenom, email: c.email, tel: c.tel, diplome: c.diplome, domaines: c.domaines };
    });

    const selfRegs = await getSelfRegistrations();
    var emailSet2 = {};
    (sheetCache.candidates || []).forEach(function(c) { if (c.email) emailSet2[c.email] = true; });
    selfRegs.filter(function(r) { return r.status === 'validated'; })
      .filter(function(r) { return !r.email || !emailSet2[r.email]; })
      .forEach(function(r) {
        list.push({ nom: r.nom, prenom: r.prenom, email: r.email, tel: r.telephone, diplome: r.diplome, domaines: r.domainesInteret });
      });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheet-candidates/checkin
app.post('/api/sheet-candidates/checkin', async function(req, res) {
  try {
    var pin = req.body.pin, key = req.body.key, checkedIn = req.body.checkedIn;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'PIN incorrect' });
    await setSheetLocalKey(key, {
      checkedIn: !!checkedIn,
      checkinAt: checkedIn ? new Date().toISOString() : null
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheet-candidates/update
app.post('/api/sheet-candidates/update', async function(req, res) {
  try {
    var pin = req.body.pin, key = req.body.key;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'PIN incorrect' });
    const fields = {};
    if (req.body.formationCiblee !== undefined) fields.formationCiblee = (req.body.formationCiblee || '').trim();
    if (req.body.notesCRE !== undefined) fields.notesCRE = (req.body.notesCRE || '').trim();
    await setSheetLocalKey(key, fields);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sheet-candidates/export
app.get('/api/sheet-candidates/export', async function(req, res) {
  try {
    var pin = req.query.pin;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    var merged = await mergeCandidatesWithLocal(sheetCache.candidates || []);
    var rows = [['Nom','Prénom','Téléphone','Email','Dernier diplôme',"Domaines d'intérêt",'Situation','Formation ciblée','Présent(e)','Heure check-in','Nb entreprises positionnées','Notes CRE','Date inscription']];
    merged.forEach(function(c) {
      rows.push([
        c.nom, c.prenom, c.tel, c.email, c.diplome, c.domaines, c.situation,
        c.formationCiblee,
        c.checkedIn ? 'Oui' : 'Non',
        c.checkinAt ? new Date(c.checkinAt).toLocaleString('fr-FR') : '',
        c.nbCompanies, c.notesCRE, c.inscritAt
      ]);
    });
    var date = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="candidats_inscrits_' + date + '.csv"');
    res.send(toCSV(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Auto-inscriptions sur place ─────────────────────────────────────────────

// POST /api/self-register  (sans auth — accès public)
app.post('/api/self-register', async function(req, res) {
  try {
    var nom = (req.body.nom || '').trim().toUpperCase();
    var prenom = (req.body.prenom || '').trim();
    if (!nom || !prenom) return res.status(400).json({ error: 'Nom et prénom obligatoires' });

    var reg = {
      id:             'sr_' + Date.now().toString(),
      nom:            nom,
      prenom:         prenom,
      email:          (req.body.email || '').trim().toLowerCase(),
      telephone:      (req.body.telephone || '').trim(),
      diplome:        (req.body.diplome || '').trim(),
      ecole:          (req.body.ecole || '').trim(),
      domainesInteret:(req.body.domainesInteret || '').trim(),
      companyId:      req.body.companyId || null,
      companyName:    (req.body.companyName || '').trim(),
      status:         'pending',
      created_at:     new Date().toISOString(),
      validated_at:   null,
      rejected_at:    null
    };

    const result = await supabase.from('self_registrations').insert(reg);
    sbCheck(result, 'insert self-registration');
    res.json({ success: true, id: reg.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/self-register/pending  (CRE seulement)
app.get('/api/self-register/pending', async function(req, res) {
  try {
    var pin = req.query.pin;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'PIN incorrect' });
    const regs = await getSelfRegistrations();
    const pending = regs.filter(function(r) { return r.status === 'pending'; });
    res.json({ registrations: pending, total: pending.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/self-register/all  (CRE export)
app.get('/api/self-register/all', async function(req, res) {
  try {
    var pin = req.query.pin;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'PIN incorrect' });
    res.json({ registrations: await getSelfRegistrations() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/self-register/:id/validate  (CRE)
app.post('/api/self-register/:id/validate', async function(req, res) {
  try {
    var pin = req.body.pin;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'PIN incorrect' });

    const now = new Date().toISOString();
    const upd = await supabase
      .from('self_registrations')
      .update({ status: 'validated', validated_at: now })
      .eq('id', req.params.id)
      .select()
      .single();

    if (upd.error || !upd.data) return res.status(404).json({ error: 'Non trouvé' });
    const reg = upd.data;

    // Initialiser l'entrée locale pour ce candidat
    var key = reg.email || (reg.nom + '__' + (reg.prenom || '').toLowerCase());
    await setSheetLocalKey(key, { selfRegistered: true });

    res.json({ success: true, candidate: reg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/self-register/:id  (CRE — annulation d'une validation par erreur)
app.delete('/api/self-register/:id', async function(req, res) {
  try {
    var pin = req.body.pin;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'PIN incorrect' });

    const getRes = await supabase.from('self_registrations').select('*').eq('id', req.params.id).single();
    if (getRes.error || !getRes.data) return res.status(404).json({ error: 'Non trouvé' });
    const reg = getRes.data;

    const now = new Date().toISOString();
    const upd = await supabase
      .from('self_registrations')
      .update({ status: 'rejected', rejected_at: now })
      .eq('id', req.params.id);
    sbCheck(upd, 'reject self-registration');

    // Nettoyer l'entrée locale
    var key = reg.email || (reg.nom + '__' + (reg.prenom || '').toLowerCase());
    const local = await getSheetLocal();
    if (local[key] && local[key].selfRegistered) {
      await deleteSheetLocalKey(key);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/self-register/:id/reject  (CRE)
app.post('/api/self-register/:id/reject', async function(req, res) {
  try {
    var pin = req.body.pin;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'PIN incorrect' });

    const now = new Date().toISOString();
    const upd = await supabase
      .from('self_registrations')
      .update({ status: 'rejected', rejected_at: now })
      .eq('id', req.params.id);
    sbCheck(upd, 'reject self-registration');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cre/selfreg/:id/delete  (CRE — suppression doublon)
app.post('/api/cre/selfreg/:id/delete', async function(req, res) {
  try {
    var pin = req.body.pin;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'PIN incorrect' });
    const del = await supabase.from('self_registrations').delete().eq('id', req.params.id);
    sbCheck(del, 'delete self-registration doublon');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/self-registrations (Admin)
app.get('/api/admin/self-registrations', async function(req, res) {
  try {
    var pin = req.query.pin;
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Non autorisé' });
    const regs = await getSelfRegistrations();
    var pending   = regs.filter(function(r) { return r.status === 'pending'; });
    var validated = regs.filter(function(r) { return r.status === 'validated'; });
    var rejected  = regs.filter(function(r) { return r.status === 'rejected'; });
    res.json({
      total: regs.length,
      nbPending: pending.length,
      nbValidated: validated.length,
      nbRejected: rejected.length,
      registrations: regs.sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); })
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET export inscriptions sur place (CRE)
app.get('/api/self-register/export', async function(req, res) {
  try {
    var pin = req.query.pin;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    const regs = await getSelfRegistrations();
    var statusLabel = { pending: 'En attente', validated: 'Validé', rejected: 'Refusé' };
    var rows = [['Statut','Nom','Prénom','Email','Téléphone','Diplôme','École','Domaines','Entreprise d\'intérêt','Date inscription','Date validation']];
    regs.forEach(function(r) {
      rows.push([
        statusLabel[r.status] || r.status,
        r.nom, r.prenom, r.email, r.telephone, r.diplome, r.ecole, r.domainesInteret,
        r.companyName || '',
        r.created_at  ? new Date(r.created_at).toLocaleString('fr-FR')  : '',
        r.validated_at ? new Date(r.validated_at).toLocaleString('fr-FR') : ''
      ]);
    });
    var date = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inscriptions_sur_place_' + date + '.csv"');
    res.send(toCSV(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Offres Alternance par entreprise ─────────────────────────────────────────
// GET toutes les offres (CRE PIN)
app.get('/api/offres-alternance', async (req, res) => {
  try {
    const { pin } = req.query;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    const compResult = await supabase.from('companies').select('id, nom, nomAffichage, filiere, logoFile').order('nom');
    const companies = sbCheck(compResult, 'getCompanies');
    const local = await getSheetLocal();
    const result = companies.map(c => ({
      ...c,
      postes: (local['postes_company_' + c.id] && local['postes_company_' + c.id].postes) || []
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET offres publiques (sans PIN — pour les candidats)
app.get('/api/offres-alternance-public', async (req, res) => {
  try {
    const compResult = await supabase.from('companies').select('id, nom, nomAffichage, filiere, logoFile').order('nom');
    const companies = sbCheck(compResult, 'getCompanies');
    const local = await getSheetLocal();
    const result = companies.map(c => ({
      ...c,
      postes: (local['postes_company_' + c.id] && local['postes_company_' + c.id].postes) || []
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET entretiens publics (sans PIN — pour les candidats)
app.get('/api/entretiens-public', async (req, res) => {
  try {
    const [companies, students, allRatings] = await Promise.all([
      getCompanies(),
      getAllStudents(),
      getAllRatings()
    ]);
    const compMap = {};
    companies.forEach(c => { compMap[c.id] = c; });
    const ratingsMap = buildRatingsMap(allRatings);
    const studentsMap = {};
    for (const s of students) {
      const comp = compMap[s.company_id]; if (!comp) continue;
      const compRatings = ratingsMap[String(s.company_id)] || {};
      const key = `${(s.nom||'').toUpperCase()}__${(s.prenom||'').toLowerCase()}`;
      if (!studentsMap[key]) studentsMap[key] = { nom: s.nom||'', prenom: s.prenom||'', companies: [] };
      const r = compRatings[s.id] || {};
      studentsMap[key].companies.push({ id: s.company_id, nom: comp.nomAffichage||comp.nom, filiere: comp.filiere||'' });
    }
    const result = Object.values(studentsMap).sort((a,b) => (a.nom||'').localeCompare(b.nom||''));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST sauvegarder les postes d'une entreprise (CRE PIN)
app.post('/api/offres-alternance/:id', async (req, res) => {
  try {
    const { pin, postes } = req.body;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    await setSheetLocalKey('postes_company_' + req.params.id, { postes: Array.isArray(postes) ? postes : [] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Envoi email candidat (CRE) ───────────────────────────────────────────────
app.post('/api/cre/send-candidate-email', async (req, res) => {
  try {
    const { pin, to, prenom, companies } = req.body;
    if (pin !== CRE_PIN) return res.status(401).json({ error: 'Non autorisé' });
    if (!to || !to.includes('@')) return res.status(400).json({ error: 'Email invalide' });

    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    if (!smtpUser || !smtpPass) return res.status(503).json({ error: 'Email non configuré sur le serveur (SMTP_USER / SMTP_PASS manquants)' });

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: smtpUser, pass: smtpPass }
    });

    const compList = (companies || []).map((c, i) => {
      let line = `${i + 1}. ${c.nom}`;
      if (c.filiere) line += ` (${c.filiere})`;
      if (c.salle)   line += ` — ${c.salle}${c.etage ? ', ' + c.etage : ''}`;
      return line;
    }).join('\n');

    const htmlList = (companies || []).map((c, i) => {
      let detail = '';
      if (c.salle) detail += ` <span style="color:#64748b;font-size:13px">📍 ${c.salle}${c.etage ? ', ' + c.etage : ''}</span>`;
      return `<li style="padding:6px 0;border-bottom:1px solid #f1f5f9">${c.nom}${detail}</li>`;
    }).join('');

    const fromName = process.env.SMTP_FROM_NAME || 'Jobs Alternance – CRE';
    const mailOptions = {
      from: `"${fromName}" <${smtpUser}>`,
      to,
      subject: 'Tes entreprises à rencontrer – Jobs Alternance',
      text: `Bonjour ${prenom},\n\nVoici la liste des entreprises sur lesquelles tu as été positionné(e) lors du Jobs Alternance :\n\n${compList}\n\nN'hésite pas à te présenter à chacun de leurs stands !\n\nÀ très bientôt,\nL'équipe CRE`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1e293b">
          <div style="background:#6366f1;padding:24px 28px;border-radius:10px 10px 0 0">
            <h2 style="color:#fff;margin:0;font-size:20px">Jobs Alternance</h2>
            <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:14px">Tes entreprises à rencontrer</p>
          </div>
          <div style="background:#fff;padding:28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px">
            <p style="margin:0 0 16px">Bonjour <strong>${prenom}</strong>,</p>
            <p style="margin:0 0 16px">Voici la liste des entreprises sur lesquelles tu as été positionné(e) :</p>
            <ul style="list-style:none;padding:0;margin:0 0 20px">${htmlList}</ul>
            <p style="margin:0 0 8px">N'hésite pas à te présenter à chacun de leurs stands !</p>
            <p style="margin:0;color:#64748b;font-size:13px">À très bientôt — L'équipe CRE</p>
          </div>
        </div>`
    };

    await transporter.sendMail(mailOptions);
    res.json({ success: true, to });
  } catch (err) {
    console.error('Email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Catch-all ────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('\n========================================');
  console.log('   SALON ALTERNANCE - Application');
  console.log('========================================');
  console.log(`Accès local  : http://localhost:${PORT}`);
  console.log(`Accès réseau : http://[votre-ip]:${PORT}`);
  console.log(`PIN CRE      : ${CRE_PIN}`);
  console.log('========================================\n');
});
