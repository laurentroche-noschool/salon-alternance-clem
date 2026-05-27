/**
 * Cockpit Server - Scraping automatique des CRM CLEM & CLEM
 * Port 3003 - Sert le dashboard cockpit + expose /api/cockpit-data en JSON
 *
 * Fonctionnement :
 * 1. Lance Puppeteer headless pour chaque CRM
 * 2. Se connecte via le formulaire /login (champs _username / _password)
 * 3. Scrape les pages /tdb et /pedago/tdb en evaluant document.body.innerText
 * 4. Parse le texte avec des regex pour extraire les KPIs
 * 5. Expose les donnees en JSON sur /api/cockpit-data
 * 6. Sert les fichiers statiques depuis public/ (cockpit.html)
 *
 * La session Puppeteer est reutilisee entre les scrapes.
 * Si la session expire (redirection vers /login), le client se reconnecte.
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.COCKPIT_PORT || 3013;

// ============================================================
//  Configuration CRM
// ============================================================

const CRM_CONFIG = {
  clem: {
    baseUrl: (process.env.CRM_CLEM_URL || 'https://crm.clem-formation.fr').replace(/\/+$/, ''),
    email: process.env.CRM_CLEM_EMAIL,
    password: process.env.CRM_CLEM_PASSWORD,
    name: 'CLEM',
    color: '#00d4ff'
  },
  will: {
    baseUrl: (process.env.CRM_WILL_URL || 'https://crm.clem-formation.fr').replace(/\/+$/, ''),
    email: process.env.CRM_WILL_EMAIL,
    password: process.env.CRM_WILL_PASSWORD,
    name: 'CLEM',
    color: '#ff0066'
  }
};

// Intervalle de rafraichissement (defaut 10 min)
const REFRESH_INTERVAL = (parseInt(process.env.CRM_REFRESH_INTERVAL) || 10) * 60 * 1000;

// ============================================================
//  State global
// ============================================================

let cachedData = null;
let lastFetchTime = null;
let fetchErrors = {};
let isRefreshing = false;

// ============================================================
//  CRMClient - un client Puppeteer par CRM
// ============================================================

class CRMClient {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.page = null;
    this.authenticated = false;
  }

  // ----------------------------------------------------------
  //  Lancement du navigateur + creation de la page
  // ----------------------------------------------------------
  async ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return;

    console.log(`[${this.config.name}] Lancement de Puppeteer...`);
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    this.page = await this.browser.newPage();

    // User-agent realiste pour eviter les blocages
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Masquer la detection de Puppeteer/webdriver
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    // Timeout par defaut raisonnable
    this.page.setDefaultNavigationTimeout(30000);
    this.page.setDefaultTimeout(15000);

    this.authenticated = false;
  }

  // ----------------------------------------------------------
  //  Login : remplir le formulaire /login et soumettre
  // ----------------------------------------------------------
  async login() {
    try {
      await this.ensureBrowser();

      console.log(`[${this.config.name}] Connexion a ${this.config.baseUrl}/login ...`);

      // Naviguer vers la page de login
      await this.page.goto(`${this.config.baseUrl}/login`, { waitUntil: 'networkidle2' });

      // Verifier qu'on est bien sur la page de login
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/login')) {
        // Deja connecte (session encore valide apres restart ?)
        console.log(`[${this.config.name}] Deja connecte (URL: ${currentUrl})`);
        this.authenticated = true;
        return true;
      }

      // Remplir les champs via JS natif (plus fiable que page.type pour certains CRM)
      await this.page.evaluate((email, password) => {
        function setNativeValue(el, value) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const u = document.querySelector('input[name="_username"]');
        const p = document.querySelector('input[name="_password"]');
        if (u) setNativeValue(u, email);
        if (p) setNativeValue(p, password);
      }, this.config.email, this.config.password);

      // Verifier que les champs sont remplis
      const fieldValues = await this.page.evaluate(() => {
        const u = document.querySelector('input[name="_username"]');
        const p = document.querySelector('input[name="_password"]');
        return { email: u?.value, pwdLen: p?.value?.length };
      });
      console.log(`[${this.config.name}] Champs: email=${fieldValues.email}, mdp=${fieldValues.pwdLen} chars`);

      // Petite pause
      await new Promise(r => setTimeout(r, 300));

      // Soumettre le formulaire directement via JS
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
        this.page.evaluate(() => document.querySelector('form').submit())
      ]);

      // Verifier si le login a reussi : on doit etre redirige vers /tdb ou /config
      const afterUrl = this.page.url();
      if (afterUrl.includes('/login')) {
        // Toujours sur /login => identifiants invalides
        const pageText = await this.page.evaluate(() => document.body.innerText);
        console.error(`[${this.config.name}] Echec connexion - toujours sur /login`);
        if (pageText.includes('Identifiants invalides')) {
          console.error(`[${this.config.name}] Identifiants invalides`);
        }
        // Screenshot de debug
        try {
          const debugPath = path.join(__dirname, 'data', `debug-login-${this.config.name.toLowerCase()}.png`);
          await this.page.screenshot({ path: debugPath, fullPage: true });
          console.log(`[${this.config.name}] Screenshot debug: ${debugPath}`);
        } catch(e) {}
        this.authenticated = false;
        return false;
      }

      this.authenticated = true;
      console.log(`[${this.config.name}] Connecte avec succes (redirige vers ${afterUrl})`);
      return true;

    } catch (err) {
      console.error(`[${this.config.name}] Erreur connexion:`, err.message);
      this.authenticated = false;
      return false;
    }
  }

  // ----------------------------------------------------------
  //  Detecter si la session a expire (page de login affichee)
  // ----------------------------------------------------------
  isOnLoginPage() {
    try {
      return this.page.url().includes('/login');
    } catch {
      return true;
    }
  }

  // ----------------------------------------------------------
  //  Naviguer vers une URL, re-login si session expiree
  // ----------------------------------------------------------
  async navigateWithRelogin(urlPath) {
    await this.ensureBrowser();

    // Premiere tentative
    if (!this.authenticated) {
      const ok = await this.login();
      if (!ok) return null;
    }

    const fullUrl = `${this.config.baseUrl}${urlPath}`;
    await this.page.goto(fullUrl, { waitUntil: 'networkidle2' });

    // Verifier si on est redirige vers /login (session expiree)
    if (this.isOnLoginPage()) {
      console.log(`[${this.config.name}] Session expiree, reconnexion...`);
      this.authenticated = false;
      const ok = await this.login();
      if (!ok) return null;

      // Re-naviguer apres login
      await this.page.goto(fullUrl, { waitUntil: 'networkidle2' });

      if (this.isOnLoginPage()) {
        console.error(`[${this.config.name}] Impossible d'acceder a ${urlPath} apres reconnexion`);
        return null;
      }
    }

    // Extraire le texte brut de la page
    const text = await this.page.evaluate(() => document.body.innerText);
    return text;
  }

  // ----------------------------------------------------------
  //  Scrape TDB (tableau de bord commercial)
  // ----------------------------------------------------------
  async fetchTDB() {
    try {
      const text = await this.navigateWithRelogin('/tdb');
      if (!text) return null;
      return this.parseTDB(text);
    } catch (err) {
      console.error(`[${this.config.name}] Erreur fetch TDB:`, err.message);
      return null;
    }
  }

  // ----------------------------------------------------------
  //  Scrape pedago TDB
  // ----------------------------------------------------------
  async fetchPedago() {
    try {
      const text = await this.navigateWithRelogin('/pedago/tdb');
      if (!text) return null;
      return this.parsePedago(text);
    } catch (err) {
      console.error(`[${this.config.name}] Erreur fetch pedago:`, err.message);
      return null;
    }
  }

  // ----------------------------------------------------------
  //  Parse TDB : extraction des KPIs depuis le texte brut
  // ----------------------------------------------------------
  //
  //  Le texte du TDB contient des blocs comme :
  //    "62 500 Nouveaux Prospects 4399/5020"
  //  ou 62 = valeur du mois, 500 = delta objectif (ignore),
  //  4399/5020 = cumul annee / objectif
  //
  //  Certains blocs n'ont pas de delta :
  //    "19 Nouveaux Candidats (360 sur l'annee)"
  //
  parseTDB(rawText) {
    const data = {
      source: this.config.name,
      fetchedAt: new Date().toISOString()
    };

    // Normaliser les espaces
    const text = rawText.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');
    // Version sur une seule ligne pour les regex multi-mots
    const oneLine = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ');

    try {
      // ---- KPIs principaux ----

      // Nouveaux Prospects : "62 500 Nouveaux Prospects 4399/5020"
      const prospectsMatch = oneLine.match(/(\d+)\s+\d+\s+Nouveaux Prospects\s+(\d+)\/(\d+)/);
      if (prospectsMatch) {
        data.prospects = {
          month: parseInt(prospectsMatch[1]),
          current: parseInt(prospectsMatch[2]),
          objective: parseInt(prospectsMatch[3])
        };
      }

      // Nouveaux Candidats : "19 Nouveaux Candidats (360 sur l'annee)"
      const candidatsMatch = oneLine.match(/(\d+)\s+Nouveaux Candidats\s*\((\d+)\s+sur l.ann/);
      if (candidatsMatch) {
        data.candidats = {
          month: parseInt(candidatsMatch[1]),
          yearTotal: parseInt(candidatsMatch[2])
        };
      }

      // Admis (hors abandons) : "12 220 Admis (hors abandons) 302/1180"
      const admisMatch = oneLine.match(/(\d+)\s+\d+\s+Admis\s*\(hors abandons\)\s*(\d+)\/(\d+)/);
      if (admisMatch) {
        data.admis = {
          month: parseInt(admisMatch[1]),
          current: parseInt(admisMatch[2]),
          objective: parseInt(admisMatch[3])
        };
      }

      // Frais payes (ou offerts) : "16 Frais payes (ou offerts) (396 sur l'annee)"
      const fraisMatch = oneLine.match(/(\d+)\s+Frais pay[eé]s\s*\(ou offerts\)\s*\((\d+)\s+sur l.ann/);
      if (fraisMatch) {
        data.inscrits = {
          month: parseInt(fraisMatch[1]),
          yearTotal: parseInt(fraisMatch[2])
        };
      }

      // Offres d'emploi : "9 120 Offres d'emploi 64/1000"
      const offresMatch = oneLine.match(/(\d+)\s+\d+\s+Offres d.emploi\s+(\d+)\/(\d+)/);
      if (offresMatch) {
        data.offres = {
          month: parseInt(offresMatch[1]),
          current: parseInt(offresMatch[2]),
          objective: parseInt(offresMatch[3])
        };
      }

      // Etudiants places : "0 90 Etudiant places 19/735"
      const placesMatch = oneLine.match(/(\d+)\s+\d+\s+[EÉeé]tudiants?\s+plac[eé]s\s+(\d+)\/(\d+)/);
      if (placesMatch) {
        data.places = {
          month: parseInt(placesMatch[1]),
          current: parseInt(placesMatch[2]),
          objective: parseInt(placesMatch[3])
        };
      }

      // Abandons : "8 Abandons (18 sur l'annee)"
      const abandonsMatch = oneLine.match(/(\d+)\s+Abandons\s*\((\d+)\s+sur l.ann/);
      if (abandonsMatch) {
        data.abandons = {
          month: parseInt(abandonsMatch[1]),
          yearTotal: parseInt(abandonsMatch[2])
        };
      }

      // ---- Prospects N+1 ----
      const prospectsNextMatch = oneLine.match(/(\d+)\s+Prospects\s+(\d{4})\/(\d{4})/);
      if (prospectsNextMatch) {
        data.prospectsNext = {
          count: parseInt(prospectsNextMatch[1]),
          label: `${prospectsNextMatch[2]}/${prospectsNextMatch[3]}`
        };
      }

      // ---- Objectif % ----
      const objectifMatch = oneLine.match(/(\d+)%\s*objectif\s+(\d{4}\/\d{4})/);
      if (objectifMatch) {
        data.objectifPct = parseInt(objectifMatch[1]);
      }

      // ---- Detail etudiants places / montants / restants ----
      const placesDetailMatch = oneLine.match(/(\d+)\/(\d+)\s+[eé]tudiants?\s+plac[eé]s/);
      if (placesDetailMatch) {
        data.placesDetail = {
          current: parseInt(placesDetailMatch[1]),
          objective: parseInt(placesDetailMatch[2])
        };
      }

      const montantsGlobalMatch = oneLine.match(/(\d+)\/(\d+)\s+montants/);
      if (montantsGlobalMatch) {
        data.montants = {
          current: parseInt(montantsGlobalMatch[1]),
          objective: parseInt(montantsGlobalMatch[2])
        };
      }

      const restantsGlobalMatch = oneLine.match(/(\d+)\s+restants/);
      if (restantsGlobalMatch) {
        data.restants = parseInt(restantsGlobalMatch[1]);
      }

      // ---- Admis detail + projection ----
      const admisDetailMatch = oneLine.match(/(\d+)\s+admis\s*\(hors abandon\)/);
      if (admisDetailMatch) {
        data.admisTotal = parseInt(admisDetailMatch[1]);
      }
      const abandonsDetailMatch = oneLine.match(/(\d+)\s+abandons/);
      if (abandonsDetailMatch) {
        data.abandonsTotal = parseInt(abandonsDetailMatch[1]);
      }
      const projectionMatch = oneLine.match(/(\d+)\s+projection\s+\d{4}\/\d{4}/);
      if (projectionMatch) {
        data.projection = parseInt(projectionMatch[1]);
      }

      // ---- Totaux avec pourcentages ----
      const totalProspMatch = oneLine.match(/(\d+)%\s*Total Prospection\s+(\d+)\/(\d+)/);
      if (totalProspMatch) {
        data.totalProspection = {
          pct: parseInt(totalProspMatch[1]),
          current: parseInt(totalProspMatch[2]),
          objective: parseInt(totalProspMatch[3])
        };
      }

      const totalInscritsMatch = oneLine.match(/(\d+)%\s*Total Inscrits\s+(\d+)\/(\d+)/);
      if (totalInscritsMatch) {
        data.totalInscrits = {
          pct: parseInt(totalInscritsMatch[1]),
          current: parseInt(totalInscritsMatch[2]),
          objective: parseInt(totalInscritsMatch[3])
        };
      }

      const totalOffresMatch = oneLine.match(/(\d+)%\s*Total Offres d.emploi\s+(\d+)\/(\d+)/);
      if (totalOffresMatch) {
        data.totalOffres = {
          pct: parseInt(totalOffresMatch[1]),
          current: parseInt(totalOffresMatch[2]),
          objective: parseInt(totalOffresMatch[3])
        };
      }

      const totalPlacementsMatch = oneLine.match(/(\d+)%\s*Total Placements\s+(\d+)\/(\d+)/);
      if (totalPlacementsMatch) {
        data.totalPlacements = {
          pct: parseInt(totalPlacementsMatch[1]),
          current: parseInt(totalPlacementsMatch[2]),
          objective: parseInt(totalPlacementsMatch[3])
        };
      }

      // ---- Formations (detail par filiere) ----
      //
      // Format dans le texte brut (chaque info sur une ligne):
      //   FORMATION_NAME
      //   N candidats
      //   N admis
      //   [N abandons]
      //   N restants
      //   [N montants]
      //
      data.formations = this.parseFormations(text);

      // ---- Actions a traiter (sidebar) ----
      data.actions = {};
      const actionsRegex = /(\d+)\s+(Alertes?\s+[aà]\s+traiter|Ruptures?\s+[aà]\s+traiter|Prospects?\s+[aà]\s+rappeler|Candidats?\s+[aà]\s+rappeler|Entreprises?\s+[aà]\s+rappeler|PIAF\s+[aà]\s+valider|Paiements?\s+en\s+attente|CV\s+[aà]\s+valider)/gi;
      let aMatch;
      while ((aMatch = actionsRegex.exec(oneLine)) !== null) {
        // Normaliser le label en cle snake_case
        const label = aMatch[2]
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // supprimer accents
          .replace(/\s+a\s+/g, '_')
          .replace(/\s+en\s+/g, '_')
          .replace(/\s+/g, '_')
          .replace(/s$/, '');  // singulier
        data.actions[label] = parseInt(aMatch[1]);
      }

    } catch (parseErr) {
      console.error(`[${this.config.name}] Erreur parsing TDB:`, parseErr.message);
    }

    return data;
  }

  // ----------------------------------------------------------
  //  Parse formations : extraction par blocs de lignes
  // ----------------------------------------------------------
  parseFormations(text) {
    const formations = [];
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Chercher des blocs : un nom en majuscules suivi de "N candidats", "N admis", etc.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Un nom de formation est generalement en majuscules, 3+ caracteres
      if (!/^[A-ZÉÈÊÀÙÛÔÎÏÜ\s\/\-\.&]{3,}$/.test(line)) continue;

      // Verifier que les lignes suivantes correspondent au pattern attendu
      const formation = { name: line };
      let j = i + 1;
      let foundCandidats = false;

      while (j < lines.length && j <= i + 6) {
        const next = lines[j];
        const candidatsM = next.match(/^(\d+)\s+candidats?$/i);
        const admisM = next.match(/^(\d+)\s+admis$/i);
        const abandonsM = next.match(/^(\d+)\s+abandons?$/i);
        const restantsM = next.match(/^(\d+)\s+restants?$/i);
        const montantsM = next.match(/^(\d+)\s+montants?$/i);

        if (candidatsM) { formation.candidats = parseInt(candidatsM[1]); foundCandidats = true; }
        else if (admisM) { formation.admis = parseInt(admisM[1]); }
        else if (abandonsM) { formation.abandons = parseInt(abandonsM[1]); }
        else if (restantsM) { formation.restants = parseInt(restantsM[1]); }
        else if (montantsM) { formation.montants = parseInt(montantsM[1]); }
        else {
          // Ligne qui ne correspond a rien => fin du bloc
          break;
        }
        j++;
      }

      // Accepter la formation si au moins "candidats" et "admis" sont trouves
      if (foundCandidats && formation.admis !== undefined) {
        formation.abandons = formation.abandons || 0;
        formation.restants = formation.restants || 0;
        formation.montants = formation.montants || 0;
        formations.push(formation);
      }
    }

    return formations;
  }

  // ----------------------------------------------------------
  //  Parse pedago TDB
  // ----------------------------------------------------------
  parsePedago(rawText) {
    const text = rawText.replace(/\s+/g, ' ');
    const data = {};

    try {
      const etudiantsMatch = text.match(/(\d+)\s+[EÉeé]tudiants/);
      if (etudiantsMatch) data.etudiants = parseInt(etudiantsMatch[1]);

      const contratsMatch = text.match(/(\d+)\s+Contrats?\s+d.alternance\s+en\s+cours/i);
      if (contratsMatch) data.contratsAlternance = parseInt(contratsMatch[1]);

      const initialeMatch = text.match(/(\d+)\s+Formation\s+initiale/i);
      if (initialeMatch) data.formationInitiale = parseInt(initialeMatch[1]);

      const rupturesMatch = text.match(/(\d+)\s+Ruptures?\s+\d{4}/i);
      if (rupturesMatch) data.rupturesPedago = parseInt(rupturesMatch[1]);
    } catch (err) {
      console.error(`[${this.config.name}] Erreur parsing pedago:`, err.message);
    }

    return data;
  }

  // ----------------------------------------------------------
  //  Fermeture propre du navigateur
  // ----------------------------------------------------------
  async close() {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
        this.authenticated = false;
        console.log(`[${this.config.name}] Navigateur ferme`);
      }
    } catch (err) {
      console.error(`[${this.config.name}] Erreur fermeture navigateur:`, err.message);
    }
  }
}

// ============================================================
//  Instances des clients CRM
// ============================================================

const clients = {
  clem: new CRMClient(CRM_CONFIG.clem),
  will: new CRMClient(CRM_CONFIG.will)
};

// ============================================================
//  Recuperation de toutes les donnees
// ============================================================

async function fetchAllData() {
  if (isRefreshing) {
    console.log('[Cockpit] Rafraichissement deja en cours, ignore');
    return cachedData;
  }

  isRefreshing = true;
  console.log(`\n[Cockpit] Recuperation des donnees CRM - ${new Date().toLocaleTimeString('fr-FR')}`);

  const results = {};

  for (const [key, client] of Object.entries(clients)) {
    // Verifier que les identifiants sont configures
    if (!client.config.email || !client.config.password) {
      console.warn(`[${client.config.name}] Identifiants non configures, skip`);
      fetchErrors[key] = 'Identifiants non configures dans .env';
      continue;
    }

    try {
      // Scraper TDB puis pedago sequentiellement (meme page/session)
      const tdb = await client.fetchTDB();

      let pedago = null;
      if (tdb) {
        pedago = await client.fetchPedago();
      }

      if (tdb) {
        results[key] = { ...tdb, pedago: pedago || {} };
        fetchErrors[key] = null;
        console.log(`[${client.config.name}] OK - Prospects: ${tdb.prospects?.current || '?'}/${tdb.prospects?.objective || '?'}, Formations: ${tdb.formations?.length || 0}`);
      } else {
        fetchErrors[key] = 'Echec recuperation TDB';
        console.error(`[${client.config.name}] Echec recuperation`);
      }
    } catch (err) {
      fetchErrors[key] = err.message;
      console.error(`[${client.config.name}] Erreur:`, err.message);
    }
  }

  if (Object.keys(results).length > 0) {
    cachedData = {
      lastUpdate: new Date().toISOString(),
      schools: results,
      errors: fetchErrors
    };
    lastFetchTime = new Date();
    console.log(`[Cockpit] Donnees mises a jour avec succes`);
  } else {
    console.error('[Cockpit] Aucune donnee recuperee');
  }

  isRefreshing = false;
  return cachedData;
}

// ============================================================
//  Routes Express
// ============================================================

// Fichiers statiques depuis public/
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// GET /api/cockpit-data : donnees en cache
app.get('/api/cockpit-data', (req, res) => {
  res.json({
    success: !!cachedData,
    data: cachedData,
    lastFetch: lastFetchTime?.toISOString() || null,
    nextFetch: lastFetchTime
      ? new Date(lastFetchTime.getTime() + REFRESH_INTERVAL).toISOString()
      : null,
    errors: fetchErrors
  });
});

// POST /api/cockpit-refresh : forcer un rafraichissement
app.post('/api/cockpit-refresh', async (req, res) => {
  try {
    const data = await fetchAllData();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/cockpit-status : etat du serveur
app.get('/api/cockpit-status', (req, res) => {
  res.json({
    status: 'running',
    lastUpdate: lastFetchTime?.toISOString() || null,
    refreshInterval: `${REFRESH_INTERVAL / 1000}s`,
    isRefreshing,
    schools: Object.fromEntries(
      Object.entries(clients).map(([k, c]) => [k, {
        name: c.config.name,
        authenticated: c.authenticated,
        hasBrowser: !!(c.browser && c.browser.isConnected()),
        error: fetchErrors[k] || null
      }])
    )
  });
});

// GET / et /cockpit : servir cockpit.html directement
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cockpit.html'));
});
app.get('/cockpit', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cockpit.html'));
});

// ============================================================
//  Demarrage du serveur
// ============================================================

app.listen(PORT, async () => {
  console.log(`\n========================================`);
  console.log(`  COCKPIT SERVER (Puppeteer) - Port ${PORT}`);
  console.log(`  Dashboard:  http://localhost:${PORT}/cockpit.html`);
  console.log(`  API Data:   http://localhost:${PORT}/api/cockpit-data`);
  console.log(`  API Status: http://localhost:${PORT}/api/cockpit-status`);
  console.log(`  Refresh:    toutes les ${REFRESH_INTERVAL / 60000} minutes`);
  console.log(`========================================\n`);

  // Premier scrape au demarrage
  await fetchAllData();

  // Rafraichissement periodique
  setInterval(fetchAllData, REFRESH_INTERVAL);
});

// ============================================================
//  Nettoyage a l'arret (fermer les navigateurs Puppeteer)
// ============================================================

async function cleanup() {
  console.log('\n[Cockpit] Arret en cours, fermeture des navigateurs...');
  for (const client of Object.values(clients)) {
    await client.close();
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
