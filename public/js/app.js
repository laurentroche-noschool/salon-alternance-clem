// ===== UTILITAIRE : AFFICHER/MASQUER PIN =====
function togglePinVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
  btn.classList.toggle('active', show);
  input.focus();
}

// ===== STATE =====
let companies = [];
let currentMode = null;
let currentFiliere = 'all';
let creAuthenticated = false;
let crePin = '';
let currentCRECompany = null;
let registrations = {};
let sheetCandidates = [];
let sheetCandidatesLastSync = null;
let sheetCheckinFilter = 'all';
let autocompleteList = [];

// Enterprise state
let entAuthenticated = false;
let entPin = '';
let currentEntCompany = null;
let entStudents = [];
let entRatings = {};
let entPendingChanges = {};
let entCREStudentNotes = {}; // notes CRE par étudiant (lecture seule côté entreprise)

const FILIERE_COLORS = {
  'COMMERCE NS':              '#8b5cf6',
  'COMMERCE CLEM':            '#ec4899',
  'IMMOBILIER':               '#10b981',
  'BANQUE / ASSURANCE':       '#f59e0b',
  'MARKETING / COM / SOCIAL': '#f97316',
  'RH / TOURISME':            '#06b6d4',
  'AUTRE':                    '#94a3b8'
};

const FILIERE_LABELS = {
  'COMMERCE NS':              'Commerce CLEM',
  'COMMERCE CLEM':            'Commerce CLEM',
  'IMMOBILIER':               'Immobilier',
  'BANQUE / ASSURANCE':       'Banque / Assurance',
  'MARKETING / COM / SOCIAL': 'Marketing / Com / Digital et Social',
  'RH / TOURISME':            'RH / Tourisme'
};

const FILIERE_ORDER = [
  'COMMERCE NS',
  'COMMERCE CLEM',
  'IMMOBILIER',
  'BANQUE / ASSURANCE',
  'MARKETING / COM / SOCIAL',
  'RH / TOURISME'
];

// Normalize old/alias filière values
const FILIERE_NORMALIZE = {
  'SOCIAL':                    'MARKETING / COM / SOCIAL',
  'SOLUTION DIGITALE':         'MARKETING / COM / SOCIAL',
  'Solution numérique':        'MARKETING / COM / SOCIAL',
  'Solution digitale':         'MARKETING / COM / SOCIAL',
  'SOLUTION NUMÉRIQUE':        'MARKETING / COM / SOCIAL',
  'MARKETING / COMMUNICATION': 'MARKETING / COM / SOCIAL',
  'LE COMMERCE SERA':          'COMMERCE CLEM',
};

function groupAndSort(list) {
  // Sort alphabetically by display name
  const sorted = [...list].sort((a, b) => {
    const nameA = (a.nomAffichage || a.nom).toLowerCase();
    const nameB = (b.nomAffichage || b.nom).toLowerCase();
    return nameA.localeCompare(nameB, 'fr');
  });

  // Group by filière following FILIERE_ORDER (normalize aliases)
  const groups = {};
  sorted.forEach(company => {
    const raw = company.filiere || 'AUTRE';
    const f = FILIERE_NORMALIZE[raw] || raw;
    if (!groups[f]) groups[f] = [];
    groups[f].push(company);
  });

  // Build result in FILIERE_ORDER order, then any remaining filières
  const result = [];
  const handled = new Set();
  FILIERE_ORDER.forEach(f => {
    if (groups[f] && groups[f].length > 0) {
      result.push({ filiere: f, color: FILIERE_COLORS[f] || '#94a3b8', companies: groups[f] });
      handled.add(f);
    }
  });
  Object.keys(groups).forEach(f => {
    if (!handled.has(f) && groups[f].length > 0) {
      result.push({ filiere: f, color: FILIERE_COLORS[f] || '#94a3b8', companies: groups[f] });
    }
  });
  return result;
}

// ===== INIT =====
async function init() {
  try {
    // Charger la config (titre personnalisable par école)
    const cfgRes = await fetch('/api/config');
    const cfg = await cfgRes.json();
    document.title = cfg.title + ' — ' + cfg.subtitle;
    document.querySelectorAll('.home-title').forEach(el => {
      const accent = el.querySelector('.home-title-accent');
      const parts = cfg.title.split(' ');
      el.textContent = parts.slice(0, -1).join(' ') + ' ';
      const sp = document.createElement('span');
      sp.className = 'home-title-accent';
      sp.textContent = parts[parts.length - 1];
      el.appendChild(sp);
    });
    document.querySelectorAll('.header-title').forEach(el => { el.textContent = cfg.title; });
    if (!cfg.showWillLogo) {
      document.querySelectorAll('.clem-logo').forEach(el => { el.style.display = 'none'; });
    }
    if (!cfg.showPlanSalon) {
      document.querySelectorAll('.btn-plan-salon').forEach(el => { el.style.display = 'none'; });
      const modalPlan = document.getElementById('modal-plan-salon');
      if (modalPlan) modalPlan.remove();
    }
    const res = await fetch('/api/companies');
    const raw = await res.json();
    // Normaliser les filières dès le chargement (défense côté client)
    companies = raw.map(c => ({
      ...c,
      filiere: FILIERE_NORMALIZE[c.filiere] || c.filiere,
      stand: { salle: c.salle || '', etage: c.etage || '' }
    }));
    updateFilterCounts();
    await restoreSession();
  } catch (e) {
    console.error('Erreur chargement entreprises:', e);
  }
}

// ===== RESTAURATION SESSION (survit au rafraîchissement) =====
async function restoreSession() {
  const screen = sessionStorage.getItem('currentScreen');
  if (!screen || screen === 'screen-home') return;

  if (screen === 'screen-student' && sessionStorage.getItem('ss_authStudent')) {
    enterStudentMode();
  } else if (screen === 'screen-selfregister' && sessionStorage.getItem('ss_authSelfReg')) {
    enterSelfRegisterMode();
  } else if (screen === 'screen-cre') {
    const pin = sessionStorage.getItem('ss_crePin');
    if (pin) {
      crePin = pin;
      creAuthenticated = true;
      enterCREMode();
      document.getElementById('cre-login').style.display = 'none';
      document.getElementById('cre-dashboard').style.display = 'block';
      requestAnimationFrame(updateCRETabsTop);
      await loadRegistrations();
      renderCREGrid(companies);
      updateCREStats();
      loadAutocompleteList(pin);
    }
  } else if (screen === 'screen-admin') {
    const pin = sessionStorage.getItem('ss_adminPin');
    if (pin) {
      adminPin = pin;
      enterAdminMode();
      document.getElementById('admin-login').style.display = 'none';
      document.getElementById('admin-dashboard').style.display = 'block';
      await loadAdminStats();
    }
  } else if (screen === 'screen-entreprise') {
    const pin = sessionStorage.getItem('ss_entPin');
    if (pin) {
      entPin = pin;
      entAuthenticated = true;
      enterEntrepriseMode();
      document.getElementById('ent-login').style.display = 'none';
      document.getElementById('ent-selection').style.display = 'block';
      renderEntSelection(companies);
      loadAutocompleteList(pin);
    }
  }
}

// ===== NAVIGATION =====
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  sessionStorage.setItem('currentScreen', id);
}

function openPlanSalon() {
  document.getElementById('modal-plan-salon').style.display = 'flex';
}
function closePlanSalon() {
  document.getElementById('modal-plan-salon').style.display = 'none';
}

function goHome() {
  showScreen('screen-home');
  currentMode = null;
  // Effacer la session sauvegardée
  sessionStorage.removeItem('currentScreen');
  sessionStorage.removeItem('ss_authStudent');
  sessionStorage.removeItem('ss_authSelfReg');
  sessionStorage.removeItem('ss_crePin');
  sessionStorage.removeItem('ss_adminPin');
  sessionStorage.removeItem('ss_entPin');

  // Reset CRE
  creAuthenticated = false;
  document.getElementById('cre-login').style.display = 'flex';
  document.getElementById('cre-dashboard').style.display = 'none';
  document.getElementById('cre-pin-input').value = '';
  document.getElementById('cre-login-error').style.display = 'none';

  // Reset Admin
  adminPin = '';
  document.getElementById('admin-login').style.display = 'flex';
  document.getElementById('admin-dashboard').style.display = 'none';
  document.getElementById('admin-pin-input').value = '';
  document.getElementById('admin-login-error').style.display = 'none';

  // Reset Enterprise
  entAuthenticated = false;
  entPin = '';
  currentEntCompany = null;
  entStudents = [];
  entRatings = {};
  entPendingChanges = {};
  document.getElementById('ent-login').style.display = 'flex';
  document.getElementById('ent-selection').style.display = 'none';
  document.getElementById('ent-dashboard').style.display = 'none';
  document.getElementById('ent-pin-input').value = '';
  document.getElementById('ent-login-error').style.display = 'none';
  const backBtn = document.getElementById('ent-back-btn');
  backBtn.textContent = '← Accueil';
  backBtn.onclick = goHome;
}

function showStudentPin() {
  document.getElementById('student-pin-input').value = '';
  document.getElementById('student-pin-error').style.display = 'none';
  document.getElementById('modal-student-pin').style.display = 'flex';
  setTimeout(() => document.getElementById('student-pin-input').focus(), 100);
}

function closeStudentPin() {
  document.getElementById('modal-student-pin').style.display = 'none';
}

function verifyStudentPin() {
  const pin = document.getElementById('student-pin-input').value.trim();
  if (pin === '2026') {
    closeStudentPin();
    sessionStorage.setItem('ss_authStudent', '1');
    enterStudentMode();
  } else {
    document.getElementById('student-pin-error').style.display = 'block';
    document.getElementById('student-pin-input').value = '';
    document.getElementById('student-pin-input').focus();
  }
}

function enterStudentMode() {
  currentMode = 'student';
  showScreen('screen-student');
  filterFiliere('all', document.querySelector('[data-filiere="all"]'));
  renderCompaniesGrid(companies);
}

function enterEntrepriseMode() {
  currentMode = 'entreprise';
  showScreen('screen-entreprise');
}

function enterCREMode() {
  currentMode = 'cre';
  showScreen('screen-cre');
  // Adjust sticky tabs to actual header height after rendering
  requestAnimationFrame(updateCRETabsTop);
}

function updateCRETabsTop() {
  const header = document.querySelector('#screen-cre .app-header');
  const tabs   = document.querySelector('.cre-view-tabs');
  if (header && tabs) {
    tabs.style.top = header.getBoundingClientRect().height + 'px';
  }
}
window.addEventListener('resize', function() {
  updateCRETabsTop();
  fixCandidatsSticky();
  updateSRStickyTop();
});

// Fige le bandeau CTA + en-tête liste dans l'écran "Je m'inscris"
function updateSRStickyTop() {
  const header   = document.querySelector('#screen-selfregister .app-header');
  const ctaBar   = document.querySelector('.sr-cta-bar');
  const dirHeader = document.querySelector('.sr-directory-header');
  if (!header) return;
  const headerH = header.getBoundingClientRect().height;
  if (ctaBar) {
    ctaBar.style.top = headerH + 'px';
    const ctaH = ctaBar.getBoundingClientRect().height;
    if (dirHeader) dirHeader.style.top = (headerH + ctaH) + 'px';
  } else if (dirHeader) {
    dirHeader.style.top = headerH + 'px';
  }
}

// Fige le bandeau de l'onglet Candidats : candidats-header, filters et thead restent visibles
function fixCandidatsSticky() {
  if (currentCREView !== 'candidats') return;
  const appHeader   = document.querySelector('#screen-cre .app-header');
  const creTabs     = document.querySelector('.cre-view-tabs');
  const candHeader  = document.querySelector('.candidats-header');
  const candFilters = document.querySelector('.candidats-filters');
  const srSection   = document.getElementById('sr-pending-section');
  const tableWrap   = document.getElementById('sheet-candidates-table');
  if (!appHeader || !creTabs || !candHeader || !candFilters || !tableWrap) return;

  function elH(el) {
    return (el && el.offsetParent !== null) ? el.getBoundingClientRect().height : 0;
  }

  const appH    = elH(appHeader);
  const tabsH   = elH(creTabs);
  const headTop = appH + tabsH;

  // .candidats-header sticky just below CRE tabs
  candHeader.style.top = headTop + 'px';

  // .candidats-filters sticky below candidats-header
  const candHeaderH = elH(candHeader);
  candFilters.style.top = (headTop + candHeaderH) + 'px';

  // Table container fills the remaining viewport (scroll inside the container)
  const filtersH = elH(candFilters);
  const srH      = elH(srSection);
  const tableTop = headTop + candHeaderH + filtersH + srH;
  const remaining = window.innerHeight - tableTop;
  tableWrap.style.height    = Math.max(200, remaining) + 'px';
  tableWrap.style.overflowY = 'auto';
}

// ===== MODE JE M'INSCRIS =====
let srCurrentFiliere = 'all';

function enterSelfRegisterMode() {
  currentMode = 'selfregister';
  sessionStorage.setItem('ss_authSelfReg', '1');
  showScreen('screen-selfregister');
  srRenderCompaniesGrid(companies);
  srUpdateFilterCounts();
  requestAnimationFrame(updateSRStickyTop);
}

function srUpdateFilterCounts() {
  const el = document.getElementById('sr-count-all');
  if (el) el.textContent = companies.length;
}

function srSearchCompanies() {
  const search = (document.getElementById('sr-search-input').value || '').toLowerCase().trim();
  document.querySelectorAll('#sr-companies-grid .company-card').forEach(card => {
    card.classList.toggle('hidden', !!(search && !card.dataset.name.includes(search)));
  });
  document.querySelectorAll('#sr-companies-grid .filiere-section').forEach(section => {
    const hasVisible = Array.from(section.querySelectorAll('.company-card')).some(c => !c.classList.contains('hidden'));
    section.style.display = hasVisible ? 'block' : 'none';
  });
}

function srRenderCompaniesGrid(list) {
  const grid = document.getElementById('sr-companies-grid');
  grid.innerHTML = '';
  const grouped = groupAndSort(list);
  grouped.forEach(({ filiere, color, companies: groupCompanies }) => {
    const section = document.createElement('div');
    section.className = 'filiere-section';
    section.dataset.filiere = filiere;

    const count = groupCompanies.length;
    const header = document.createElement('div');
    header.className = 'filiere-section-header';
    header.innerHTML = `
      <div class="filiere-section-dot" style="background:${color}"></div>
      <span class="filiere-section-name">${FILIERE_LABELS[filiere] || filiere}</span>
      <span class="filiere-section-count">${count} entreprise${count > 1 ? 's' : ''}</span>
    `;
    section.appendChild(header);

    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'cards-grid-wrap';

    groupCompanies.forEach(company => {
      const cardColor = FILIERE_COLORS[company.filiere] || '#94a3b8';
      const initials = getInitials(company.nomAffichage || company.nom);

      const card = document.createElement('div');
      card.className = 'company-card sr-company-card';
      card.dataset.filiere = company.filiere;
      card.dataset.name = (company.nom + ' ' + (company.nomAffichage || '')).toLowerCase();
      card.style.setProperty('--card-color', cardColor);
      card.onclick = () => { openStudentModal(company); document.getElementById('modal-student').classList.add('sr-mode'); };

      card.innerHTML = `
        <div class="card-logo-area">
          ${company.logoFile
            ? `<img src="/images/logos/${company.logoFile}" alt="${company.nomAffichage || company.nom}"
                onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'" />
               <div class="card-logo-fallback-inner" style="display:none;background:${cardColor}">${initials}</div>`
            : `<div class="card-logo-fallback-inner" style="background:${cardColor}">${initials}</div>`
          }
        </div>
        <div class="card-info">
          <div class="card-name">${company.nomAffichage || company.nom}</div>
          ${company.secteur ? `<div class="card-tagline">${company.secteur}</div>` : ''}
        </div>
      `;
      cardsWrap.appendChild(card);
    });

    section.appendChild(cardsWrap);
    grid.appendChild(section);
  });
}

// Modale simplifiée Je m'inscris — infos de base uniquement
function openSrDetail(company) {
  const color = FILIERE_COLORS[company.filiere] || '#94a3b8';
  const initials = getInitials(company.nomAffichage || company.nom);
  const standTxt = getStandText(company.stand);

  const logoEl = document.getElementById('sr-detail-logo');
  const fallbackEl = document.getElementById('sr-detail-logo-fallback');
  if (company.logoFile) {
    logoEl.src = `/images/logos/${company.logoFile}`;
    logoEl.style.display = 'block';
    fallbackEl.style.display = 'none';
  } else {
    logoEl.style.display = 'none';
    fallbackEl.style.display = 'flex';
    fallbackEl.style.background = color;
    fallbackEl.textContent = initials;
  }

  document.getElementById('sr-detail-name').textContent = company.nomAffichage || company.nom;
  const badge = document.getElementById('sr-detail-filiere');
  badge.textContent = company.filiere || '';
  badge.style.background = color;

  const tagEl = document.getElementById('sr-detail-tagline');
  tagEl.textContent = company.tagline || company.secteur || '';

  const standEl = document.getElementById('sr-detail-stand');
  standEl.textContent = standTxt || 'Emplacement à confirmer';
  standEl.className = standTxt ? 'sr-detail-stand-value' : 'sr-detail-stand-value not-set';

  const webEl = document.getElementById('sr-detail-website');
  if (company.website) {
    webEl.href = company.website;
    webEl.style.display = 'inline-flex';
  } else {
    webEl.style.display = 'none';
  }

  document.getElementById('modal-sr-detail').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeSrDetail() {
  document.getElementById('modal-sr-detail').classList.remove('open');
  document.body.style.overflow = '';
}

// ===== FILTER COUNTS =====
function updateFilterCounts() {
  document.getElementById('count-all').textContent = companies.length;
  document.getElementById('count-COMMERCE-NS').textContent  = companies.filter(c => c.filiere === 'COMMERCE NS' || c.filiere === 'COMMERCE').length;
  document.getElementById('count-COMMERCE-WILL').textContent = companies.filter(c => c.filiere === 'COMMERCE CLEM').length;
  document.getElementById('count-IMMOBILIER').textContent   = companies.filter(c => c.filiere === 'IMMOBILIER').length;
  document.getElementById('count-BANQUE').textContent       = companies.filter(c => c.filiere === 'BANQUE / ASSURANCE').length;
  document.getElementById('count-MARKETING').textContent    = companies.filter(c => c.filiere === 'MARKETING / COM / SOCIAL').length;
  document.getElementById('count-RH').textContent           = companies.filter(c => c.filiere === 'RH / TOURISME').length;
  document.getElementById('count-SOCIAL').textContent       = companies.filter(c => c.filiere === 'SOCIAL').length;
}

// ===== FILTER FILIERE =====
function filterFiliere(filiere, btn) {
  currentFiliere = filiere;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const search = (document.getElementById('search-input') || {}).value || '';
  applyFilters(filiere, search);
}

function searchCompanies() {
  const search = document.getElementById('search-input').value.toLowerCase().trim();
  applyFilters(currentFiliere, search);
}

function applyFilters(filiere, search) {
  const cards = document.querySelectorAll('#companies-grid .company-card');
  cards.forEach(card => {
    const cardFiliere = card.dataset.filiere;
    const cardName = card.dataset.name.toLowerCase();
    const filiereOk = filiere === 'all' || cardFiliere === filiere;
    const searchOk = !search || cardName.includes(search);
    card.classList.toggle('hidden', !(filiereOk && searchOk));
  });
  // Hide sections that have no visible cards
  document.querySelectorAll('#companies-grid .filiere-section').forEach(section => {
    const hasVisible = Array.from(section.querySelectorAll('.company-card')).some(c => !c.classList.contains('hidden'));
    section.style.display = hasVisible ? 'block' : 'none';
  });
}

// ===== RENDER STUDENT GRID =====
function renderCompaniesGrid(list) {
  const grid = document.getElementById('companies-grid');
  grid.innerHTML = '';
  const grouped = groupAndSort(list);
  grouped.forEach(({ filiere, color, companies: groupCompanies }) => {
    const section = document.createElement('div');
    section.className = 'filiere-section';
    section.dataset.filiere = filiere;

    const count = groupCompanies.length;
    const header = document.createElement('div');
    header.className = 'filiere-section-header';
    header.innerHTML = `
      <div class="filiere-section-dot" style="background:${color}"></div>
      <span class="filiere-section-name">${FILIERE_LABELS[filiere] || filiere}</span>
      <span class="filiere-section-count">${count} entreprise${count > 1 ? 's' : ''}</span>
    `;
    section.appendChild(header);

    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'cards-grid-wrap';

    groupCompanies.forEach(company => {
      const cardColor = FILIERE_COLORS[company.filiere] || '#94a3b8';
      const initials = getInitials(company.nomAffichage || company.nom);
      const standTxt = getStandText(company.stand);
      const tagline = [company.tagline || company.secteur, standTxt].filter(Boolean).join(' • ');

      const card = document.createElement('div');
      card.className = 'company-card';
      card.dataset.filiere = company.filiere;
      card.dataset.name = (company.nom + ' ' + (company.nomAffichage || '')).toLowerCase();
      card.style.setProperty('--card-color', cardColor);
      card.onclick = () => openStudentModal(company);

      card.innerHTML = `
        <div class="card-logo-area">
          ${company.logoFile
            ? `<img src="/images/logos/${company.logoFile}"
                alt="${company.nomAffichage || company.nom}"
                onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'" />
               <div class="card-logo-fallback-inner" style="display:none;background:${cardColor}">${initials}</div>`
            : `<div class="card-logo-fallback-inner" style="background:${cardColor}">${initials}</div>`
          }
        </div>
        <div class="card-info">
          <div class="card-name">${company.nomAffichage || company.nom}</div>
        </div>
      `;
      cardsWrap.appendChild(card);
    });

    section.appendChild(cardsWrap);
    grid.appendChild(section);
  });
}

function getInitials(name) {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function getStandText(stand) {
  if (!stand) return '';
  const parts = [stand.salle, stand.etage].filter(Boolean);
  return parts.length ? parts.join(' • ') : '';
}

// ===== STUDENT MODAL =====
function openStudentModal(company) {
  const color = FILIERE_COLORS[company.filiere] || '#94a3b8';
  const initials = getInitials(company.nomAffichage || company.nom);

  // Logo
  const logoEl = document.getElementById('modal-logo');
  const logoFallback = document.getElementById('modal-logo-fallback');
  logoFallback.style.display = 'none';
  if (company.logoFile) {
    logoEl.style.display = 'block';
    logoEl.src = `/images/logos/${company.logoFile}`;
    logoEl.alt = company.nomAffichage || company.nom;
    logoFallback.style.background = color;
    logoFallback.textContent = initials;
  } else {
    logoEl.style.display = 'none';
    logoFallback.style.display = 'flex';
    logoFallback.style.background = color;
    logoFallback.textContent = initials;
  }

  document.getElementById('modal-company-name').textContent = company.nomAffichage || company.nom;

  const badge = document.getElementById('modal-filiere-badge');
  badge.textContent = company.filiere;
  badge.style.background = color;

  document.getElementById('modal-secteur').textContent = company.tagline || company.secteur || '';

  // Stand
  const standText = getStandText(company.stand);
  const standLocation = document.getElementById('stand-location');
  if (standText) {
    standLocation.textContent = standText;
    standLocation.classList.remove('not-set');
  } else {
    standLocation.textContent = 'Emplacement à confirmer';
    standLocation.classList.add('not-set');
  }

  const websiteLink = document.getElementById('modal-website');
  websiteLink.href = company.website || '#';
  websiteLink.style.display = company.website ? 'inline-flex' : 'none';

  // Tabs content
  document.getElementById('modal-description').textContent = company.description || '';
  document.getElementById('modal-histoire').textContent = company.histoire || '';
  document.getElementById('modal-chiffres').textContent = company.chiffres_cles || '';
  document.getElementById('modal-secteur-detail').textContent = company.secteur || '';

  // Concurrents
  const concWrap = document.getElementById('modal-concurrents');
  concWrap.innerHTML = (company.concurrents || []).map(c =>
    `<span class="tag concurrent-tag">${c}</span>`).join('');

  document.getElementById('modal-recrutement').textContent = company.recrutement || '';

  // Valeurs
  const valeursWrap = document.getElementById('modal-valeurs');
  valeursWrap.innerHTML = (company.valeurs || []).map(v =>
    `<span class="tag valeur-tag" style="background:${color};color:#fff">${v}</span>`).join('');

  // Missions
  const missionsList = document.getElementById('modal-missions');
  missionsList.innerHTML = (company.missions || []).map(m => `<li>${m}</li>`).join('');

  // Questions
  const qRH = document.getElementById('modal-questions-rh');
  qRH.innerHTML = (company.questions_rh || []).map(q => `<li>${q}</li>`).join('');

  const qOp = document.getElementById('modal-questions-op');
  qOp.innerHTML = (company.questions_op || []).map(q => `<li>${q}</li>`).join('');

  // Soft Skills — 2 sections : filière + valeurs enseigne
  const { sectorSkills, enseigneSkills } = getSoftSkillsForCompany(company);
  const ssWrap = document.getElementById('modal-softskills');
  const renderSSCards = (list) => list.map(s => `
    <div class="ss-card" onclick="toggleSSCard(this)">
      <div class="ss-emoji">${s.emoji}</div>
      <div class="ss-body">
        <div class="ss-name">${s.skill}</div>
        <div class="ss-desc">${s.desc}</div>
        ${s.conseil ? `<div class="ss-conseil">${s.conseil}</div>` : ''}
      </div>
    </div>`).join('');

  let ssHtml = `<div class="ss-section-title">📚 Compétences clés du secteur <span class="ss-filiere-badge">${company.filiere || 'Général'}</span></div>
    <div class="softskills-grid">${renderSSCards(sectorSkills)}</div>`;

  if (enseigneSkills.length) {
    ssHtml += `<div class="ss-section-title ss-section-enseigne">🏢 Attendues spécifiquement par <strong>${company.nomAffichage || company.nom}</strong></div>
      <div class="softskills-grid">${renderSSCards(enseigneSkills)}</div>`;
  }
  ssWrap.innerHTML = ssHtml;

  // Reset tabs
  document.querySelectorAll('#modal-student .tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#modal-student .tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('#modal-student .tab-btn').classList.add('active');
  document.getElementById('tab-presentation').classList.add('active');

  document.getElementById('modal-student').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function switchTab(tabId, btn) {
  document.querySelectorAll('#modal-student .tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#modal-student .tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + tabId).classList.add('active');
}

// ===== SOFT SKILLS PAR FILIÈRE (descriptions coaching détaillées) =====
const SOFT_SKILLS_DB = {
  'COMMERCE': [
    { emoji: '🤝', skill: 'Sens du client',
      desc: 'Le recruteur veut voir que tu CRÉES un lien, pas juste que tu vends. Prépare 1-2 anecdotes précises où tu as transformé une hésitation ou une insatisfaction en expérience positive. Évite les formules creuses comme "j\'aime le contact" — montre-le avec des faits.',
      conseil: '💬 À dire : "Lors de mon stage, un client revenait souvent sans acheter — j\'ai pris le temps de comprendre ses attentes réelles et il est devenu régulier."' },
    { emoji: '👂', skill: 'Écoute active',
      desc: 'Reformuler ce que le client dit avant de répondre est un signe fort d\'écoute réelle. En entretien, applique cette même posture avec le recruteur : laisse-le finir, reformule, réponds. C\'est une démonstration live de ta compétence.',
      conseil: '💬 À dire : "Quand un client hésite, je reformule toujours sa demande pour m\'assurer d\'avoir bien compris avant de proposer quoi que ce soit."' },
    { emoji: '💬', skill: 'Aisance relationnelle',
      desc: 'Savoir adapter son registre (formel/décontracté, expert/novice) selon l\'interlocuteur est clé en commerce. En entretien, montre que tu observes et t\'adaptes — par ton vocabulaire, ton rythme, ton niveau de détail technique.',
      conseil: '💬 À dire : "Je m\'adapte naturellement : avec un client pressé je vais à l\'essentiel, avec un client qui explore, je prends le temps de le guider."' },
    { emoji: '🔄', skill: 'Adaptabilité',
      desc: 'Le retail change vite : promotions, ruptures, flux imprévisibles, nouveaux outils. Montre que tu gardes ton calme et restes efficace même quand les conditions basculent. Cherche un exemple de plan B que tu as dû improviser.',
      conseil: '💬 À dire : "Lors d\'une opération commerciale, le logiciel est tombé — j\'ai assuré les encaissements manuellement sans que les clients ne s\'en rendent compte."' },
    { emoji: '⚡', skill: 'Dynamisme & énergie',
      desc: 'En commerce, ton énergie se voit et se ressent dès la première seconde. Soigne ton arrivée, ta poignée de main, ton sourire et ta voix. Le recruteur t\'observe depuis que tu as franchi la porte — pas seulement quand tu réponds.',
      conseil: '💬 À montrer : Posture droite, sourire sincère, voix affirmée, regard direct. Ton dynamisme se "joue" autant qu\'il se "dit".' },
    { emoji: '🏆', skill: 'Goût du challenge',
      desc: 'Les environnements commerciaux fonctionnent avec des objectifs chiffrés. Montre que les chiffres ne te font pas peur et que tu te fixes toi-même des objectifs, même personnels. Un bon exemple : un défi que tu t\'es lancé et réussi.',
      conseil: '💬 À dire : "J\'aime me donner un objectif personnel chaque semaine — même hors du travail, ça m\'a appris à suivre mes progrès et à ajuster."' },
    { emoji: '💪', skill: 'Résilience',
      desc: 'En vente, les refus font partie du quotidien. Le recruteur cherche quelqu\'un qui rebondit vite sans se décourager. Trouve un exemple où tu as essuyé un échec et décris ce que tu as fait JUSTE APRÈS — c\'est ça qui compte.',
      conseil: '💬 À dire : "Un client a annulé une grosse commande la veille — j\'ai repris mon fichier, contacté d\'autres prospects et compensé 70% du manque dans la semaine."' },
    { emoji: '🤜', skill: 'Esprit d\'équipe',
      desc: 'Le commerce se fait rarement seul. Montre que tu contribues à l\'ambiance, que tu aides un collègue débordé, que tu partages l\'information. Méfie-toi de l\'erreur inverse : trop vouloir montrer ton individualité dans un rôle collectif.',
      conseil: '💬 À dire : "Quand je vois un collègue avec beaucoup de clients, je lui passe une vente ou je prends en charge un client pour lui — le résultat du magasin passe avant le mien."' },
  ],
  'COMMERCE NS': [
    { emoji: '🤝', skill: 'Sens du client',
      desc: 'CLEM forme des profils orientés commerce de terrain, avec un fort sens de la relation. Montre que tu comprends le besoin AVANT de vendre — pose des questions, écoute, reformule. Le recruteur veut voir une posture conseil, pas une posture vendeur.',
      conseil: '💬 À dire : "Je ne propose jamais un produit sans avoir compris le projet réel du client — parfois ce qu\'il demande n\'est pas ce dont il a besoin."' },
    { emoji: '🎯', skill: 'Orientation résultats',
      desc: 'Les enseignes CLEM attendent des alternants qui suivent leurs indicateurs et ne se contentent pas du minimum. Connaître son taux de transformation, son panier moyen, ses horaires chargés — c\'est la marque d\'un vrai professionnel.',
      conseil: '💬 À dire : "Je notais chaque semaine mes ventes, mon panier moyen et le nombre de clients — ça m\'a permis d\'identifier mes meilleurs créneaux et d\'améliorer ma méthode."' },
    { emoji: '💬', skill: 'Aisance relationnelle',
      desc: 'Dans un environnement retail, tu interagis avec des dizaines de profils en une seule journée. Montre que tu sais passer d\'un client difficile à un sourire sincère pour le suivant — sans porter les émotions d\'une interaction à l\'autre.',
      conseil: '💬 À dire : "Je sais faire une coupure mentale entre deux interactions — chaque client arrive avec une ardoise vierge, peu importe ce qui s\'est passé juste avant."' },
    { emoji: '🔄', skill: 'Adaptabilité',
      desc: 'Le retail évolue vite : click & collect, digitalisation, nouvelles habitudes d\'achat. Montre que tu es curieux des nouvelles pratiques et que tu t\'appropries rapidement les outils et les changements d\'organisation.',
      conseil: '💬 À dire : "Quand l\'enseigne a lancé son application fidélité, j\'ai été le premier à me former dessus pour pouvoir en parler naturellement aux clients."' },
    { emoji: '⚡', skill: 'Dynamisme',
      desc: 'L\'énergie que tu transmets influence directement l\'expérience client et la dynamique de l\'équipe. Le recruteur veut quelqu\'un qui "tire vers le haut" — pas un profil qui arrive en retrait. Sois présent physiquement et vocalement dès le premier instant.',
      conseil: '💬 À montrer : Initie le contact, sois le premier à tendre la main, pose des questions sur l\'entreprise — l\'enthousiasme se prouve par l\'initiative.' },
    { emoji: '🤜', skill: 'Esprit d\'équipe',
      desc: 'Un bon alternant CLEM sait s\'intégrer dans une équipe déjà en place, souvent plus senior. Montre que tu es prêt à apprendre, à rendre service et à ne pas attendre que les tâches te soient distribuées.',
      conseil: '💬 À dire : "J\'arrive toujours en avance pour préparer avec l\'équipe — et quand c\'est calme, je cherche ce que je peux améliorer ou ranger sans qu\'on me le demande."' },
    { emoji: '💪', skill: 'Résilience',
      desc: 'Le commerce en alternance peut être physiquement et mentalement exigeant. Montre que tu tiens dans la durée, que tu ne te plains pas et que tu cherches des solutions plutôt que des excuses.',
      conseil: '💬 À dire : "J\'ai assuré des journées de 10h en période de Noël — c\'est exigeant mais j\'ai compris que c\'est dans ces moments qu\'on construit vraiment son expérience."' },
    { emoji: '🧭', skill: 'Autonomie progressive',
      desc: 'Le recruteur cherche quelqu\'un qui pose les bonnes questions au début, mais qui ne revient pas systématiquement vers son tuteur pour chaque décision. Montre que tu prends des initiatives dans ton périmètre de responsabilité.',
      conseil: '💬 À dire : "Au bout de 3 semaines, je gérais seul l\'ouverture de caisse et la mise en rayon — je signalais les anomalies mais je n\'attendais pas qu\'on me dise quoi faire."' },
  ],
  'COMMERCE CLEM': [
    { emoji: '🤝', skill: 'Sens du client & authenticité',
      desc: 'CLEM valorise un commerce humain et authentique. Montre que tu n\'es pas dans le "script" mais dans la relation réelle — tu t\'intéresses sincèrement à la personne en face. Le recruteur détecte immédiatement la façade.',
      conseil: '💬 À dire : "Je ne mémorise pas de phrases types — je m\'adapte à la personne que j\'ai en face, parce que chaque client est différent."' },
    { emoji: '💡', skill: 'Curiosité & veille active',
      desc: 'CLEM forme des profils qui aiment comprendre le marché, pas juste vendre. Montre que tu te tiens informé : nouveaux produits, tendances, concurrence. Un alternant qui peut parler du marché a une longueur d\'avance.',
      conseil: '💬 À dire : "Je suis les actus du secteur chaque semaine — ça m\'a permis de conseiller un client sur une innovation qu\'il ne connaissait pas encore."' },
    { emoji: '🎤', skill: 'Persuasion & argumentation',
      desc: 'Convaincre sans forcer est un art. Appuie-toi sur les besoins réels que tu as identifiés pour construire ton argument. Montre que tu sais répondre aux objections sans rentrer dans un rapport de force.',
      conseil: '💬 À dire : "Face à une objection prix, je reviens toujours sur la valeur et le bénéfice concret pour le client — pas sur une promotion."' },
    { emoji: '😊', skill: 'Empathie commerciale',
      desc: 'L\'empathie en commerce, c\'est comprendre l\'émotion derrière l\'achat. Un client qui hésite souvent a une raison cachée (budget, peur, mauvaise expérience passée). Montre que tu sais lire ces signaux et y répondre avec justesse.',
      conseil: '💬 À dire : "Un client qui revenait sans acheter avait en fait peur de faire le mauvais choix — j\'ai reformulé ses critères avec lui et on a trouvé ensemble la bonne option."' },
    { emoji: '🚀', skill: 'Proactivité',
      desc: 'Ne pas attendre qu\'on te dise quoi faire est une qualité rare et très appréciée. Propose des idées, signale les améliorations possibles, anticipe les besoins de ton tuteur. CLEM valorise l\'initiative.',
      conseil: '💬 À dire : "J\'ai proposé à mon tuteur une réorganisation du rayon — après validation, ça a augmenté la visibilité d\'une gamme et les ventes ont suivi."' },
    { emoji: '🗂️', skill: 'Organisation & multi-tâches',
      desc: 'En commerce, tu jongleras entre encaissements, mise en rayon, conseil client et gestion des stocks. Montre que tu sais prioriser sans paniquer quand tout arrive en même temps — et donne un exemple concret.',
      conseil: '💬 À dire : "Je me fais mentalement une liste de priorités en début de journée — ça me permet de rester efficace même quand les imprévus s\'accumulent."' },
    { emoji: '🔄', skill: 'Adaptabilité digitale',
      desc: 'CLEM forme à un commerce moderne et digital. Montre que les outils numériques, les réseaux sociaux et les plateformes e-commerce ne te font pas peur — et que tu peux même être force de proposition sur ces sujets.',
      conseil: '💬 À dire : "Je suis à l\'aise sur les outils digitaux — j\'ai contribué à alimenter la page Instagram de mon ancien employeur avec des publications régulières."' },
    { emoji: '🏆', skill: 'Goût du challenge',
      desc: 'Les meilleurs alternants CLEM se fixent leurs propres objectifs sans attendre qu\'on les leur donne. Montre que tu te surpasses naturellement et que les périodes d\'intense activité sont des opportunités pour toi.',
      conseil: '💬 À dire : "En période de soldes, je me suis fixé un objectif personnel de +15% vs la semaine précédente — je l\'ai atteint en ciblant mieux les familles de produits."' },
  ],
  'IMMOBILIER': [
    { emoji: '💪', skill: 'Persévérance',
      desc: 'En immobilier, un dossier peut prendre 3 à 6 mois. Le recruteur cherche quelqu\'un qui ne lâche pas malgré les silences, les refus et les dossiers qui tombent à l\'eau. Montre un exemple où tu as tenu dans la durée malgré l\'adversité.',
      conseil: '💬 À dire : "J\'ai relancé un prospect 6 fois sur 2 mois — au 7ème appel, il était prêt à visiter. C\'est ça la persévérance appliquée."' },
    { emoji: '👂', skill: 'Écoute du projet de vie',
      desc: 'En immobilier, le client n\'achète pas un m² mais un projet de vie. Montre que tu sais aller au-delà des critères (surface, prix, quartier) pour comprendre ce que ce logement représente vraiment pour lui.',
      conseil: '💬 À dire : "Avant de proposer un bien, je pose toujours 3-4 questions sur leur quotidien — école des enfants, télétravail, proches famille — ça change tout dans la sélection."' },
    { emoji: '🤝', skill: 'Sens de la négociation',
      desc: 'Négocier ce n\'est pas forcer — c\'est créer les conditions du compromis. Montre que tu prépares tes arguments, que tu connais la valeur du bien et que tu sais quand reculer pour avancer.',
      conseil: '💬 À dire : "Je prépare chaque négociation avec les prix du marché local — ça me donne des arguments solides et ça rassure le vendeur comme l\'acquéreur."' },
    { emoji: '🧭', skill: 'Autonomie terrain',
      desc: 'Un agent immobilier gère souvent son agenda en totale autonomie. Montre que tu sais t\'organiser, prioriser tes visites, suivre ton pipeline et rendre compte à ton tuteur sans qu\'il ait à te relancer.',
      conseil: '💬 À dire : "J\'utilisais un tableau de suivi personnel pour mes mandats — je savais en permanence où en était chaque dossier et j\'anticipais les relances."' },
    { emoji: '📅', skill: 'Organisation rigoureuse',
      desc: 'Jongler entre mandats, visites, compromis, diagnostics et clients demande une organisation irréprochable. Montre que tu as un système — agenda détaillé, notes structurées, relances programmées.',
      conseil: '💬 À dire : "Chaque soir je mets à jour mon agenda du lendemain et je note les actions en attente pour chaque dossier — je n\'oublie jamais une relance."' },
    { emoji: '🔒', skill: 'Discrétion professionnelle',
      desc: 'Tu accèdes à des informations très personnelles : situation familiale, financière, professionnelle. Montre que tu comprends l\'importance de cette confidentialité et que tu ne la prends pas à la légère.',
      conseil: '💬 À dire : "Je ne parle jamais d\'un dossier client en dehors de l\'agence — même avec des proches. C\'est une question de respect et d\'éthique professionnelle."' },
    { emoji: '🌟', skill: 'Charisme & confiance',
      desc: 'Un client vous confie l\'une des décisions les plus importantes de sa vie. Il doit vous faire confiance dès la première rencontre. Travaille ta présentation, ta poignée de main, ton regard — tout compte.',
      conseil: '💬 À montrer : Sois le premier à sourire, tiens-toi droit, regarde dans les yeux. La confiance se dégage physiquement avant même de parler.' },
    { emoji: '📊', skill: 'Rigueur documentaire',
      desc: 'Un compromis mal rédigé peut bloquer une vente pendant des mois. Montre que tu accordes autant d\'importance aux détails administratifs qu\'à la relation client — les deux sont indissociables.',
      conseil: '💬 À dire : "Je relis chaque document deux fois avant de le faire signer — une erreur dans un mandat peut bloquer un dossier des semaines."' },
  ],
  'BANQUE': [
    { emoji: '📐', skill: 'Rigueur absolue',
      desc: 'En banque, une erreur de saisie peut avoir des conséquences financières et légales importantes. Le recruteur cherche quelqu\'un qui vérifie deux fois plutôt qu\'une, qui ne signe jamais sans avoir compris. Montre ta méthodologie de contrôle.',
      conseil: '💬 À dire : "Avant de valider n\'importe quelle opération, j\'applique systématiquement une double vérification — les chiffres bancaires ne pardonnent pas les approximations."' },
    { emoji: '🔒', skill: 'Discrétion & confidentialité',
      desc: 'Le secret bancaire est une obligation légale et éthique fondamentale. Montre que tu as compris pourquoi cette discrétion existe et que tu l\'appliquerais même dans des situations informelles (repas, discussions entre collègues).',
      conseil: '💬 À dire : "Je n\'évoque jamais une situation client, même de façon anonyme, hors du contexte professionnel — la confidentialité est non-négociable pour moi."' },
    { emoji: '🤝', skill: 'Relation de confiance long terme',
      desc: 'La banque ne vend pas un produit ponctuel — elle accompagne un client sur 10, 20, 30 ans. Montre que tu penses "relation durable" et pas "vente immédiate". Le meilleur conseil parfois c\'est de ne rien vendre.',
      conseil: '💬 À dire : "Pour moi, le bon conseil prime sur la vente — un client bien conseillé reste et revient, un client mal conseillé part et en parle."' },
    { emoji: '🧠', skill: 'Analyse & lucidité',
      desc: 'Évaluer un risque, comprendre une situation financière, détecter une incohérence dans un dossier — ces capacités se démontrent par des exemples où tu as su prendre du recul et analyser avant d\'agir.',
      conseil: '💬 À dire : "Face à un dossier complexe, je prends le temps de lister les risques avant de me positionner — c\'est plus long mais ça évite les erreurs coûteuses."' },
    { emoji: '😌', skill: 'Sang-froid & gestion des émotions',
      desc: 'Des clients en difficulté financière ou en colère après un refus de crédit — ça arrive souvent. Montre que tu restes calme, empathique et professionnel quelles que soient les émotions de l\'interlocuteur.',
      conseil: '💬 À dire : "Face à un client très agité, je baisse naturellement ma voix et je ralentis mon débit — ça crée un espace de calme qui désamorce souvent la tension."' },
    { emoji: '📋', skill: 'Sens du détail',
      desc: 'Un champ manquant dans un formulaire KYC, une pièce justificative incomplète peuvent bloquer un dossier pendant des semaines. Montre que tu lis les documents en entier et que tu anticipes les pièces manquantes.',
      conseil: '💬 À dire : "Je checke chaque dossier avec une liste de contrôle — ça peut sembler fastidieux mais ça évite les allers-retours inutiles avec le client."' },
    { emoji: '👂', skill: 'Écoute du projet de vie',
      desc: 'Derrière chaque produit bancaire il y a un projet de vie : maison, retraite, études des enfants. Montre que tu sais poser les bonnes questions pour identifier le bon produit — pas le plus rentable, le plus adapté.',
      conseil: '💬 À dire : "Avant de proposer un placement, je pose des questions sur l\'horizon de temps, la tolérance au risque et les projets à 5-10 ans — le produit découle naturellement de là."' },
    { emoji: '⏰', skill: 'Respect des engagements',
      desc: 'Rappeler un client à l\'heure dite, rendre un dossier à la date promise, répondre aux mails dans les délais — ces petits gestes construisent la confiance dans la durée. Montre que tu tiens toujours tes promesses.',
      conseil: '💬 À dire : "Si je dis que je rappelle à 14h, je rappelle à 14h — même si je n\'ai pas encore toutes les réponses. Je préfère appeler pour dire où j\'en suis plutôt que de faire attendre."' },
  ],
  'MARKETING': [
    { emoji: '🎨', skill: 'Créativité opérationnelle',
      desc: 'La créativité en marketing n\'est pas juste "avoir des idées" — c\'est produire des idées RÉALISABLES avec les moyens disponibles. Montre que tes idées tiennent compte du budget, du planning et de la cible.',
      conseil: '💬 À dire : "J\'ai proposé une campagne sur les réseaux avec zéro budget — on a utilisé les clients existants comme ambassadeurs et ça a généré 300 partages organiques."' },
    { emoji: '💡', skill: 'Curiosité & veille permanente',
      desc: 'Un bon marketeur est toujours au courant : nouvelles tendances, campagnes concurrentes, comportements consommateurs. Montre que tu pratiques une veille régulière et que tu peux citer des exemples récents qui t\'ont inspiré.',
      conseil: '💬 À dire : "J\'ai une routine de veille chaque matin — je suis 5 newsletters spécialisées et je note ce qui m\'inspire dans un carnet d\'idées que je consulte régulièrement."' },
    { emoji: '🔍', skill: 'Esprit critique & data',
      desc: 'En marketing, les chiffres racontent une histoire — mais il faut savoir la lire sans biais. Montre que tu sais questionner les résultats, distinguer ce qui fonctionne vraiment de ce qui semble fonctionner.',
      conseil: '💬 À dire : "Un post avait 1000 likes mais zéro conversion — j\'ai proposé de changer le CTA plutôt que de continuer le même format, et les ventes ont suivi."' },
    { emoji: '🔄', skill: 'Adaptabilité & test & learn',
      desc: 'En marketing digital, rien n\'est figé — un A/B test peut tout changer. Montre que tu es à l\'aise avec l\'idée de tester, mesurer, ajuster sans ego sur les résultats.',
      conseil: '💬 À dire : "Je lance toujours une version A et B de mes emails — je ne me fie pas à mon instinct mais aux résultats pour décider de ce qu\'on généralise."' },
    { emoji: '🤜', skill: 'Collaboration inter-équipes',
      desc: 'Le marketing travaille avec les commerciaux, les designers, les développeurs, les directions. Montre que tu sais communiquer avec des profils très différents et que tu t\'adaptes à chaque interlocuteur.',
      conseil: '💬 À dire : "J\'ai co-construit un brief créatif avec l\'équipe design et les commerciaux — en les impliquant dès le début, le résultat était beaucoup plus cohérent et accepté."' },
    { emoji: '📝', skill: 'Sens de la synthèse',
      desc: 'Transformer des données complexes en un message clair, un brief précis ou une présentation percutante — c\'est une compétence rare. Montre que tu sais aller à l\'essentiel sans sacrifier la substance.',
      conseil: '💬 À dire : "Pour mon rapport de stage, j\'ai condensé 3 mois d\'analyse en 5 slides actionnables — mon tuteur me disait souvent que je savais aller à l\'essentiel."' },
    { emoji: '🚀', skill: 'Proactivité & ownership',
      desc: 'Les meilleurs profils marketing prennent possession de leur sujet — ils n\'attendent pas qu\'on leur demande, ils proposent, anticipent, livrent. Montre que tu es du genre à "faire" plutôt qu\'à "attendre".',
      conseil: '💬 À dire : "Sans qu\'on me le demande, j\'ai créé un tableau de bord mensuel des KPIs de la page — mon tuteur me l\'a demandé officiellement 2 semaines après."' },
    { emoji: '📊', skill: 'Maîtrise des KPIs',
      desc: 'Savoir quels indicateurs regarder (taux de conversion, CPC, reach, engagement, ROI) et pourquoi est indispensable. Montre que tu n\'es pas juste créatif mais que tu mesures l\'impact de chaque action.',
      conseil: '💬 À dire : "Chaque action que je lance, je définis d\'abord le KPI de succès — sans indicateur précis, impossible de savoir si on a réussi ou pas."' },
  ],
  'RH': [
    { emoji: '😊', skill: 'Empathie professionnelle',
      desc: 'L\'empathie RH ne signifie pas être ami avec tout le monde — c\'est comprendre la situation d\'un collaborateur sans perdre le recul nécessaire pour agir objectivement. Montre que tu sais équilibrer les deux.',
      conseil: '💬 À dire : "Je comprends les difficultés personnelles sans les confondre avec les règles professionnelles — l\'empathie ne remplace pas le cadre, elle aide à le faire accepter."' },
    { emoji: '🕊️', skill: 'Diplomatie & médiation',
      desc: 'En RH tu seras parfois entre le marteau (direction) et l\'enclume (salarié). Montre que tu sais porter les deux messages avec neutralité et que tu cherches le compromis plutôt que de choisir un camp.',
      conseil: '💬 À dire : "Quand j\'ai un désaccord à gérer, je commence toujours par écouter les deux parties séparément avant de réunir — ça évite les confrontations improductives."' },
    { emoji: '📅', skill: 'Organisation & fiabilité',
      desc: 'Un entretien raté, un contrat en retard, une convocation oubliée — en RH, les erreurs organisationnelles ont des conséquences humaines et légales directes. Montre ton système d\'organisation avec des exemples concrets.',
      conseil: '💬 À dire : "J\'utilise des rappels systématiques et des checklists pour chaque type de processus RH — rien ne part sans que tout soit validé étape par étape."' },
    { emoji: '🔒', skill: 'Confidentialité absolue',
      desc: 'Tu auras accès aux salaires, aux problèmes personnels, aux sanctions disciplinaires. Le recruteur veut être sûr à 100% que ces informations ne sortiront jamais — même de façon anodine. C\'est une ligne rouge.',
      conseil: '💬 À dire : "Les informations RH restent dans le bureau RH. Je ne discute jamais de situations individuelles, même avec les managers directs sans autorisation."' },
    { emoji: '👂', skill: 'Écoute sans jugement',
      desc: 'Un collaborateur qui vient te voir en RH est souvent dans une situation difficile. Montre que tu sais créer un espace sécurisé, écouter sans interrompre et sans juger — avant même de penser à la solution.',
      conseil: '💬 À dire : "Quand quelqu\'un vient me parler d\'une difficulté, mes premières minutes sont entièrement dédiées à l\'écoute — je ne propose jamais de solution avant d\'avoir tout compris."' },
    { emoji: '📚', skill: 'Pédagogie & clarté',
      desc: 'Expliquer le droit du travail, les procédures internes ou les avantages sociaux à des profils non-RH exige une vraie capacité de vulgarisation. Montre que tu sais traduire le jargon en langage accessible.',
      conseil: '💬 À dire : "Pour expliquer le fonctionnement de la mutuelle aux nouveaux entrants, j\'ai créé une fiche visuelle en une page — les questions ont baissé de 80%."' },
    { emoji: '⚖️', skill: 'Équité & non-discrimination',
      desc: 'Chaque décision RH (recrutement, promotion, sanction) doit être justifiable de manière objective et équitable. Montre que tu comprends les enjeux de diversité et que tu appliques des critères factuels.',
      conseil: '💬 À dire : "En recrutement, j\'utilise une grille de critères identique pour tous les candidats — ça protège du biais inconscient et ça sécurise la décision."' },
    { emoji: '🔄', skill: 'Adaptabilité réglementaire',
      desc: 'Le droit du travail et les conventions collectives évoluent régulièrement. Montre que tu te tiens informé et que tu mets à jour tes pratiques sans attendre qu\'on te le demande.',
      conseil: '💬 À dire : "Je suis des newsletters RH et juridiques pour rester à jour — je préfère anticiper une évolution réglementaire que la découvrir lors d\'un contrôle."' },
  ],
  'SOCIAL': [
    { emoji: '❤️', skill: 'Empathie profonde',
      desc: 'Dans le travail social, l\'empathie n\'est pas un sentiment mais une posture professionnelle. Tu dois comprendre sans absorber, être touché sans être submergé. Montre que tu sais mettre des limites saines tout en restant pleinement humain.',
      conseil: '💬 À dire : "Je m\'implique pleinement pendant l\'accompagnement, mais j\'ai appris à déconnecter en sortant — sinon on ne peut pas durer dans ce métier."' },
    { emoji: '🕐', skill: 'Patience & respect du rythme',
      desc: 'Certaines personnes accompagnées avancent très lentement — et c\'est normal. Montre que tu acceptes ce rythme sans frustration et que tu célèbres les petits progrès autant que les grands.',
      conseil: '💬 À dire : "Un progrès de 10% c\'est déjà immense pour certaines personnes — je mesure le chemin parcouru, pas l\'écart qui reste."' },
    { emoji: '👂', skill: 'Écoute thérapeutique',
      desc: 'Savoir écouter sans interrompre, sans compléter les phrases, sans projeter — c\'est un art. Montre que tu pratiques une écoute qui laisse vraiment de l\'espace à l\'autre pour s\'exprimer pleinement.',
      conseil: '💬 À dire : "J\'ai appris à supporter le silence dans une conversation — parfois la personne a besoin d\'un espace pour formuler ce qu\'elle ressent, et l\'interruption coupe ce processus."' },
    { emoji: '🌱', skill: 'Bienveillance sans naïveté',
      desc: 'La bienveillance ne signifie pas tout accepter. Montre que tu sais poser un cadre bienveillant mais ferme — et que tu ne te laisses pas manipuler par les personnes accompagnées même avec les meilleures intentions.',
      conseil: '💬 À dire : "Je suis bienveillant mais pas sans limites — le cadre protège autant la personne accompagnée que moi-même."' },
    { emoji: '💪', skill: 'Résistance au stress',
      desc: 'Situations de crise, urgences, violences verbales, situations de détresse — le travail social expose à des moments difficiles. Montre que tu as développé des ressources personnelles pour tenir dans la durée.',
      conseil: '💬 À dire : "J\'ai intégré des routines de décompression après les journées difficiles — sport, parler à un pair de confiance — ça fait partie du professionnalisme dans ce métier."' },
    { emoji: '🔒', skill: 'Secret professionnel',
      desc: 'Les situations des personnes accompagnées sont souvent très intimes. Montre que tu comprends les limites du secret professionnel (et les exceptions légales) et que tu ne le briserais jamais par inadvertance.',
      conseil: '💬 À dire : "Je ne parle d\'une situation individuelle qu\'en réunion d\'équipe encadrée — et uniquement si c\'est utile à l\'accompagnement."' },
    { emoji: '🔥', skill: 'Engagement & vocation',
      desc: 'Ce métier est exigeant et peu rémunérateur — le recruteur cherche quelqu\'un qui a une vraie conviction, pas juste un emploi. Montre ce qui t\'a amené vers le travail social avec une histoire personnelle authentique.',
      conseil: '💬 À dire : "Je ne suis pas entré dans ce domaine par hasard — [raconte une expérience fondatrice]. C\'est ça qui me donne l\'énergie même dans les moments difficiles."' },
    { emoji: '🤝', skill: 'Travail en réseau partenarial',
      desc: 'Le travail social se fait rarement seul — tu collabores avec des assistantes sociales, des médecins, des éducateurs, des associations. Montre que tu comprends comment fonctionnent ces réseaux et que tu sais y naviguer.',
      conseil: '💬 À dire : "J\'ai appris à identifier rapidement quel partenaire contacter selon la situation — c\'est en connaissant le réseau qu\'on peut vraiment aider."' },
  ],
  'AUTRE': [
    { emoji: '🔄', skill: 'Adaptabilité',
      desc: 'Chaque nouveau poste, nouvelle équipe, nouvel outil est un test d\'adaptabilité. Montre que tu intègres vite les codes d\'une structure, que tu poses les bonnes questions et que tu ne restes pas bloqué face à l\'inconnu.',
      conseil: '💬 À dire : "Dans mes expériences passées, j\'ai toujours cherché à être opérationnel rapidement — je cartographie les priorités et je pose les questions utiles dès le premier jour."' },
    { emoji: '📐', skill: 'Rigueur & fiabilité',
      desc: 'Être rigoureux c\'est pouvoir être compté dessus sans surveillance. Montre que tu respectes les délais, que tu vérifies ton travail avant de le rendre et que tu signales les problèmes dès qu\'ils apparaissent.',
      conseil: '💬 À dire : "Je ne rends jamais un travail sans l\'avoir relu — et si je vois que je vais être en retard, je le signale en avance plutôt qu\'après."' },
    { emoji: '🤜', skill: 'Esprit d\'équipe',
      desc: 'La collaboration n\'est pas juste être sympa — c\'est contribuer activement, partager l\'information et aider quand quelqu\'un est en difficulté. Montre un exemple concret où ton aide a changé quelque chose pour l\'équipe.',
      conseil: '💬 À dire : "Je partage systématiquement ce que j\'apprends — si j\'ai trouvé une astuce ou une méthode qui m\'a aidé, je la transmets à l\'équipe sans attendre qu\'on me le demande."' },
    { emoji: '💬', skill: 'Communication claire',
      desc: 'Savoir s\'exprimer clairement à l\'écrit comme à l\'oral, adapter son niveau de langage, structurer son message — ces compétences font la différence à tous les niveaux. Montre que tu as conscience de l\'impact de ta communication.',
      conseil: '💬 À dire : "Avant d\'envoyer un email important, je me relis en me mettant à la place du destinataire — est-ce que c\'est clair pour quelqu\'un qui n\'a pas mon contexte ?"' },
    { emoji: '🧭', skill: 'Autonomie',
      desc: 'L\'autonomie ce n\'est pas l\'isolement — c\'est savoir avancer seul tout en sachant quand demander de l\'aide. Montre que tu gères tes missions de façon proactive sans avoir besoin d\'être micro-managé.',
      conseil: '💬 À dire : "Je pose mes questions en lot plutôt qu\'au fil de l\'eau — ça respecte le temps de mon tuteur et ça me force à essayer de trouver la réponse par moi-même d\'abord."' },
    { emoji: '⚡', skill: 'Dynamisme & motivation',
      desc: 'L\'énergie que tu apportes influence le reste de l\'équipe. Montre que tu arrives avec l\'envie d\'apprendre, que tu ne te contentes pas du minimum et que tu t\'impliques au-delà de ta fiche de poste.',
      conseil: '💬 À montrer : Pose des questions sur l\'entreprise, montre de la curiosité pour les projets en cours. L\'enthousiasme authentique se perçoit immédiatement.' },
    { emoji: '🚀', skill: 'Proactivité',
      desc: 'Ne pas attendre que les choses se passent mais contribuer à ce qu\'elles se passent — c\'est ça la proactivité. Cherche un exemple où tu as pris une initiative qui a eu un impact positif.',
      conseil: '💬 À dire : "Sans qu\'on me le demande, j\'ai identifié un process qui faisait perdre du temps à l\'équipe et j\'ai proposé une amélioration simple — elle a été adoptée."' },
    { emoji: '🎯', skill: 'Orientation résultats',
      desc: 'Comprendre quel est l\'objectif final de chaque tâche et s\'assurer que son travail y contribue — c\'est ce qui distingue un alternant qui exécute d\'un alternant qui comprend. Montre que tu travailles avec l\'objectif en tête.',
      conseil: '💬 À dire : "Avant de commencer une tâche, je me demande toujours à quel résultat elle contribue — ça m\'évite de travailler dans le vide."' },
  ],
};

// ===== MAPPING VALEURS ENTREPRISE → SOFT SKILLS SPÉCIFIQUES =====
const VALEURS_SOFT_SKILLS = {
  'artisanat':      { emoji: '🎯', skill: 'Soin du travail bien fait',
    desc: 'Cette entreprise attend une attention particulière à la qualité d\'exécution. Ne bâclez aucun détail et montrez que vous prenez le temps de faire les choses bien, même sous pression. Valorisez une expérience où votre soin du détail a fait une vraie différence.',
    conseil: '💬 À dire : "Je préfère prendre 10 minutes de plus pour faire quelque chose correctement plutôt que de livrer un travail approximatif — la qualité est une habitude, pas une option."' },
  'fraîcheur':      { emoji: '✅', skill: 'Exigence qualité & fraîcheur',
    desc: 'L\'entreprise mise sur la qualité constante de ses produits/services. Montrez que vous êtes attentif aux standards et que vous n\'hésitez pas à signaler un écart de qualité même si ça demande plus d\'efforts.',
    conseil: '💬 À dire : "Je ne valide jamais quelque chose qui ne répond pas aux standards attendus — même si ça demande de tout recommencer, l\'image de l\'entreprise vaut ce soin."' },
  'générosité':     { emoji: '💝', skill: 'Générosité relationnelle',
    desc: 'Cette enseigne valorise une relation client chaleureuse et généreuse, pas un service minimum. Montrez que vous donnez plus que ce qu\'on attend de vous — un sourire, un conseil supplémentaire, une attention particulière.',
    conseil: '💬 À dire : "J\'essaie toujours d\'aller un cran au-delà de ce que le client demande — pas de façon intrusive, mais en lui proposant une information ou un service qu\'il n\'avait pas envisagé."' },
  'proximité':      { emoji: '🏘️', skill: 'Ancrage local & proximité',
    desc: 'Cette entreprise se distingue par un lien fort avec sa clientèle locale. Montrez que vous comprenez l\'importance de ce lien, que vous êtes capable de reconnaître les habitués et d\'adapter votre relation à chacun.',
    conseil: '💬 À dire : "Je mémorise naturellement les préférences de mes clients réguliers — ce petit geste crée une relation de fidélité qui vaut bien plus qu\'une carte de fidélité."' },
  'innovation':     { emoji: '💡', skill: 'Esprit d\'innovation',
    desc: 'Cette entreprise cherche des profils qui remettent en question les façons de faire et proposent des améliorations. N\'hésitez pas à partager des idées en entretien — même imparfaites, elles montrent votre état d\'esprit.',
    conseil: '💬 À dire : "J\'ai une curiosité naturelle pour les nouvelles façons de faire — et je n\'hésite pas à proposer des améliorations, même petites, quand je vois une opportunité."' },
  'passion':        { emoji: '🔥', skill: 'Passion & engagement',
    desc: 'Cette enseigne recrute des gens qui aiment vraiment leur métier. Soyez authentique sur ce qui vous motive — l\'enthousiasme vrai ne se feint pas et le recruteur le détecte immédiatement.',
    conseil: '💬 À dire : "Ce qui me motive vraiment dans ce secteur c\'est [soyez précis et sincère] — cette passion me donne l\'énergie de progresser même dans les moments difficiles."' },
  'expertise':      { emoji: '🎓', skill: 'Développement continu de l\'expertise',
    desc: 'Cette entreprise valorise la montée en compétences permanente. Montrez que vous lisez, vous formez et cherchez à comprendre en profondeur, pas juste à faire le job. Citez des formations ou lectures récentes.',
    conseil: '💬 À dire : "J\'ai suivi [une formation, un webinaire, lu un livre] sur [sujet] récemment — je cherche toujours à approfondir ma compréhension au-delà de ce qu\'on me demande."' },
  'service':        { emoji: '🌟', skill: 'Culture du service d\'excellence',
    desc: 'Le service est l\'ADN de cette entreprise. Montrez que vous avez une conception haute du service : anticiper, prévenir les problèmes, faire le petit extra qui transforme une transaction en expérience mémorable.',
    conseil: '💬 À dire : "Pour moi un bon service c\'est quand le client repart en se disant que c\'était encore mieux qu\'il ne l\'espérait — j\'essaie d\'atteindre ça à chaque interaction."' },
  'partage':        { emoji: '🤝', skill: 'Esprit de partage & transmission',
    desc: 'Cette entreprise valorise le partage des savoirs entre collègues. Montrez que vous aimez transmettre ce que vous apprenez et que vous n\'êtes pas dans une logique de rétention d\'information.',
    conseil: '💬 À dire : "Quand j\'apprends quelque chose d\'utile, mon réflexe c\'est de le partager avec l\'équipe — l\'intelligence collective est toujours plus forte que l\'intelligence individuelle."' },
  'intégrité':      { emoji: '⚖️', skill: 'Intégrité & éthique',
    desc: 'Cette entreprise ne tolère pas les comportements contraires à l\'éthique, même pour atteindre un objectif. Montrez que vous avez des principes clairs et que vous ne les sacrifiez pas sous pression.',
    conseil: '💬 À dire : "Je préfère perdre une vente que de mal conseiller un client — une décision non-éthique peut coûter bien plus cher qu\'un objectif raté."' },
  'responsabilité': { emoji: '🛡️', skill: 'Sens des responsabilités',
    desc: 'Cette entreprise cherche des alternants qui prennent possession de leurs missions et ne cherchent pas d\'excuses en cas d\'erreur. Montrez que vous assumez, apprenez et corrigez — c\'est plus valorisant que la perfection.',
    conseil: '💬 À dire : "Quand je fais une erreur, ma priorité c\'est de le signaler, de corriger et de comprendre pourquoi — pas de chercher à qui en rendre responsable."' },
  'respect':        { emoji: '🌍', skill: 'Respect & inclusion',
    desc: 'Cette entreprise travaille avec des équipes et des clientèles diverses. Montrez que vous êtes à l\'aise avec la diversité, que vous traitez tout le monde avec le même respect et que vous signalez les comportements contraires à ce principe.',
    conseil: '💬 À dire : "Pour moi le respect c\'est la base de toute relation professionnelle — avec les clients, les collègues et les fournisseurs, sans exception."' },
  'engagement':     { emoji: '🔥', skill: 'Engagement & implication',
    desc: 'Cette entreprise cherche des profils qui vont au bout de leurs missions même quand c\'est difficile. Montrez que vous ne comptez pas vos heures pour finir un projet correctement et que vous vous investissez pleinement.',
    conseil: '💬 À dire : "Quand je prends un engagement, je le tiens — si je vois que je risque de ne pas y arriver, je le signale en avance et je propose un plan B."' },
  'performance':    { emoji: '📈', skill: 'Culture de la performance',
    desc: 'Cette entreprise mesure et valorise les résultats. Montrez que vous aimez vous fixer des objectifs, que vous mesurez vos progrès et que vous vous challengez en permanence pour vous améliorer.',
    conseil: '💬 À dire : "Je me fixe des objectifs personnels en plus de ceux qu\'on me donne — j\'ai besoin de me challenger pour rester motivé et progresser."' },
  'créativité':     { emoji: '🎨', skill: 'Créativité & originalité',
    desc: 'Cette entreprise valorise les idées nouvelles et les approches différentes. N\'ayez pas peur de sortir des sentiers battus en entretien — proposez une idée, partagez une façon inédite d\'aborder un problème.',
    conseil: '💬 À dire : "Ma plus grande force c\'est de voir les choses différemment — [exemple d\'une idée originale que vous avez eue et son impact]."' },
  'confiance':      { emoji: '🤲', skill: 'Fiabilité & création de confiance',
    desc: 'La confiance se bâtit dans les petites choses du quotidien. Montrez que vous êtes quelqu\'un sur qui on peut compter, qui dit ce qu\'il fait et fait ce qu\'il dit, sans avoir besoin d\'être surveillé.',
    conseil: '💬 À dire : "La confiance se gagne dans les détails — je préfère promettre moins et livrer plus que l\'inverse."' },
  'bienveillance':  { emoji: '🌱', skill: 'Bienveillance active',
    desc: 'La bienveillance n\'est pas juste une attitude passive — c\'est agir positivement pour les autres. Montrez que vous prenez soin de vos collègues, que vous créez une ambiance positive et que vous cherchez à aider sans qu\'on vous le demande.',
    conseil: '💬 À dire : "Je fais attention à comment vont mes collègues — si je vois quelqu\'un en difficulté, je propose mon aide même si ce n\'est pas dans ma mission."' },
  'qualité':        { emoji: '✨', skill: 'Exigence qualitative',
    desc: 'Cette entreprise a des standards élevés et attend que ses collaborateurs les partagent. Montrez que vous avez vous-même une haute exigence dans votre travail et que la médiocrité ne vous satisfait jamais.',
    conseil: '💬 À dire : "Je me donne un standard personnel plus élevé que ce qu\'on attend de moi — quand je rends un travail, je dois en être fier."' },
  'éthique':        { emoji: '⚖️', skill: 'Sens éthique',
    desc: 'L\'éthique professionnelle guide chaque décision dans cette entreprise. Montrez que vous avez déjà réfléchi à vos valeurs et que vous savez agir avec intégrité même quand c\'est inconfortable.',
    conseil: '💬 À dire : "J\'ai déjà refusé de faire quelque chose que je trouvais contraire à l\'éthique — ce n\'est pas toujours facile, mais c\'est ce qui construit la confiance sur le long terme."' },
  'solidarité':     { emoji: '🤜', skill: 'Solidarité d\'équipe',
    desc: 'Cette entreprise valorise l\'entraide et la cohésion collective. Montrez que vous aidez sans calculer, que vous partagez les succès collectivement et que vous ne laissez pas un collègue en difficulté.',
    conseil: '💬 À dire : "Je suis aussi fier des réussites de mes collègues que des miennes — une bonne équipe avance ensemble, pas en compétition."' },
  'autonomie':      { emoji: '🧭', skill: 'Autonomie & initiative',
    desc: 'Cette entreprise donne de l\'autonomie et attend en retour que vous l\'exerciez. Montrez que vous prenez des décisions dans votre périmètre sans avoir besoin d\'une validation à chaque étape.',
    conseil: '💬 À dire : "Dans mon périmètre de responsabilité, je prends mes décisions — je consulte pour les sujets qui dépassent mon niveau, pas pour ceux que je maîtrise."' },
  'ambition':       { emoji: '🚀', skill: 'Ambition & envie de progresser',
    desc: 'Cette entreprise cherche des profils avec de l\'appétit pour progresser. Montrez où vous voulez aller professionnellement et comment ce poste s\'inscrit dans votre projet — sans paraître calculateur.',
    conseil: '💬 À dire : "Dans 3 ans, je me vois [objectif réaliste et cohérent] — ce poste en alternance est la première étape concrète vers cet objectif."' },
  'agilité':        { emoji: '⚡', skill: 'Agilité & flexibilité',
    desc: 'Cette entreprise évolue vite et attend des collaborateurs qui suivent le rythme. Montrez que le changement vous stimule plutôt qu\'il ne vous perturbe et que vous savez changer de priorité sans perdre en efficacité.',
    conseil: '💬 À dire : "J\'aime quand les missions évoluent — ça m\'oblige à apprendre et à me dépasser plutôt que de rester dans une routine."' },
  'audace':         { emoji: '🦁', skill: 'Audace & prise d\'initiative',
    desc: 'Cette entreprise valorise ceux qui osent — proposer une idée non-conventionnelle, tenter une nouvelle approche, dire ce que les autres pensent sans le dire. Montrez que vous êtes prêt à prendre des risques calculés.',
    conseil: '💬 À dire : "J\'ai proposé une idée qui sortait des habitudes — certains étaient sceptiques, mais j\'ai défendu ma position avec des arguments et au final ça a fonctionné."' },
  'transparence':   { emoji: '🔍', skill: 'Transparence & honnêteté',
    desc: 'Cette entreprise valorise la communication directe et honnête. Montrez que vous dites ce que vous pensez avec tact, que vous annoncez les mauvaises nouvelles en avance et que vous ne "positionnez" pas la réalité.',
    conseil: '💬 À dire : "Je préfère dire franchement que je ne sais pas plutôt que d\'improviser une réponse — l\'honnêteté construit plus de confiance que la façade."' },
};

function getSoftSkillsForCompany(company) {
  // 1. Skills par filière
  const filiere = (company.filiere || 'AUTRE').toUpperCase();
  let sectorSkills = SOFT_SKILLS_DB[filiere];
  if (!sectorSkills) {
    const key = Object.keys(SOFT_SKILLS_DB).find(k => filiere.includes(k) || k.includes(filiere.split(' ')[0]));
    sectorSkills = SOFT_SKILLS_DB[key] || SOFT_SKILLS_DB['AUTRE'];
  }

  // 2. Skills issues des valeurs de l'enseigne
  const valeurs = company.valeurs || [];
  const enseigneSkills = [];
  const usedSkills = new Set(sectorSkills.map(s => s.skill));
  for (const v of valeurs) {
    const key = Object.keys(VALEURS_SOFT_SKILLS).find(k => v.toLowerCase().includes(k) || k.includes(v.toLowerCase().split(' ')[0]));
    if (key) {
      const ss = VALEURS_SOFT_SKILLS[key];
      if (!usedSkills.has(ss.skill)) {
        enseigneSkills.push(ss);
        usedSkills.add(ss.skill);
      }
    }
  }

  return { sectorSkills, enseigneSkills };
}

// Rétro-compatibilité
function getSoftSkillsByFiliere(filiere, secteur) {
  return getSoftSkillsForCompany({ filiere, valeurs: [] }).sectorSkills;
}

// Toggle accordéon sur les cartes soft skills
function toggleSSCard(card) {
  const isOpen = card.classList.contains('open');
  // Ferme toutes les cartes ouvertes dans la même grille
  const grid = card.closest('.softskills-grid');
  if (grid) grid.querySelectorAll('.ss-card.open').forEach(c => c.classList.remove('open'));
  // Ouvre la carte cliquée (sauf si elle était déjà ouverte)
  if (!isOpen) card.classList.add('open');
}

function closeStudentModal() {
  const m = document.getElementById('modal-student');
  m.classList.remove('open', 'sr-mode');
  document.body.style.overflow = '';
}

function closeModalStudent(event) {
  if (event.target === document.getElementById('modal-student')) closeStudentModal();
}

// ===== CRE AUTH =====
async function verifyCRE() {
  const pin = document.getElementById('cre-pin-input').value.trim();
  const res = await fetch('/api/auth/cre', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  const data = await res.json();
  if (data.valid) {
    crePin = pin;
    creAuthenticated = true;
    sessionStorage.setItem('ss_crePin', pin);
    document.getElementById('cre-login').style.display = 'none';
    document.getElementById('cre-dashboard').style.display = 'block';
    requestAnimationFrame(updateCRETabsTop);
    await loadRegistrations();
    renderCREGrid(companies);
    updateCREStats();
    loadAutocompleteList(pin);
  } else {
    document.getElementById('cre-login-error').style.display = 'block';
  }
}

// ===== LOAD REGISTRATIONS =====
async function loadRegistrations() {
  try {
    const res = await fetch(`/api/registrations?pin=${encodeURIComponent(crePin)}`);
    registrations = await res.json();
  } catch (e) {
    registrations = {};
  }
}

// ===== CRE GRID =====
function renderCREGrid(list) {
  const grid = document.getElementById('cre-companies-grid');
  grid.innerHTML = '';
  const grouped = groupAndSort(list);
  grouped.forEach(({ filiere, color, companies: groupCompanies }) => {
    const section = document.createElement('div');
    section.className = 'filiere-section';
    section.dataset.filiere = filiere;

    const count = groupCompanies.length;
    const header = document.createElement('div');
    header.className = 'filiere-section-header';
    header.innerHTML = `
      <div class="filiere-section-dot" style="background:${color}"></div>
      <span class="filiere-section-name">${FILIERE_LABELS[filiere] || filiere}</span>
      <span class="filiere-section-count">${count} entreprise${count > 1 ? 's' : ''}</span>
    `;
    section.appendChild(header);

    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'cards-grid-wrap';

    groupCompanies.forEach(company => {
      const cardColor = FILIERE_COLORS[company.filiere] || '#94a3b8';
      const initials = getInitials(company.nomAffichage || company.nom);
      const studentCount = (registrations[company.id] || []).length;

      const card = document.createElement('div');
      card.className = 'company-card';
      card.dataset.filiere = company.filiere;
      card.dataset.name = (company.nom + ' ' + (company.nomAffichage || '')).toLowerCase();
      card.dataset.cre = (company.cre || '').toLowerCase();
      card.style.setProperty('--card-color', cardColor);
      card.onclick = () => openCREModal(company);

      card.innerHTML = `
        <div class="card-logo-area">
          ${company.logoFile
            ? `<img src="/images/logos/${company.logoFile}"
                alt="${company.nomAffichage || company.nom}"
                onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'" />
               <div class="card-logo-fallback-inner" style="display:none;background:${cardColor}">${initials}</div>`
            : `<div class="card-logo-fallback-inner" style="background:${cardColor}">${initials}</div>`
          }
        </div>
        <div class="card-info">
          <div class="card-name">${company.nomAffichage || company.nom}</div>
        </div>
        <div class="card-student-pill ${studentCount > 0 ? 'has-students' : ''}">
          ${studentCount > 0 ? studentCount + ' ✓' : '0'}
        </div>
      `;
      cardsWrap.appendChild(card);
    });

    section.appendChild(cardsWrap);
    grid.appendChild(section);
  });
}

function filterCRECompanies() {
  const search = document.getElementById('cre-search').value.toLowerCase().trim();
  const filiere = document.getElementById('cre-filiere-filter').value;
  const cards = document.querySelectorAll('#cre-companies-grid .company-card');
  cards.forEach(card => {
    const fOk = filiere === 'all' || card.dataset.filiere === filiere;
    const sOk = !search || card.dataset.name.includes(search) || card.dataset.cre.includes(search);
    card.classList.toggle('hidden', !(fOk && sOk));
  });
  // Hide sections that have no visible cards
  document.querySelectorAll('#cre-companies-grid .filiere-section').forEach(section => {
    const hasVisible = Array.from(section.querySelectorAll('.company-card')).some(c => !c.classList.contains('hidden'));
    section.style.display = hasVisible ? 'block' : 'none';
  });
}

function updateCREStats() {
  const totalStudents = Object.values(registrations).reduce((a, v) => a + v.length, 0);
  const companiesWithStudents = Object.values(registrations).filter(v => v.length > 0).length;
  document.getElementById('cre-stats-bar').textContent =
    `${totalStudents} étudiant${totalStudents > 1 ? 's' : ''} positionnés sur ${companiesWithStudents} entreprise${companiesWithStudents > 1 ? 's' : ''}`;
}

// (toggleCRECompanyNote supprimé — note déplacée dans la fiche étudiant du modal CRE)

function exportCREPositionnements() {
  const a = document.createElement('a');
  a.href = `/api/cre/positionnements/export?pin=${encodeURIComponent(crePin)}`;
  a.click();
}

// ===== CRE MODAL =====
async function openCREModal(company) {
  currentCRECompany = company;
  const color = FILIERE_COLORS[company.filiere] || '#94a3b8';
  const initials = getInitials(company.nomAffichage || company.nom);

  // Logo
  const logoEl = document.getElementById('cre-modal-logo');
  const logoFallback = document.getElementById('cre-modal-logo-fallback');
  logoFallback.style.display = 'none';
  if (company.logoFile) {
    logoEl.style.display = 'block';
    logoEl.src = `/images/logos/${company.logoFile}`;
    logoFallback.style.background = color;
    logoFallback.textContent = initials;
  } else {
    logoEl.style.display = 'none';
    logoFallback.style.display = 'flex';
    logoFallback.style.background = color;
    logoFallback.textContent = initials;
  }

  document.getElementById('cre-modal-company-name').textContent = company.nomAffichage || company.nom;
  const badge = document.getElementById('cre-modal-filiere-badge');
  badge.textContent = company.filiere;
  badge.style.background = color;
  document.getElementById('cre-modal-contact').textContent = company.contact ? `Contact : ${company.contact}` : '';

  // Stand
  document.getElementById('cre-stand-salle').value = company.stand?.salle || '';
  document.getElementById('cre-stand-etage').value = company.stand?.etage || '';
  document.getElementById('stand-save-msg').style.display = 'none';

  // Form reset
  ['student-nom', 'student-prenom', 'student-formation', 'student-cre'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('add-student-error').style.display = 'none';

  await refreshStudentsList(company.id);

  document.getElementById('modal-cre').classList.add('open');
  document.body.style.overflow = 'hidden';
}

async function refreshStudentsList(companyId) {
  try {
    const [sRes, nRes] = await Promise.all([
      fetch(`/api/companies/${companyId}/students`),
      fetch(`/api/cre/student-notes?pin=${encodeURIComponent(crePin)}&companyId=${companyId}`)
    ]);
    const students = await sRes.json();
    const notes = nRes.ok ? await nRes.json() : {};
    // Merge notes into global state
    Object.assign(creStudentNotes, notes);
    registrations[companyId] = students;
    renderStudentsList(students);
    document.getElementById('student-count-badge').textContent = students.length;
    const exportBtn = document.getElementById('cre-export-btn');
    if (exportBtn) exportBtn.style.display = students.length > 0 ? 'inline-flex' : 'none';
  } catch (e) {
    console.error(e);
  }
}

function renderStudentsList(students) {
  const listEl = document.getElementById('students-list');
  if (!students || students.length === 0) {
    listEl.innerHTML = '<p class="no-students">Aucun étudiant positionné pour l\'instant</p>';
    return;
  }
  listEl.innerHTML = students.map((s, i) => `
    <div class="student-item">
      <div class="student-item-top">
        <div class="student-num">${i + 1}</div>
        <div class="student-info">
          <div class="student-name">${s.prenom} ${s.nom}</div>
          <div class="student-details">${s.formation}${s.cre ? ' · CRE: ' + s.cre : ''}</div>
        </div>
        <button class="btn-delete-student" onclick="deleteStudent('${currentCRECompany.id}', '${s.id}')" title="Retirer">🗑</button>
      </div>
      <textarea id="cre-debrief-${s.id}" class="cre-debrief-area"
                placeholder="🔖 Débriefe entretien CRE (confidentiel)..."
                onblur="saveCREDebrief('${s.id}')">${creStudentNotes[s.id] || ''}</textarea>
    </div>`).join('');
}

async function saveCREDebrief(studentId) {
  const ta = document.getElementById(`cre-debrief-${studentId}`);
  if (!ta) return;
  try {
    const res = await fetch(`/api/cre/student-notes/${studentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: crePin, note: ta.value })
    });
    if (!res.ok) throw new Error('Erreur ' + res.status);
    creStudentNotes[studentId] = ta.value;
    ta.style.borderColor = '#4caf50';
    setTimeout(() => { ta.style.borderColor = ''; }, 1200);
  } catch(e) {
    ta.style.borderColor = '#ef4444';
    setTimeout(() => { ta.style.borderColor = ''; }, 2000);
  }
}

async function addStudent() {
  const nom = document.getElementById('student-nom').value.trim();
  const prenom = document.getElementById('student-prenom').value.trim();
  const formation = document.getElementById('student-formation').value.trim();
  const cre = document.getElementById('student-cre').value.trim();
  const errEl = document.getElementById('add-student-error');

  // Auto-save stand silently before positioning student
  const salle = document.getElementById('cre-stand-salle').value.trim();
  const etage = document.getElementById('cre-stand-etage').value;
  if (salle || etage) {
    try {
      const standRes = await fetch(`/api/companies/${currentCRECompany.id}/stand`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: crePin, salle, etage })
      });
      if (standRes.ok) {
        const updated = await standRes.json();
        const newStand = { salle: updated.salle || '', etage: updated.etage || '' };
        const idx = companies.findIndex(c => c.id === currentCRECompany.id);
        if (idx !== -1) companies[idx].stand = newStand;
        currentCRECompany.stand = newStand;
      }
    } catch (e) { /* silent fail */ }
  }

  if (!nom || !prenom || !formation) {
    errEl.textContent = 'Veuillez remplir Nom, Prénom et Formation.';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';

  try {
    const res = await fetch(`/api/companies/${currentCRECompany.id}/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: crePin, nom, prenom, formation, cre })
    });
    if (!res.ok) {
      const data = await res.json();
      errEl.textContent = data.error || 'Erreur serveur';
      errEl.style.display = 'block';
      return;
    }
    ['student-nom', 'student-prenom', 'student-formation', 'student-cre'].forEach(id => {
      document.getElementById(id).value = '';
    });
    await refreshStudentsList(currentCRECompany.id);
    updateCREStats();
    refreshCRECardCount(currentCRECompany.id);
    showToast(`${prenom} ${nom} positionné(e) ✓`, 'success');
  } catch (e) {
    errEl.textContent = 'Erreur réseau. Vérifiez votre connexion.';
    errEl.style.display = 'block';
  }
}

async function deleteStudent(companyId, studentId) {
  if (!confirm('Retirer cet étudiant ?')) return;
  try {
    await fetch(`/api/companies/${companyId}/students/${studentId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: crePin })
    });
    await refreshStudentsList(companyId);
    updateCREStats();
    refreshCRECardCount(companyId);
    showToast('Étudiant retiré', 'success');
  } catch (e) {
    showToast('Erreur lors de la suppression', 'error');
  }
}

function refreshCRECardCount(companyId) {
  const count = (registrations[companyId] || []).length;
  const cards = document.querySelectorAll('#cre-companies-grid .company-card');
  cards.forEach(card => {
    if (card.onclick.toString().includes(`id:${companyId}`) ||
        (currentCRECompany && card.dataset.name.includes((currentCRECompany.nomAffichage || currentCRECompany.nom).toLowerCase()))) {
      const pill = card.querySelector('.card-student-pill');
      if (pill) {
        pill.textContent = count > 0 ? `${count} ✓` : '0';
        pill.classList.toggle('has-students', count > 0);
      }
    }
  });
  // Re-render CRE grid to update counts
  renderCREGrid(companies);
}

async function saveStand() {
  const salle = document.getElementById('cre-stand-salle').value.trim();
  const etage = document.getElementById('cre-stand-etage').value;
  try {
    const res = await fetch(`/api/companies/${currentCRECompany.id}/stand`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: crePin, salle, etage })
    });
    const updated = await res.json();
    const newStand = { salle: updated.salle || '', etage: updated.etage || '' };
    // Update local companies array
    const idx = companies.findIndex(c => c.id === currentCRECompany.id);
    if (idx !== -1) companies[idx].stand = newStand;
    currentCRECompany.stand = newStand;

    const msg = document.getElementById('stand-save-msg');
    msg.style.display = 'block';
    setTimeout(() => { msg.style.display = 'none'; }, 3000);
    showToast('Emplacement enregistré ✓', 'success');
  } catch (e) {
    showToast('Erreur lors de la sauvegarde', 'error');
  }
}

function closeCREModal() {
  document.getElementById('modal-cre').classList.remove('open');
  document.body.style.overflow = '';
  currentCRECompany = null;
}

function closeModalCRE(event) {
  if (event.target === document.getElementById('modal-cre')) closeCREModal();
}

// ===== ADMIN =====
let adminPin = '';

function enterAdminMode() {
  currentMode = 'admin';
  showScreen('screen-admin');
}

async function verifyAdmin() {
  const pin = document.getElementById('admin-pin-input').value.trim();
  const res = await fetch('/api/auth/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  const data = await res.json();
  if (data.valid) {
    adminPin = pin;
    sessionStorage.setItem('ss_adminPin', pin);
    document.getElementById('admin-login').style.display = 'none';
    document.getElementById('admin-dashboard').style.display = 'block';
    await loadAdminStats();
  } else {
    document.getElementById('admin-login-error').style.display = 'block';
  }
}

async function loadAdminStats() {
  try {
    const [res1, res2] = await Promise.all([
      fetch(`/api/admin/stats?pin=${encodeURIComponent(adminPin)}`),
      fetch(`/api/admin/self-registrations?pin=${encodeURIComponent(adminPin)}`)
    ]);
    const data    = await res1.json();
    const srData  = await res2.json();
    data._selfRegs = srData;
    renderAdminStats(data);
  } catch(e) {
    console.error('Erreur chargement stats admin:', e);
  }
}

function renderAdminStats(data) {
  const { global: g, topCompanies, filieres, companiesDetail, generatedAt } = data;

  // Dernière MAJ
  const dt = new Date(generatedAt);
  document.getElementById('admin-last-update').textContent =
    `Mis à jour : ${dt.toLocaleTimeString('fr-FR')}`;

  // ── KPIs globaux
  const kpiData = [
    { icon: '🏢', label: 'Entreprises présentes',    value: g.totalCompanies,          color: '#1a0050' },
    { icon: '✅', label: 'Entreprises avec candidats', value: g.companiesWithStudents,  color: '#16a34a' },
    { icon: '👥', label: 'Total candidats',           value: g.totalStudents,           color: '#0369a1' },
    { icon: '📋', label: 'Positionnés par CRE',       value: g.totalPositioned,         color: '#7c3aed' },
    { icon: '➕', label: 'Candidatures spontanées',   value: g.totalSpontaneous,        color: '#FF1AA8' },
    { icon: '🤝', label: 'Entretiens réalisés',       value: g.totalMet,                color: '#059669' },
    { icon: '📝', label: 'Décisions enregistrées',    value: g.totalRated,              color: '#d97706' },
    { icon: '🏢', label: 'Sans candidat positionné',  value: g.companiesWithout,        color: '#94a3b8' },
    { icon: '✍️', label: 'Inscrits sur place',         value: (data._selfRegs && data._selfRegs.nbValidated) || 0, color: '#16a34a' },
    { icon: '⏳', label: 'Inscriptions à valider',     value: (data._selfRegs && data._selfRegs.nbPending)   || 0, color: '#f59e0b' },
  ];
  document.getElementById('admin-kpi-grid').innerHTML = kpiData.map(k => `
    <div class="admin-kpi-card" style="border-left: 4px solid ${k.color}">
      <div class="kpi-icon">${k.icon}</div>
      <div class="kpi-value" style="color:${k.color}">${k.value}</div>
      <div class="kpi-label">${k.label}</div>
    </div>
  `).join('');

  // ── Résultats entretiens
  const totalEval = g.totalHire + g.totalRetained + g.totalMaybe + g.totalRefused;
  const ratingData = [
    { emoji: '❤️', label: 'Je l\'embauche',       value: g.totalHire,     color: '#ef4444', cls: 'hire' },
    { emoji: '😊', label: 'Candidature retenue',  value: g.totalRetained, color: '#22c55e', cls: 'retained' },
    { emoji: '🟠', label: 'À voir',               value: g.totalMaybe,    color: '#f97316', cls: 'maybe' },
    { emoji: '😡', label: 'Refusé(e)',            value: g.totalRefused,  color: '#64748b', cls: 'refused' },
  ];
  document.getElementById('admin-ratings-grid').innerHTML = ratingData.map(r => {
    const pct = totalEval > 0 ? Math.round(r.value / totalEval * 100) : 0;
    return `
    <div class="admin-rating-card">
      <div class="arc-emoji">${r.emoji}</div>
      <div class="arc-value" style="color:${r.color}">${r.value}</div>
      <div class="arc-label">${r.label}</div>
      <div class="arc-bar-wrap">
        <div class="arc-bar" style="width:${pct}%;background:${r.color}"></div>
      </div>
      <div class="arc-pct">${pct}%</div>
    </div>`;
  }).join('');

  // ── Filières
  const FILIERE_COLORS_ADMIN = {
    'COMMERCE NS': '#8b5cf6', 'COMMERCE CLEM': '#ec4899',
    'IMMOBILIER': '#10b981', 'BANQUE / ASSURANCE': '#f59e0b',
    'MARKETING / COM / SOCIAL': '#f97316', 'RH / TOURISME': '#06b6d4',
    'SOCIAL': '#84cc16', 'AUTRE': '#94a3b8'
  };
  const maxStudents = Math.max(...Object.values(filieres).map(f => f.students), 1);
  document.getElementById('admin-filieres-list').innerHTML = Object.entries(filieres)
    .sort((a,b) => b[1].students - a[1].students)
    .map(([name, f]) => {
      const color = FILIERE_COLORS_ADMIN[name] || '#94a3b8';
      const pct = Math.round(f.students / maxStudents * 100);
      return `
      <div class="admin-filiere-row">
        <div class="filiere-row-name">
          <span class="filiere-dot" style="background:${color}"></span>
          <strong>${name}</strong>
          <span class="filiere-row-co">${f.companies} entrep.</span>
        </div>
        <div class="filiere-bar-wrap">
          <div class="filiere-bar" style="width:${pct}%;background:${color}"></div>
        </div>
        <div class="filiere-row-stats">
          <span class="filiere-stat-students">👥 ${f.students}</span>
          <span class="filiere-stat-hire">❤️ ${f.hire}</span>
          <span class="filiere-stat-retained">😊 ${f.retained}</span>
        </div>
      </div>`;
    }).join('');

  // ── Top entreprises
  document.getElementById('admin-top-companies').innerHTML = topCompanies.map((c, i) => {
    const color = FILIERE_COLORS[c.filiere] || '#94a3b8';
    const initials = getInitials(c.nom);
    const logoHtml = c.logoFile
      ? `<img src="/images/logos/${c.logoFile}" alt="${c.nom}" class="admin-top-logo"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
         <div class="admin-top-logo-fb" style="display:none;background:${color}">${initials}</div>`
      : `<div class="admin-top-logo-fb" style="background:${color}">${initials}</div>`;
    return `
    <div class="admin-top-card">
      <div class="admin-top-rank">${i + 1}</div>
      <div class="admin-top-logo-wrap">${logoHtml}</div>
      <div class="admin-top-info">
        <div class="admin-top-name">${c.nom}</div>
        <div class="admin-top-filiere" style="color:${color}">${c.filiere}</div>
      </div>
      <div class="admin-top-nums">
        <span class="atn atn-blue">👥 ${c.nbStudents}</span>
        <span class="atn atn-green">🤝 ${c.nbMet}</span>
        <span class="atn atn-red">❤️ ${c.ratings.hire}</span>
        <span class="atn atn-em">😊 ${c.ratings.retained}</span>
      </div>
    </div>`;
  }).join('');

  // ── Tableau détaillé (interactif)
  window._adminCompaniesDetail = companiesDetail; // cache global pour popup
  window._adminColFilter = 'all';
  renderAdminTable();
}

function renderAdminTable() {
  const detail = window._adminCompaniesDetail || [];
  const search   = (document.getElementById('admin-filter-search')  || {}).value || '';
  const filiere  = (document.getElementById('admin-filter-filiere') || {}).value || 'all';
  const colFilter= window._adminColFilter || 'all';

  const mkCell = (id, val, filter) => val
    ? `<td class="td-num td-clickable ${filter}" onclick="openAdminDetail(${id},'${filter}')" title="Voir les candidats">${val}</td>`
    : `<td class="td-num">—</td>`;

  const filtered = detail
    .filter(c => {
      if (search   && !c.nom.toLowerCase().includes(search.toLowerCase())) return false;
      if (filiere !== 'all' && c.filiere !== filiere) return false;
      if (colFilter !== 'all') {
        const val = colFilter === 'met' ? c.nbMet : colFilter === 'spontaneous' ? c.nbSpontaneous : c[colFilter];
        if (!val || val === 0) return false;
      }
      return true;
    })
    .sort((a,b) => b.nbStudents - a.nbStudents);

  const empty = document.getElementById('admin-table-empty');
  if (empty) empty.style.display = filtered.length === 0 ? 'block' : 'none';

  document.getElementById('admin-table-body').innerHTML = filtered.map(c => `
    <tr class="${c.nbStudents === 0 ? 'row-empty' : ''}">
      <td class="td-company td-clickable" onclick="openAdminDetail(${c.id},'all')" title="Voir tous les candidats">${c.nom}</td>
      <td><span class="filiere-tag" style="background:${FILIERE_COLORS[c.filiere]||'#94a3b8'}">${c.filiere}</span></td>
      ${c.nbStudents ? `<td class="td-num td-clickable" onclick="openAdminDetail(${c.id},'all')">${c.nbStudents}</td>` : '<td class="td-num">0</td>'}
      ${mkCell(c.id, c.nbSpontaneous, 'spontaneous')}
      ${mkCell(c.id, c.nbMet, 'met')}
      ${mkCell(c.id, c.hire,     'hire')}
      ${mkCell(c.id, c.retained, 'retained')}
      ${mkCell(c.id, c.maybe,    'maybe')}
      ${mkCell(c.id, c.refused,  'refused')}
      <td class="td-num"><button class="btn-del-company" onclick="deleteCompany(${c.id},'${c.nom.replace(/'/g,"\\'")}')">🗑️</button></td>
    </tr>`).join('');
}

async function deleteCompany(id, nom) {
  const pin = prompt(`Supprimer "${nom}" ?\n\nEntrez le code PIN de confirmation :`);
  if (!pin) return;
  if (!confirm(`Confirmer la suppression définitive de "${nom}" ?`)) return;
  try {
    const res = await fetch(`/api/companies/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await res.json();
    if (!res.ok) { alert('Erreur : ' + (data.error || res.statusText)); return; }
    alert(`"${nom}" supprimée avec succès.`);
    // Recharger la liste globale des entreprises pour tous les cubes
    const r2 = await fetch('/api/companies');
    companies = await r2.json();
    // Cube Candidat
    renderCompaniesGrid(companies);
    updateFilterCounts();
    // Cube Je m'inscris
    srRenderCompaniesGrid(companies);
    srUpdateFilterCounts();
    // Cube Entreprise
    if (typeof renderEntSelection === 'function') renderEntSelection(companies);
    // Cube CRE
    renderCREGrid(companies);
    updateCREStats();
    // Admin
    loadAdminStats();
  } catch(e) { alert('Erreur réseau : ' + e.message); }
}

function filterAdminTable() { renderAdminTable(); }

// ── Sections repliables Admin ─────────────────────────────────────────────────
function toggleAdminSection(titleEl) {
  const section = titleEl.closest('.admin-section');
  const wasCollapsed = section.classList.contains('collapsed');
  section.classList.toggle('collapsed');
  if (wasCollapsed && section.id === 'section-etudiants' && !window._adminStudentsLoaded) {
    loadAdminStudents();
  }
  if (wasCollapsed && section.id === 'section-selfregs' && !window._adminSelfRegsLoaded) {
    loadAdminSelfRegs();
  }
}

// ── Tableau étudiants Admin ───────────────────────────────────────────────────
let _adminStudents = [];
let _adminStudentColFilter = 'all';
const RATING_ICONS_ADM   = { hire:'❤️', retained:'😊', maybe:'🟠', refused:'😡' };
const RATING_LABELS_ADM  = { hire:'Embauché(e)', retained:'Retenu(e)', maybe:'À voir', refused:'Refusé(e)' };

async function loadAdminStudents() {
  const wrap = document.getElementById('admin-students-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-muted)">⏳ Chargement…</div>';
  try {
    const res  = await fetch(`/api/admin/students?pin=${encodeURIComponent(adminPin)}`);
    const data = await res.json();
    if (data.error) { wrap.innerHTML = `<p class="admin-table-empty">Erreur : ${data.error}</p>`; return; }
    _adminStudents = data.students || [];
    window._adminStudentsLoaded = true;
    renderAdminStudents();
  } catch(e) { wrap.innerHTML = '<p class="admin-table-empty">Erreur de chargement</p>'; }
}

function filterAdminStudents() { renderAdminStudents(); }

function setStudentColFilter(col, btn) {
  _adminStudentColFilter = col;
  ['sf-all','sf-hire','sf-retained','sf-maybe','sf-refused','sf-met'].forEach(id => {
    const el = document.getElementById(id); if (el) el.classList.remove('active');
  });
  if (btn) btn.classList.add('active');
  renderAdminStudents();
}

function renderAdminStudents() {
  const wrap   = document.getElementById('admin-students-wrap');
  const sq     = ((document.getElementById('admin-student-search')||{}).value||'').toLowerCase();
  const filF   = (document.getElementById('admin-student-filiere')||{}).value||'all';
  const colF   = _adminStudentColFilter;

  const list = _adminStudents.filter(s => {
    const matchS = !sq || (s.nom||'').toLowerCase().includes(sq) ||
      (s.prenom||'').toLowerCase().includes(sq) || (s.formation||'').toLowerCase().includes(sq);
    const matchF = filF==='all' || s.companies.some(c=>(c.filiere||'').includes(filF));
    const matchC = colF==='all' || (colF==='met' && s.companies.some(c=>c.met)) ||
      (['hire','retained','maybe','refused'].includes(colF) && s.companies.some(c=>c.rating===colF));
    return matchS && matchF && matchC;
  });

  if (!list.length) { wrap.innerHTML='<p class="admin-table-empty">Aucun(e) candidat(e) ne correspond.</p>'; return; }

  const rows = list.map(s => {
    const nbMet=s.companies.filter(c=>c.met).length;
    const nbH=s.companies.filter(c=>c.rating==='hire').length;
    const nbR=s.companies.filter(c=>c.rating==='retained').length;
    const nbM=s.companies.filter(c=>c.rating==='maybe').length;
    const nbX=s.companies.filter(c=>c.rating==='refused').length;
    const did=`sd_${s.nom}_${s.prenom}`.replace(/[^a-z0-9]/gi,'_');
    const compRows=s.companies.map(c=>`
      <tr class="stu-comp-row">
        <td>${c.nom}</td>
        <td><span class="filiere-tag" style="background:${FILIERE_COLORS[c.filiere]||'#94a3b8'};color:#fff;font-size:0.68rem;padding:1px 5px;border-radius:4px">${c.filiere||''}</span></td>
        <td style="font-size:0.75rem;color:${c.spontaneous?'#8b5cf6':'#64748b'}">${c.spontaneous?'➕ Spontanée':'CRE'}</td>
        <td class="td-num">${c.met?'🤝':'—'}</td>
        <td class="td-num">${c.rating?`<span class="ad-badge ad-${c.rating}" style="font-size:0.72rem">${RATING_ICONS_ADM[c.rating]} ${RATING_LABELS_ADM[c.rating]}</span>`:'—'}</td>
        <td class="td-comment">${c.comment?`<span title="${c.comment.replace(/"/g,"'")}">💬 ${c.comment.slice(0,40)}${c.comment.length>40?'…':''}</span>`:''}</td>
      </tr>`).join('');
    return `
    <tr class="stu-main-row" onclick="toggleStudentDetail('${did}')">
      <td class="td-company"><span class="stu-arrow" id="arr_${did}">▸</span> <strong>${s.prenom} ${s.nom}</strong></td>
      <td class="td-formation-col">${s.formation||'—'}</td>
      <td class="td-num">${s.companies.length||'—'}</td>
      <td class="td-num">${nbMet||'—'}</td>
      <td class="td-num">${nbH?`<span class="ad-badge ad-hire">${nbH}❤️</span>`:'—'}</td>
      <td class="td-num">${nbR?`<span class="ad-badge ad-retained">${nbR}😊</span>`:'—'}</td>
      <td class="td-num">${nbM?`<span class="ad-badge ad-maybe">${nbM}🟠</span>`:'—'}</td>
      <td class="td-num">${nbX?`<span class="ad-badge ad-refused">${nbX}😡</span>`:'—'}</td>
    </tr>
    <tr id="${did}" style="display:none">
      <td colspan="8" style="padding:0;background:#f8fafc">
        <table class="stu-inner-table">
          <thead><tr><th>Entreprise</th><th>Filière</th><th>Type</th><th>Rencontré</th><th>Décision</th><th>Commentaire</th></tr></thead>
          <tbody>${compRows}</tbody>
        </table>
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML=`<table class="admin-table"><thead><tr>
    <th>Candidat(e)</th><th>Formation</th>
    <th class="th-num">Entreprises</th><th class="th-num">Rencontrés</th>
    <th class="th-emoji">❤️<span class="th-emoji-label">Embauche</span></th>
    <th class="th-emoji">😊<span class="th-emoji-label">Retenu</span></th>
    <th class="th-emoji">🟠<span class="th-emoji-label">À voir</span></th>
    <th class="th-emoji">😡<span class="th-emoji-label">Refusé</span></th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

function toggleStudentDetail(id) {
  const row=document.getElementById(id); if(!row) return;
  const open=row.style.display!=='none';
  row.style.display=open?'none':'table-row';
  const arrow=document.getElementById('arr_'+id);
  if(arrow) arrow.textContent=open?'▸':'▾';
}

// ── Admin : Inscriptions sur place ───────────────────────────────────────────
let _adminSelfRegs = [];
let _adminSrStatusFilter = 'all';

async function loadAdminSelfRegs() {
  const wrap = document.getElementById('admin-sr-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-muted)">⏳ Chargement…</div>';
  try {
    const res  = await fetch(`/api/admin/self-registrations?pin=${encodeURIComponent(adminPin)}`);
    const data = await res.json();
    if (data.error) { wrap.innerHTML = `<p class="admin-table-empty">Erreur : ${data.error}</p>`; return; }
    _adminSelfRegs = data.registrations || [];
    window._adminSelfRegsLoaded = true;

    // Stats header
    const statsEl = document.getElementById('admin-sr-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="admin-sr-stat-bar">
          <span class="sr-stat-item"><strong>${data.total}</strong> inscription${data.total > 1 ? 's' : ''} total</span>
          <span class="sr-stat-item sr-stat-pending">⏳ <strong>${data.nbPending}</strong> en attente</span>
          <span class="sr-stat-item sr-stat-validated">✅ <strong>${data.nbValidated}</strong> validée${data.nbValidated > 1 ? 's' : ''}</span>
          <span class="sr-stat-item sr-stat-rejected">❌ <strong>${data.nbRejected}</strong> refusée${data.nbRejected > 1 ? 's' : ''}</span>
        </div>`;
    }
    // Badge dans le titre
    const badge = document.getElementById('admin-sr-badge');
    if (badge) badge.textContent = data.total;

    renderAdminSelfRegs();
  } catch(e) {
    if (wrap) wrap.innerHTML = '<p class="admin-table-empty">Erreur de chargement</p>';
  }
}

let _adminSrStatusFilter2 = 'all';
function setSrStatusFilter(val, btn) {
  _adminSrStatusFilter2 = val;
  document.querySelectorAll('[data-sr-status]').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderAdminSelfRegs();
}

function renderAdminSelfRegs() {
  const wrap = document.getElementById('admin-sr-table-wrap');
  if (!wrap || !_adminSelfRegs.length) return;
  const search = (document.getElementById('admin-sr-search') || {}).value || '';
  const q = search.toLowerCase();

  const STATUS_LABEL = { pending: '⏳ En attente', validated: '✅ Validé', rejected: '❌ Refusé' };
  const STATUS_CLASS = { pending: 'sr-adm-pending', validated: 'sr-adm-validated', rejected: 'sr-adm-rejected' };

  const list = _adminSelfRegs.filter(function(r) {
    if (_adminSrStatusFilter2 !== 'all' && r.status !== _adminSrStatusFilter2) return false;
    if (q && !(
      (r.nom||'').toLowerCase().includes(q) ||
      (r.prenom||'').toLowerCase().includes(q) ||
      (r.email||'').toLowerCase().includes(q) ||
      (r.domainesInteret||'').toLowerCase().includes(q) ||
      (r.companyName||'').toLowerCase().includes(q)
    )) return false;
    return true;
  });

  if (!list.length) {
    wrap.innerHTML = '<p class="admin-table-empty">Aucune inscription ne correspond aux filtres.</p>';
    return;
  }

  wrap.innerHTML = `<table class="admin-table">
    <thead><tr>
      <th>Statut</th><th>Nom / Prénom</th><th>Contact</th>
      <th>Diplôme / Domaine</th><th>Entreprise d'intérêt</th><th>Date inscription</th>
    </tr></thead>
    <tbody>${list.map(function(r) {
      const d = r.createdAt ? new Date(r.createdAt).toLocaleString('fr-FR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
      return `<tr>
        <td><span class="sr-adm-badge ${STATUS_CLASS[r.status]||''}">${STATUS_LABEL[r.status]||r.status}</span></td>
        <td><strong>${r.nom} ${r.prenom}</strong></td>
        <td>${r.email ? `<div>✉️ ${r.email}</div>` : ''}${r.telephone ? `<div>📱 ${r.telephone}</div>` : ''}</td>
        <td>${r.diplome ? `<div>${r.diplome}</div>` : ''}${r.domainesInteret ? `<div class="domaine-tag">${r.domainesInteret}</div>` : ''}</td>
        <td>${r.companyName ? `<span class="sr-company-tag">${r.companyName}</span>` : '—'}</td>
        <td class="td-date">${d}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function exportAdminSelfRegs() {
  window.open('/api/self-register/export?pin=' + encodeURIComponent(adminPin), '_blank');
}

// Export Excel — Détail par entreprise
function exportAdminCompanies() {
  const detail = window._adminCompaniesDetail || [];
  const LABELS = { hire:"Je l'embauche", retained:'Retenu(e)', maybe:'À voir', refused:'Refusé(e)' };
  const rows = [['Entreprise','Filière','Candidats','Spontanées','Rencontrés','❤️ Embauche','😊 Retenu','🟠 À voir','😡 Refusé']];
  detail.forEach(c => rows.push([c.nom,c.filiere||'',c.nbStudents,c.nbSpontaneous,c.nbMet,c.hire,c.retained,c.maybe,c.refused]));
  downloadCSV(rows, `admin_entreprises_${new Date().toISOString().slice(0,10)}.csv`);
}

// Export Excel — Détail par candidat(e)
function exportAdminCandidates() {
  const LICONS = { hire:"Je l'embauche", retained:'Retenu(e)', maybe:'À voir', refused:'Refusé(e)' };
  const rows = [['Candidat(e)','Formation','Nb entreprises','Rencontrés','❤️ Embauche','😊 Retenu','🟠 À voir','😡 Refusé','Détail par entreprise']];
  _adminStudents.forEach(s => {
    const nbMet=s.companies.filter(c=>c.met).length;
    const nbH=s.companies.filter(c=>c.rating==='hire').length;
    const nbR=s.companies.filter(c=>c.rating==='retained').length;
    const nbM=s.companies.filter(c=>c.rating==='maybe').length;
    const nbX=s.companies.filter(c=>c.rating==='refused').length;
    const detail=s.companies.map(c=>`${c.nom}:${c.rating?LICONS[c.rating]:'—'}${c.met?' (rencontré)':''}`).join(' | ');
    rows.push([`${s.prenom} ${s.nom}`,s.formation||'',s.companies.length,nbMet,nbH,nbR,nbM,nbX,detail]);
  });
  downloadCSV(rows, `admin_candidats_${new Date().toISOString().slice(0,10)}.csv`);
}

// Générateur CSV générique côté client
function downloadCSV(rows, filename) {
  const bom = '\ufeff';
  const csv = bom + rows.map(r => r.map(cell => `"${String(cell==null?'':cell).replace(/"/g,'""')}"`).join(';')).join('\r\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function setAdminColFilter(col, btn) {
  window._adminColFilter = col;
  document.querySelectorAll('.admin-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderAdminTable();
}

// ===== ADMIN : POPUP DÉTAIL ENTREPRISE =====
const RATING_FILTER_LABELS = {
  all:        { label: 'Tous les candidats',       emoji: '👥' },
  spontaneous:{ label: 'Candidatures spontanées',  emoji: '➕' },
  met:        { label: 'Candidats rencontrés',      emoji: '🤝' },
  hire:       { label: 'Je l\'embauche',            emoji: '❤️' },
  retained:   { label: 'Candidature retenue',       emoji: '😊' },
  maybe:      { label: 'À voir',                   emoji: '🟠' },
  refused:    { label: 'Candidature refusée',       emoji: '😡' },
};

async function openAdminDetail(companyId, filter) {
  const company = companies.find(c => c.id === companyId) || { nom: 'Entreprise', nomAffichage: '' };
  const compName = company.nomAffichage || company.nom;
  const color    = FILIERE_COLORS[company.filiere] || '#94a3b8';

  // Affiche le popup vide pendant le chargement
  const popup = document.getElementById('admin-detail-popup');
  const overlay = document.getElementById('admin-detail-overlay');
  document.getElementById('admin-detail-title').textContent = compName;
  document.getElementById('admin-detail-subtitle').textContent = 'Chargement…';
  document.getElementById('admin-detail-list').innerHTML = '<div class="admin-detail-loading">⏳ Chargement…</div>';
  popup.style.display = 'flex';
  overlay.style.display = 'block';

  try {
    const res = await fetch(`/api/admin/companies/${companyId}/detail?pin=${encodeURIComponent(adminPin)}`);
    const { students, ratings } = await res.json();

    // Filtre les étudiants selon le critère cliqué
    let filtered = students;
    const fl = RATING_FILTER_LABELS[filter] || RATING_FILTER_LABELS['all'];
    if (filter === 'spontaneous') filtered = students.filter(s => s.spontaneous);
    else if (filter === 'met')    filtered = students.filter(s => (ratings[s.id] || {}).met === true);
    else if (['hire','retained','maybe','refused'].includes(filter))
      filtered = students.filter(s => (ratings[s.id] || {}).rating === filter);

    document.getElementById('admin-detail-subtitle').innerHTML =
      `${fl.emoji} <strong>${fl.label}</strong> — ${filtered.length} candidat${filtered.length > 1 ? 's' : ''}`;

    if (!filtered.length) {
      document.getElementById('admin-detail-list').innerHTML =
        '<p class="admin-detail-empty">Aucun candidat dans cette catégorie.</p>';
      return;
    }

    document.getElementById('admin-detail-list').innerHTML = filtered.map(s => {
      const r = ratings[s.id] || {};
      const ri = RATING_FILTER_LABELS[r.rating];
      return `
      <div class="admin-detail-row">
        <div class="admin-detail-student">
          <div class="admin-detail-name">${s.prenom} ${s.nom}${s.spontaneous ? ' <span class="badge-spon">Spontanée</span>' : ''}</div>
          <div class="admin-detail-meta">${s.formation}${s.cre ? ' · ' + s.cre : ''}${s.email ? ' · ' + s.email : ''}</div>
        </div>
        <div class="admin-detail-badges">
          ${r.met === true ? '<span class="ad-badge ad-met">🤝 Rencontré(e)</span>' : ''}
          ${ri ? `<span class="ad-badge ad-rating ad-${r.rating}">${ri.emoji} ${ri.label}</span>` : ''}
          ${r.comment ? `<div class="ad-comment">💬 ${r.comment}</div>` : ''}
        </div>
      </div>`;
    }).join('');

  } catch(e) {
    document.getElementById('admin-detail-list').innerHTML = '<p class="admin-detail-empty">Erreur de chargement.</p>';
  }
}

function closeAdminDetail() {
  document.getElementById('admin-detail-popup').style.display = 'none';
  document.getElementById('admin-detail-overlay').style.display = 'none';
}

// ===== ENTREPRISE AUTH =====
async function verifyEntreprise() {
  const pin = document.getElementById('ent-pin-input').value.trim();
  const res = await fetch('/api/auth/entreprise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  const data = await res.json();
  if (data.valid) {
    entPin = pin;
    entAuthenticated = true;
    sessionStorage.setItem('ss_entPin', pin);
    document.getElementById('ent-login').style.display = 'none';
    document.getElementById('ent-selection').style.display = 'block';
    renderEntSelection(companies);
    loadAutocompleteList(pin);
  } else {
    document.getElementById('ent-login-error').style.display = 'block';
  }
}

// ===== ENTREPRISE : SÉLECTION =====
function renderEntSelection(list) {
  const grid = document.getElementById('ent-companies-grid');
  grid.innerHTML = '';
  const grouped = groupAndSort(list);
  grouped.forEach(({ filiere, color, companies: groupCompanies }) => {
    const section = document.createElement('div');
    section.className = 'filiere-section';
    section.dataset.filiere = filiere;

    const count = groupCompanies.length;
    const header = document.createElement('div');
    header.className = 'filiere-section-header';
    header.innerHTML = `
      <div class="filiere-section-dot" style="background:${color}"></div>
      <span class="filiere-section-name">${FILIERE_LABELS[filiere] || filiere}</span>
      <span class="filiere-section-count">${count} entreprise${count > 1 ? 's' : ''}</span>
    `;
    section.appendChild(header);

    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'cards-grid-wrap';

    groupCompanies.forEach(company => {
      const cardColor = FILIERE_COLORS[company.filiere] || '#94a3b8';
      const initials = getInitials(company.nomAffichage || company.nom);

      const card = document.createElement('div');
      card.className = 'company-card ent-select-card';
      card.dataset.name = (company.nom + ' ' + (company.nomAffichage || '')).toLowerCase();
      card.dataset.filiere = company.filiere;
      card.style.setProperty('--card-color', cardColor);
      card.onclick = () => openEntDashboard(company);

      card.innerHTML = `
        <div class="card-logo-area">
          ${company.logoFile
            ? `<img src="/images/logos/${company.logoFile}"
                alt="${company.nomAffichage || company.nom}"
                onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'" />
               <div class="card-logo-fallback-inner" style="display:none;background:${cardColor}">${initials}</div>`
            : `<div class="card-logo-fallback-inner" style="background:${cardColor}">${initials}</div>`
          }
        </div>
        <div class="card-info">
          <div class="card-name">${company.nomAffichage || company.nom}</div>
          ${company.secteur ? `<div class="card-tagline">${company.secteur}</div>` : ''}
        </div>
      `;
      cardsWrap.appendChild(card);
    });

    section.appendChild(cardsWrap);
    grid.appendChild(section);
  });
}

function filterEntSelection() {
  const search = document.getElementById('ent-search').value.toLowerCase().trim();
  document.querySelectorAll('#ent-companies-grid .company-card').forEach(card => {
    card.classList.toggle('hidden', !!search && !card.dataset.name.includes(search));
  });
  // Hide sections that have no visible cards
  document.querySelectorAll('#ent-companies-grid .filiere-section').forEach(section => {
    const hasVisible = Array.from(section.querySelectorAll('.company-card')).some(c => !c.classList.contains('hidden'));
    section.style.display = hasVisible ? 'block' : 'none';
  });
}

// ===== ENTREPRISE : DASHBOARD =====
async function openEntDashboard(company) {
  currentEntCompany = company;
  const color = FILIERE_COLORS[company.filiere] || '#94a3b8';
  const initials = getInitials(company.nomAffichage || company.nom);

  document.getElementById('ent-selection').style.display = 'none';
  document.getElementById('ent-dashboard').style.display = 'block';

  // Bouton retour → sélection
  const backBtn = document.getElementById('ent-back-btn');
  backBtn.textContent = '← Retour';
  backBtn.onclick = entBackToSelection;

  // Logo
  const logoEl = document.getElementById('ent-modal-logo');
  const logoFb = document.getElementById('ent-modal-logo-fallback');
  if (company.logoFile) {
    logoEl.style.display = 'block';
    logoEl.src = `/images/logos/${company.logoFile}`;
    logoFb.style.display = 'none';
  } else {
    logoEl.style.display = 'none';
    logoFb.style.display = 'flex';
    logoFb.style.background = color;
    logoFb.textContent = initials;
  }

  document.getElementById('ent-company-name').textContent = company.nomAffichage || company.nom;
  const badge = document.getElementById('ent-filiere-badge');
  badge.textContent = company.filiere;
  badge.style.background = color;

  // Reset formulaire spontané
  document.getElementById('ent-spontaneous-form').style.display = 'none';
  document.getElementById('ent-spontaneous-error').style.display = 'none';
  ['ent-nom','ent-prenom','ent-formation','ent-email','ent-phone'].forEach(id => {
    document.getElementById(id).value = '';
  });

  await loadEntStudents(company.id);

  // Refresh automatique toutes les 30s (synchronisation avec CRE)
  if (entRefreshInterval) clearInterval(entRefreshInterval);
  entRefreshInterval = setInterval(() => {
    if (currentEntCompany) loadEntStudents(currentEntCompany.id);
  }, 30000);
}

let entRefreshInterval = null;

function entBackToSelection() {
  if (entRefreshInterval) { clearInterval(entRefreshInterval); entRefreshInterval = null; }
  document.getElementById('ent-dashboard').style.display = 'none';
  document.getElementById('ent-selection').style.display = 'block';
  currentEntCompany = null;
  entStudents = [];
  entRatings = {};
  entPendingChanges = {};
  const backBtn = document.getElementById('ent-back-btn');
  backBtn.textContent = '← Accueil';
  backBtn.onclick = goHome;
}

// ===== ENTREPRISE : CHARGEMENT CANDIDATS =====
async function loadEntStudents(companyId) {
  try {
    const [sRes, rRes, nRes] = await Promise.all([
      fetch(`/api/companies/${companyId}/students`),
      fetch(`/api/companies/${companyId}/ratings?pin=${encodeURIComponent(entPin)}`),
      fetch(`/api/companies/${companyId}/cre-student-notes`)
    ]);
    entStudents = await sRes.json();
    entRatings  = await rRes.json();
    entCREStudentNotes = nRes.ok ? await nRes.json() : {};
    entPendingChanges = {};
    renderEntStudents();
  } catch(e) { console.error('Erreur chargement candidats entreprise:', e); }
}

const RATING_LABELS = {
  hire:     { emoji: '❤️',  label: 'Je l\'embauche',       cls: 'hire' },
  retained: { emoji: '😊',  label: 'Candidature retenue',  cls: 'retained' },
  maybe:    { emoji: '🟠',  label: 'À voir',               cls: 'maybe' },
  refused:  { emoji: '😡',  label: 'Candidature refusée',  cls: 'refused' }
};

function renderEntStudents() {
  const list = document.getElementById('ent-students-list');
  document.getElementById('ent-student-count').textContent = entStudents.length;
  const exportBtn = document.getElementById('ent-export-btn');
  if (exportBtn) exportBtn.style.display = entStudents.length > 0 ? 'inline-flex' : 'none';

  if (!entStudents.length) {
    list.innerHTML = '<p class="no-students">Aucun candidat positionné pour le moment.<br>Utilisez le bouton ci-dessus pour ajouter une candidature spontanée.</p>';
    return;
  }

  list.innerHTML = entStudents.map((s, idx) => {
    const r = entRatings[s.id] || {};
    const ri = RATING_LABELS[r.rating];
    const ratingBadgeHtml = ri ? `<span class="ent-rating-badge ent-rb-${ri.cls}">${ri.emoji}</span>` : '';
    const metBadgeHtml = r.met === true
      ? '<span class="ent-met-badge ent-met-yes">🤝 Rencontré(e)</span>'
      : '';

    return `
    <div class="ent-student-item" id="ent-si-${s.id}">
      <div class="ent-student-header" onclick="toggleRatingPanel('${s.id}')">
        <div class="ent-student-num">${idx + 1}</div>
        <div class="ent-student-main">
          <div class="ent-student-name">${s.prenom} ${s.nom}${s.spontaneous ? ' <span class="badge-spontaneous">Spontanée</span>' : ''}</div>
          <div class="ent-student-meta">${s.formation}${s.email ? ' · ' + s.email : ''}${s.phone ? ' · ' + s.phone : ''}</div>
        </div>
        <div class="ent-student-status">
          ${metBadgeHtml}${ratingBadgeHtml}
          <span class="ent-expand-icon">▼</span>
        </div>
      </div>

      <div class="ent-rating-panel" id="ent-panel-${s.id}" style="display:none">

        <!-- Coordonnées candidat -->
        ${(s.email || s.phone) ? `
        <div class="ent-panel-section ent-contact-section">
          <div class="ent-section-label">📞 Coordonnées</div>
          <div class="ent-contact-row">
            ${s.phone ? `<a href="tel:${s.phone}" class="ent-contact-btn ent-contact-phone">📱 ${s.phone}</a>` : ''}
            ${s.email ? `<a href="mailto:${s.email}" class="ent-contact-btn ent-contact-email">✉️ ${s.email}</a>` : ''}
          </div>
        </div>` : ''}

        <!-- Rencontré ? -->
        <div class="ent-panel-section">
          <div class="ent-section-label">Entretien réalisé ?</div>
          <div class="ent-met-btns">
            <button class="ent-met-btn ent-met-yes-btn ${r.met === true ? 'active' : ''}"
                    onclick="setMet('${s.id}', true, this)">🤝 Oui, rencontré(e)</button>
            <button class="ent-met-btn ent-met-no-btn ${r.met === false ? 'active' : ''}"
                    onclick="setMet('${s.id}', false, this)">⏳ Pas encore</button>
          </div>
        </div>

        <!-- Notation -->
        <div class="ent-panel-section">
          <div class="ent-section-label">Votre décision</div>
          <div class="ent-rating-btns">
            <button class="ent-rating-btn ent-rb-hire ${r.rating === 'hire' ? 'active' : ''}"
                    onclick="setRating('${s.id}', 'hire', this)">
              <span class="rating-emoji">❤️</span>
              <span class="rating-label">Je l'embauche</span>
            </button>
            <button class="ent-rating-btn ent-rb-retained ${r.rating === 'retained' ? 'active' : ''}"
                    onclick="setRating('${s.id}', 'retained', this)">
              <span class="rating-emoji">😊</span>
              <span class="rating-label">Retenu(e)</span>
            </button>
            <button class="ent-rating-btn ent-rb-maybe ${r.rating === 'maybe' ? 'active' : ''}"
                    onclick="setRating('${s.id}', 'maybe', this)">
              <span class="rating-emoji">🟠</span>
              <span class="rating-label">À voir</span>
            </button>
            <button class="ent-rating-btn ent-rb-refused ${r.rating === 'refused' ? 'active' : ''}"
                    onclick="setRating('${s.id}', 'refused', this)">
              <span class="rating-emoji">😡</span>
              <span class="rating-label">Refusé(e)</span>
            </button>
          </div>
        </div>

        <!-- Commentaire entreprise -->
        <div class="ent-panel-section">
          <div class="ent-section-label">📝 Notes & impressions</div>
          <textarea id="ent-comment-${s.id}" class="ent-comment"
                    placeholder="Vos impressions, points forts, points à retravailler..."
                    onblur="autoSaveRating('${s.id}')">${r.comment || ''}</textarea>
        </div>

      </div>
    </div>`;
  }).join('');
}

async function entDeleteStudent(studentId, nom) {
  if (!confirm(`Supprimer ${nom} de votre liste de candidats ?\nCette action est irréversible.`)) return;
  try {
    const res = await fetch(`/api/companies/${currentEntCompany.id}/students/${studentId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: entPin })
    });
    if (!res.ok) throw new Error('Erreur serveur');
    entStudents = entStudents.filter(s => s.id !== studentId);
    if (entRatings[studentId]) delete entRatings[studentId];
    renderEntStudents();
  } catch (e) {
    alert('Erreur lors de la suppression.');
  }
}

// ===== ENTREPRISE : INTERACTIONS =====
function toggleRatingPanel(studentId) {
  const panel = document.getElementById(`ent-panel-${studentId}`);
  const icon  = document.querySelector(`#ent-si-${studentId} .ent-expand-icon`);
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  if (icon) icon.textContent = isOpen ? '▼' : '▲';
}

function setMet(studentId, met, btn) {
  if (!entPendingChanges[studentId]) entPendingChanges[studentId] = { ...(entRatings[studentId] || {}) };
  entPendingChanges[studentId].met = met;
  const panel = document.getElementById(`ent-panel-${studentId}`);
  panel.querySelectorAll('.ent-met-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  autoSaveRating(studentId);
}

function setRating(studentId, rating, btn) {
  if (!entPendingChanges[studentId]) entPendingChanges[studentId] = { ...(entRatings[studentId] || {}) };
  const current = entPendingChanges[studentId].rating;
  const panel = document.getElementById(`ent-panel-${studentId}`);
  panel.querySelectorAll('.ent-rating-btn').forEach(b => b.classList.remove('active'));
  if (current === rating) {
    entPendingChanges[studentId].rating = null; // toggle off
  } else {
    entPendingChanges[studentId].rating = rating;
    btn.classList.add('active');
  }
  autoSaveRating(studentId);
}

async function saveRating(studentId) {
  const pending = { ...(entRatings[studentId] || {}), ...(entPendingChanges[studentId] || {}) };
  const comment = (document.getElementById(`ent-comment-${studentId}`) || {}).value || '';
  try {
    const res = await fetch(`/api/companies/${currentEntCompany.id}/ratings/${studentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: entPin, met: pending.met || false, rating: pending.rating || null, comment })
    });
    const saved = await res.json();
    entRatings[studentId] = saved;
    delete entPendingChanges[studentId];
    updateStudentSummary(studentId, saved);
    showToast('Enregistré ✓', 'success');
  } catch(e) {
    showToast('Erreur lors de la sauvegarde', 'error');
  }
}

async function autoSaveCRENote(studentId) {
  const ta = document.getElementById(`ent-cre-note-${studentId}`);
  if (!ta) return;
  const note = ta.value;
  try {
    const res = await fetch(`/api/companies/${currentEntCompany.id}/cre-student-notes/${studentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: entPin, note })
    });
    if (!res.ok) throw new Error('Erreur serveur ' + res.status);
    entCREStudentNotes[studentId] = note;
    ta.style.borderColor = '#4caf50';
    setTimeout(() => { ta.style.borderColor = ''; }, 1200);
  } catch(e) {
    ta.style.borderColor = '#ef4444';
    setTimeout(() => { ta.style.borderColor = ''; }, 2000);
  }
}

async function autoSaveRating(studentId) {
  const pending = { ...(entRatings[studentId] || {}), ...(entPendingChanges[studentId] || {}) };
  const comment = (document.getElementById(`ent-comment-${studentId}`) || {}).value || '';
  const panel = document.getElementById(`ent-panel-${studentId}`);
  try {
    const res = await fetch(`/api/companies/${currentEntCompany.id}/ratings/${studentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: entPin, met: pending.met !== undefined ? pending.met : false, rating: pending.rating || null, comment })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const saved = await res.json();
    entRatings[studentId] = saved;
    delete entPendingChanges[studentId];
    updateStudentSummary(studentId, saved);
    // Feedback visuel sur les boutons actifs du panel
    if (panel) {
      panel.querySelectorAll('.ent-rating-btn.active, .ent-met-btn.active').forEach(btn => {
        const orig = btn.textContent;
        btn.style.outline = '2px solid #4caf50';
        setTimeout(() => { btn.style.outline = ''; }, 1500);
      });
    }
  } catch(e) {
    // Feedback d'erreur visible
    if (panel) {
      panel.querySelectorAll('.ent-rating-btn.active, .ent-met-btn.active').forEach(btn => {
        btn.style.outline = '2px solid #ef4444';
        setTimeout(() => { btn.style.outline = ''; }, 2000);
      });
    }
    showToast('Erreur sauvegarde — réessayez', 'error');
  }
}

function updateStudentSummary(studentId, r) {
  const item = document.getElementById(`ent-si-${studentId}`);
  if (!item) return;
  const ri = RATING_LABELS[r.rating];
  const ratingBadgeHtml = ri ? `<span class="ent-rating-badge ent-rb-${ri.cls}">${ri.emoji}</span>` : '';
  const metBadgeHtml = r.met === true ? '<span class="ent-met-badge ent-met-yes">🤝 Rencontré(e)</span>' : '';
  const icon = item.querySelector('.ent-expand-icon');
  const statusEl = item.querySelector('.ent-student-status');
  statusEl.innerHTML = `${metBadgeHtml}${ratingBadgeHtml}<span class="ent-expand-icon">${icon ? icon.textContent : '▼'}</span>`;
}

// ===== ENTREPRISE : CANDIDATURE SPONTANÉE =====
function toggleSpontaneousForm() {
  const form = document.getElementById('ent-spontaneous-form');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

async function addSpontaneous() {
  const nom      = document.getElementById('ent-nom').value.trim();
  const prenom   = document.getElementById('ent-prenom').value.trim();
  const formation= document.getElementById('ent-formation').value.trim();
  const email    = document.getElementById('ent-email').value.trim();
  const phone    = document.getElementById('ent-phone').value.trim();
  const errEl    = document.getElementById('ent-spontaneous-error');

  if (!nom || !prenom || !formation) {
    errEl.textContent = 'Veuillez remplir Nom, Prénom et Formation.';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';

  try {
    const res = await fetch(`/api/companies/${currentEntCompany.id}/students/spontaneous`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: entPin, nom, prenom, formation, email, phone })
    });
    if (!res.ok) {
      const d = await res.json();
      errEl.textContent = d.error || 'Erreur serveur';
      errEl.style.display = 'block';
      return;
    }
    ['ent-nom','ent-prenom','ent-formation','ent-email','ent-phone'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('ent-spontaneous-form').style.display = 'none';
    await loadEntStudents(currentEntCompany.id);
    showToast(`${prenom} ${nom} ajouté(e) ✓`, 'success');
  } catch(e) {
    errEl.textContent = 'Erreur réseau.';
    errEl.style.display = 'block';
  }
}

// ===== AJOUT ENTREPRISE (CRE) =====
function openAddCompanyModal() {
  ['add-company-nom','add-company-contact','add-company-secteur','add-company-website'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('add-company-filiere').value = '';
  document.getElementById('add-company-error').style.display = 'none';
  document.getElementById('modal-add-company').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeAddCompanyModal(event) {
  if (event && event.target !== document.getElementById('modal-add-company') && event.type === 'click' && event.currentTarget === document.getElementById('modal-add-company')) return;
  if (event && event.target !== document.getElementById('modal-add-company')) return;
  document.getElementById('modal-add-company').classList.remove('open');
  document.body.style.overflow = '';
}

async function addCompany() {
  const nom     = document.getElementById('add-company-nom').value.trim();
  const filiere = document.getElementById('add-company-filiere').value;
  const contact = document.getElementById('add-company-contact').value.trim();
  const secteur = document.getElementById('add-company-secteur').value.trim();
  const website = document.getElementById('add-company-website').value.trim();
  const errEl   = document.getElementById('add-company-error');

  if (!nom) { errEl.textContent = 'Le nom est obligatoire.'; errEl.style.display = 'block'; return; }
  if (!filiere) { errEl.textContent = 'Veuillez choisir une filière.'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';

  try {
    const res = await fetch('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: crePin, nom, filiere, contact, secteur, website })
    });
    if (!res.ok) {
      const d = await res.json();
      errEl.textContent = d.error || 'Erreur serveur';
      errEl.style.display = 'block';
      return;
    }
    const newCompany = await res.json();
    companies.push(newCompany);
    updateFilterCounts();
    renderCREGrid(companies);
    updateCREStats();
    document.getElementById('modal-add-company').classList.remove('open');
    document.body.style.overflow = '';
    showToast(`${nom} ajoutée avec succès ✓`, 'success');
  } catch(e) {
    errEl.textContent = 'Erreur réseau.';
    errEl.style.display = 'block';
  }
}

// ===== EXPORT EXCEL (CSV) =====
function exportEntCandidates() {
  if (!currentEntCompany || !entStudents.length) return;
  const url = `/api/companies/${currentEntCompany.id}/export-candidates?pin=${encodeURIComponent(entPin)}`;
  const a = document.createElement('a'); a.href = url; a.click();
}

function exportPresence() {
  const a = document.createElement('a');
  a.href = `/api/cre/presence/export?pin=${encodeURIComponent(crePin)}`;
  a.click();
}

function exportCRECandidates() {
  if (!currentCRECompany) return;
  const url = `/api/cre/companies/${currentCRECompany.id}/export-candidates?pin=${encodeURIComponent(crePin)}`;
  const a = document.createElement('a'); a.href = url; a.click();
}

// ===== CRE : ONGLET PRÉSENCE =====
let presenceData = {};
let companyNotes = {};
let creStudentNotes = {}; // briefings CRE par étudiant, clé = studentId
let currentCREView = 'positionnements';

let _sheetAutoRefreshTimer = null;

function switchCREView(view) {
  currentCREView = view;
  document.getElementById('tab-positionnements').classList.toggle('active', view === 'positionnements');
  document.getElementById('tab-presence').classList.toggle('active', view === 'presence');
  document.getElementById('tab-candidats').classList.toggle('active', view === 'candidats');
  document.getElementById('cre-positionnements-view').style.display = view === 'positionnements' ? 'block' : 'none';
  document.getElementById('cre-presence-view').style.display = view === 'presence' ? 'block' : 'none';
  document.getElementById('cre-candidats-view').style.display = view === 'candidats' ? 'block' : 'none';
  if (view === 'presence') loadPresenceTab();
  if (view === 'candidats') {
    if (!sheetCandidates.length) loadSheetCandidates();
    loadPendingSelfRegs(); // charge les inscriptions sur place en attente
    requestAnimationFrame(fixCandidatsSticky);
    // Auto-refresh toutes les 5 minutes quand l'onglet est actif
    if (!_sheetAutoRefreshTimer) {
      _sheetAutoRefreshTimer = setInterval(function() {
        if (currentCREView === 'candidats') { loadSheetCandidates(true); loadPendingSelfRegs(); }
      }, 5 * 60 * 1000);
    }
  } else {
    // Arrête le timer si on quitte l'onglet candidats
    if (_sheetAutoRefreshTimer) {
      clearInterval(_sheetAutoRefreshTimer);
      _sheetAutoRefreshTimer = null;
    }
  }
}

async function loadPresenceTab() {
  try {
    const [r1, r2] = await Promise.all([
      fetch(`/api/cre/presence?pin=${encodeURIComponent(crePin)}`),
      fetch(`/api/cre/company-notes?pin=${encodeURIComponent(crePin)}`)
    ]);
    presenceData  = await r1.json();
    companyNotes  = await r2.json();
  } catch(e) { presenceData = {}; companyNotes = {}; }
  renderPresenceTab();
}

let _presenceFilter = 'all';
function setPresenceFilter(val, btn) {
  _presenceFilter = val;
  document.querySelectorAll('#pf-all,#pf-present,#pf-absent').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderPresenceTab();
}

function renderPresenceTab() {
  const wrap = document.getElementById('presence-table-wrap');

  // Stats globales (sur toutes les entreprises, sans filtre)
  const nbTotal    = companies.length;
  const nbPresent  = companies.filter(c => presenceData[c.id] && presenceData[c.id].present).length;
  const taux       = nbTotal ? Math.round(nbPresent / nbTotal * 100) : 0;
  const totalPersonnes = companies.reduce((sum, c) => sum + ((presenceData[c.id] && presenceData[c.id].nbPersonnes) || 0), 0);

  document.getElementById('presence-stats').innerHTML =
    `<span class="pstat">🏢 ${nbPresent} / ${nbTotal} entreprise${nbTotal > 1 ? 's' : ''} présente${nbPresent > 1 ? 's' : ''}</span>
     <span class="pstat pstat-taux" style="background:${taux >= 75 ? '#16a34a' : taux >= 50 ? '#d97706' : '#dc2626'}">📊 Taux de présence : ${taux}%</span>
     <span class="pstat">👥 ${totalPersonnes} personne${totalPersonnes > 1 ? 's' : ''} sur les stands</span>`;

  // Filtres
  const search  = (document.getElementById('presence-search')  || {}).value || '';
  const filiere = (document.getElementById('presence-filiere') || {}).value || 'all';

  const sorted = [...companies]
    .filter(c => {
      const name = (c.nomAffichage || c.nom).toLowerCase();
      if (search && !name.includes(search.toLowerCase())) return false;
      if (filiere !== 'all' && c.filiere !== filiere) return false;
      const present = !!(presenceData[c.id] && presenceData[c.id].present);
      if (_presenceFilter === 'present' && !present) return false;
      if (_presenceFilter === 'absent'  &&  present) return false;
      return true;
    })
    .sort((a, b) => (a.nomAffichage || a.nom).localeCompare(b.nomAffichage || b.nom));

  if (!sorted.length) {
    wrap.innerHTML = '<p class="admin-table-empty">Aucune entreprise ne correspond aux filtres.</p>';
    return;
  }

  wrap.innerHTML = `<table class="presence-table">
    <thead><tr>
      <th>Entreprise</th><th>Filière</th><th>Présent ?</th><th>Nb personnes sur le stand</th><th class="th-note">Note CRE</th>
    </tr></thead>
    <tbody>${sorted.map(c => {
      const p = presenceData[c.id] || { present: false, nbPersonnes: 0 };
      const note = companyNotes[c.id] || '';
      return `<tr class="${p.present ? 'row-present' : ''}" id="prow-${c.id}">
        <td class="ptd-name">${c.nomAffichage || c.nom}</td>
        <td><span class="filiere-badge-sm" style="background:${FILIERE_COLORS[c.filiere]||'#94a3b8'}">${c.filiere || '-'}</span></td>
        <td class="ptd-check">
          <label class="presence-toggle">
            <input type="checkbox" ${p.present ? 'checked' : ''}
              onchange="updatePresence(${c.id}, this.checked, document.getElementById('nb-${c.id}').value)" />
            <span class="toggle-label">${p.present ? '✅ Présent' : '❌ Absent'}</span>
          </label>
        </td>
        <td class="ptd-nb">
          <input type="number" id="nb-${c.id}" class="nb-input" value="${p.nbPersonnes}" min="0" max="20"
            onchange="updatePresence(${c.id}, document.getElementById('nb-${c.id}').closest('tr').querySelector('input[type=checkbox]').checked, this.value)"
            ${!p.present ? 'disabled' : ''} />
        </td>
        <td class="td-note">
          <button class="btn-note-cre${note ? ' has-note' : ''}"
            onclick="togglePresenceNoteRow(this, ${c.id})"
            title="${note ? note.substring(0,80) : 'Ajouter une note'}">${note ? '📝' : '✏️'}</button>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

async function updatePresence(companyId, present, nbPersonnes) {
  try {
    await fetch(`/api/cre/presence/${companyId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: crePin, present, nbPersonnes: parseInt(nbPersonnes) || 0 })
    });
    presenceData[companyId] = { present, nbPersonnes: parseInt(nbPersonnes) || 0 };
    renderPresenceTab();
  } catch(e) { showToast('Erreur sauvegarde présence', 'error'); }
}

function togglePresenceNoteRow(btn, companyId) {
  const existing = document.querySelector('.note-expand-row[data-coid]');
  if (existing) {
    if (existing.dataset.coid === String(companyId)) { existing.remove(); return; }
    existing.remove();
  }
  const currentNote = companyNotes[companyId] || '';
  const tr = btn.closest('tr');
  const cols = tr.querySelectorAll('td').length;
  const expandRow = document.createElement('tr');
  expandRow.className = 'note-expand-row';
  expandRow.dataset.coid = String(companyId);
  expandRow.innerHTML =
    '<td colspan="' + cols + '" class="td-note-expand">' +
      '<div class="note-expand-inner">' +
        '<div class="note-label">📝 Note CRE :</div>' +
        '<textarea class="note-textarea" placeholder="Saisissez votre note ici (échanges, impression, suites à donner…)">' +
          currentNote.replace(/</g,'&lt;').replace(/>/g,'&gt;') +
        '</textarea>' +
        '<div class="note-expand-actions">' +
          '<span class="note-hint">💾 Sauvegarde auto à la sortie du champ</span>' +
          '<button class="btn-note-close" onclick="this.closest(\'.note-expand-row\').remove()">✕ Fermer</button>' +
        '</div>' +
      '</div>' +
    '</td>';
  tr.insertAdjacentElement('afterend', expandRow);
  const ta = expandRow.querySelector('textarea');
  ta.addEventListener('blur', function() { savePresenceNote(companyId, ta, btn); });
  ta.focus();
  ta.selectionStart = ta.selectionEnd = ta.value.length;
}

async function savePresenceNote(companyId, textarea, noteBtn) {
  const note = textarea.value.trim();
  try {
    await fetch('/api/cre/company-notes/' + companyId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: crePin, note })
    });
    companyNotes[companyId] = note;
    if (noteBtn) {
      noteBtn.textContent = note ? '📝' : '✏️';
      noteBtn.title = note ? note.substring(0,80) : 'Ajouter une note';
      noteBtn.classList.toggle('has-note', !!note);
    }
  } catch(e) { showToast('Erreur sauvegarde note', 'error'); }
}

// ===== TOAST =====
let toastTimer;
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// ═══════════════════════════════════════════════════════════
//  GOOGLE SHEET — Candidats inscrits
// ═══════════════════════════════════════════════════════════

async function loadSheetCandidates(force) {
  force = force || false;
  const url = '/api/sheet-candidates?pin=' + encodeURIComponent(crePin) + (force ? '&refresh=1' : '');
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) { showToast('❌ ' + data.error, 'error'); return; }
    sheetCandidates = data.candidates || [];
    sheetCandidatesLastSync = data.lastSync;
    updateSheetStats();
    renderSheetCandidates();
    if (force) showToast('🔄 ' + sheetCandidates.length + ' candidats synchronisés', 'success');
  } catch(e) {
    showToast('❌ Erreur chargement candidats: ' + e.message, 'error');
  }
}

function updateSheetStats() {
  const badge = document.getElementById('sheet-total-badge');
  if (badge) badge.textContent = sheetCandidates.length;
  const syncEl = document.getElementById('sheet-sync-info');
  if (syncEl && sheetCandidatesLastSync) {
    const d = new Date(sheetCandidatesLastSync);
    syncEl.textContent = 'Sync ' + d.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
  }
  const statsEl = document.getElementById('sheet-stats-bar');
  if (!statsEl) return;
  const present = sheetCandidates.filter(function(c) { return c.checkedIn; }).length;
  const positioned = sheetCandidates.filter(function(c) { return c.nbCompanies > 0; }).length;
  const dupCount = sheetCandidates.filter(function(c) { return c.hasDuplicate; }).length;
  statsEl.innerHTML =
    '<span class="sheet-stat">✅ <strong>' + present + '</strong> présent(s)</span>' +
    '<span class="sheet-stat">⏳ <strong>' + (sheetCandidates.length - present) + '</strong> attendu(s)</span>' +
    '<span class="sheet-stat">🏢 <strong>' + positioned + '</strong> positionné(s)</span>' +
    '<span class="sheet-stat">📋 <strong>' + sheetCandidates.length + '</strong> inscrits total</span>' +
    (dupCount > 0 ? '<span class="sheet-stat sheet-stat-dup">⚠️ <strong>' + dupCount + '</strong> doublon(s) à vérifier</span>' : '');
}

function renderSheetCandidates() {
  const searchEl = document.getElementById('sheet-search');
  const sitEl    = document.getElementById('sheet-situation-filter');
  const search   = searchEl ? searchEl.value.toLowerCase() : '';
  const sitF     = sitEl ? sitEl.value : 'all';

  const list = sheetCandidates.filter(function(c) {
    const matchS = !search ||
      (c.nom||'').toLowerCase().includes(search) ||
      (c.prenom||'').toLowerCase().includes(search) ||
      (c.email||'').toLowerCase().includes(search) ||
      (c.domaines||'').toLowerCase().includes(search) ||
      (c.diplome||'').toLowerCase().includes(search);
    const matchSit = sitF === 'all' || (c.situation||'').includes(sitF);
    const matchC = sheetCheckinFilter === 'all' ||
      (sheetCheckinFilter === 'in'  && c.checkedIn) ||
      (sheetCheckinFilter === 'out' && !c.checkedIn);
    return matchS && matchSit && matchC;
  }).sort(function(a,b) { return (a.nom||'').localeCompare(b.nom||''); });

  const container = document.getElementById('sheet-candidates-table');
  if (!container) return;

  if (!list.length && !sheetCandidates.length) {
    container.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center">Cliquez sur 🔄 Actualiser pour charger les candidats inscrits</div>';
    return;
  }
  if (!list.length) {
    container.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center">Aucun candidat ne correspond aux filtres</div>';
    return;
  }

  // Stockage global des listes d'entreprises, doublons et infos candidat par index
  window._sheetCompaniesStore = [];
  window._sheetDuplicatesStore = [];
  window._sheetCandidateInfoStore = [];

  const rows = list.map(function(c, idx) {
    const key = (c.email && c.email.indexOf('@') !== -1) ? c.email : (c.nom + '__' + (c.prenom||'').toLowerCase());
    const keySafe = key.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const formationSafe = (c.formationCiblee||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    const isSR = !!c.selfRegistered;
    const sitClass = isSR ? 'sit-sr' :
                     (c.situation||'').indexOf('CLEM') !== -1 ? 'sit-ns' :
                     (c.situation||'').indexOf('autre') !== -1 ? 'sit-ext' : 'sit-reco';
    const sitLabel = isSR ? '✍️ Inscription sur place' :
                     (c.situation||'').indexOf('CLEM') !== -1 ? '🎓 CLEM' :
                     (c.situation||'').indexOf('autre') !== -1 ? '🏫 Autre école' :
                     (c.situation||'').indexOf('Reconver') !== -1 ? '🔄 Reconversion' : (c.situation||'—');
    const srId = c.selfRegisteredId || '';

    // Stocke les entreprises, doublons et infos candidat dans les tableaux globaux, accessibles par index
    window._sheetCompaniesStore[idx] = c.companies || [];
    window._sheetDuplicatesStore[idx] = c.duplicateSR || null;
    window._sheetCandidateInfoStore[idx] = { email: c.email||'', prenom: c.prenom||'', nom: c.nom||'' };

    return '<tr class="sheet-row' + (c.checkedIn ? ' checked-in' : '') + (isSR ? ' row-sr' : '') + (c.hasDuplicate ? ' row-has-dup' : '') + '">' +
      '<td class="td-checkin">' +
        '<button class="btn-checkin' + (c.checkedIn ? ' is-in' : '') + '" onclick="toggleCheckin(\'' + keySafe + '\',' + c.checkedIn + ')" title="' + (c.checkedIn ? 'Présent(e)' : 'Marquer présent(e)') + '">' +
          (c.checkedIn ? '✅' : '⬜') + '</button>' +
        (c.checkinAt ? '<div class="checkin-time">' + new Date(c.checkinAt).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}) + '</div>' : '') +
      '</td>' +
      '<td class="td-name"><strong>' + c.nom + ' ' + (c.prenom||'') + '</strong>' +
        (c.notesCandidat ? ' <span class="candidate-note" title="' + (c.notesCandidat||'').replace(/"/g,'&quot;') + '">💬</span>' : '') +
        (c.hasDuplicate ? ' <button class="btn-dup-alert" onclick="toggleDuplicateRow(this,' + idx + ')" title="Doublon potentiel — cliquer pour détails">⚠️</button>' : '') +
      '</td>' +
      '<td class="td-contact">' +
        (c.tel ? '<div>📱 ' + c.tel + '</div>' : '') +
        (c.email ? '<div class="email-small">✉️ ' + c.email + '</div>' : '') +
      '</td>' +
      '<td class="td-formation"><div>' + (c.diplome||'—') + '</div>' +
        (c.domaines ? '<div class="domaine-tag">' + c.domaines + '</div>' : '') +
      '</td>' +
      '<td class="td-situation">' +
        '<span class="situation-badge ' + sitClass + '">' + sitLabel + '</span>' +
        (isSR && srId ? ' <button class="btn-del-sr" onclick="deleteSelfRegCandidate(\'' + srId + '\')" title="Annuler la validation (erreur)">🗑️</button>' : '') +
      '</td>' +
      '<td class="td-formation-ciblee">' +
        '<input type="text" class="formation-ciblee-input" value="' + formationSafe + '" placeholder="Formation visée…"' +
        ' onblur="saveFormationCiblee(\'' + keySafe + '\',this.value)" onkeydown="if(event.key===\'Enter\')this.blur()" />' +
      '</td>' +
      '<td class="td-companies">' +
        (c.nbCompanies > 0
          ? '<button class="btn-companies-count" onclick="openCandidateCompanies(this,' + idx + ')">' + c.nbCompanies + ' 🏢</button>'
          : '<span class="no-company">—</span>') +
      '</td>' +
      '<td class="td-note">' +
        '<button class="btn-note-cre' + (c.notesCRE ? ' has-note' : '') + '" ' +
        'onclick="toggleNoteRow(this,\'' + keySafe + '\')" ' +
        'title="' + (c.notesCRE ? c.notesCRE.substring(0,80) : 'Ajouter une note') + '">' +
        (c.notesCRE ? '📝' : '✏️') +
        '</button>' +
      '</td>' +
    '</tr>';
  });

  container.innerHTML = '<table class="sheet-table">' +
    '<thead><tr>' +
      '<th>Présence</th><th>Nom / Prénom</th><th>Contact</th><th>Formation / Domaines</th>' +
      '<th>Situation</th><th>Formation ciblée</th><th>Entreprises</th><th class="th-note">Note CRE</th>' +
    '</tr></thead>' +
    '<tbody>' + rows.join('') + '</tbody>' +
  '</table>';
  // Figer la tête de tableau après rendu
  requestAnimationFrame(fixCandidatsSticky);
}

function setCheckinFilter(f, btn) {
  sheetCheckinFilter = f;
  ['cf-all','cf-in','cf-out'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });
  if (btn) btn.classList.add('active');
  renderSheetCandidates();
}

async function toggleCheckin(key, currentState) {
  try {
    const res = await fetch('/api/sheet-candidates/checkin', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ pin: crePin, key: key, checkedIn: !currentState })
    });
    const data = await res.json();
    if (data.success) {
      const c = sheetCandidates.find(function(x) {
        const k = (x.email && x.email.indexOf('@') !== -1) ? x.email : (x.nom + '__' + (x.prenom||'').toLowerCase());
        return k === key;
      });
      if (c) { c.checkedIn = !currentState; c.checkinAt = !currentState ? new Date().toISOString() : null; }
      updateSheetStats();
      renderSheetCandidates();
      showToast(!currentState ? '✅ Candidat(e) marqué(e) présent(e)' : '⬜ Check-in annulé', 'success');
    }
  } catch(e) { showToast('❌ Erreur', 'error'); }
}

async function saveFormationCiblee(key, value) {
  try {
    await fetch('/api/sheet-candidates/update', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ pin: crePin, key: key, formationCiblee: value })
    });
    const c = sheetCandidates.find(function(x) {
      const k = (x.email && x.email.indexOf('@') !== -1) ? x.email : (x.nom + '__' + (x.prenom||'').toLowerCase());
      return k === key;
    });
    if (c) c.formationCiblee = value;
    if (value) showToast('✓ Formation ciblée enregistrée', 'success');
  } catch(e) {}
}

function toggleDuplicateRow(btn, idx) {
  const existing = document.querySelector('.dup-expand-row');
  if (existing) {
    if (existing.dataset.idx === String(idx)) { existing.remove(); return; }
    existing.remove();
  }
  const sr = window._sheetDuplicatesStore[idx];
  if (!sr) return;
  const tr = btn.closest('tr');
  const cols = tr.querySelectorAll('td').length;
  const expandRow = document.createElement('tr');
  expandRow.className = 'dup-expand-row';
  expandRow.dataset.idx = String(idx);
  const dateStr = sr.createdAt ? new Date(sr.createdAt).toLocaleString('fr-FR', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
  expandRow.innerHTML =
    '<td colspan="' + cols + '" class="td-dup-expand">' +
      '<div class="dup-expand-inner">' +
        '<span class="dup-icon">⚠️</span>' +
        '<div class="dup-info">' +
          '<strong>Doublon potentiel</strong> — Cette personne s\'est également inscrite sur place le ' + dateStr + '<br>' +
          '<span class="dup-detail">👤 ' + sr.nom + ' ' + sr.prenom +
          (sr.email ? ' &nbsp;·&nbsp; ✉️ ' + sr.email : '') +
          (sr.tel   ? ' &nbsp;·&nbsp; 📱 ' + sr.tel   : '') + '</span>' +
        '</div>' +
        '<div class="dup-actions">' +
          '<button class="btn-dup-delete" onclick="deleteDuplicateSR(\'' + sr.id + '\',' + idx + ')">🗑️ Supprimer l\'inscription</button>' +
          '<button class="btn-note-close" onclick="this.closest(\'.dup-expand-row\').remove()">✕ Fermer</button>' +
        '</div>' +
      '</div>' +
    '</td>';
  tr.insertAdjacentElement('afterend', expandRow);
}

async function deleteDuplicateSR(srId, idx) {
  if (!confirm('Supprimer cette inscription sur place ? Cette action est irréversible.')) return;
  try {
    const res = await fetch('/api/cre/selfreg/' + srId + '/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: crePin })
    });
    const data = await res.json();
    if (data.error) { showToast('❌ ' + data.error, 'error'); return; }
    // Retire le marqueur doublon du candidat
    const c = sheetCandidates.find(function(x, i) { return window._sheetDuplicatesStore[i] && window._sheetDuplicatesStore[i].id === srId; });
    if (c) { c.hasDuplicate = false; c.duplicateSR = null; }
    window._sheetDuplicatesStore[idx] = null;
    // Ferme la ligne d'alerte et retire le badge
    const dupRow = document.querySelector('.dup-expand-row');
    if (dupRow) dupRow.remove();
    const btn = document.querySelectorAll('.btn-dup-alert')[idx];
    if (btn) { btn.closest('tr').classList.remove('row-has-dup'); btn.remove(); }
    showToast('✅ Inscription sur place supprimée', 'success');
    loadSheetCandidates(true);
  } catch(e) { showToast('❌ Erreur: ' + e.message, 'error'); }
}

function toggleNoteRow(btn, key) {
  // Ferme une note déjà ouverte
  const existing = document.querySelector('.note-expand-row');
  if (existing) {
    if (existing.dataset.key === key) { existing.remove(); return; }
    existing.remove();
  }
  // Lire la note COURANTE depuis sheetCandidates (pas depuis le HTML figé)
  const candidate = sheetCandidates.find(function(x) {
    const k = (x.email && x.email.indexOf('@') !== -1) ? x.email : (x.nom + '__' + (x.prenom||'').toLowerCase());
    return k === key;
  });
  const decoded = candidate ? (candidate.notesCRE || '') : '';
  const tr = btn.closest('tr');
  const expandRow = document.createElement('tr');
  expandRow.className = 'note-expand-row';
  expandRow.dataset.key = key;
  expandRow.innerHTML =
    '<td colspan="8" class="td-note-expand">' +
      '<div class="note-expand-inner">' +
        '<div class="note-label">📝 Note CRE :</div>' +
        '<textarea class="note-textarea" placeholder="Saisissez votre note ici (échanges, impression, suites à donner…)">' + decoded.replace(/</g,'&lt;') + '</textarea>' +
        '<div class="note-expand-actions">' +
          '<span class="note-hint">💾 Sauvegarde auto à la sortie du champ</span>' +
          '<button class="btn-note-close" onclick="this.closest(\'.note-expand-row\').remove()">✕ Fermer</button>' +
        '</div>' +
      '</div>' +
    '</td>';
  tr.insertAdjacentElement('afterend', expandRow);
  const ta = expandRow.querySelector('textarea');
  ta.addEventListener('blur', function() { saveNotesCRE(key, ta, btn); });
  ta.focus();
  // Place le curseur à la fin
  ta.selectionStart = ta.selectionEnd = ta.value.length;
}

async function saveNotesCRE(key, textarea, noteBtn) {
  const value = textarea.value.trim();
  try {
    await fetch('/api/sheet-candidates/update', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ pin: crePin, key: key, notesCRE: value })
    });
    // Met à jour le cache local
    const c = sheetCandidates.find(function(x) {
      const k = (x.email && x.email.indexOf('@') !== -1) ? x.email : (x.nom + '__' + (x.prenom||'').toLowerCase());
      return k === key;
    });
    if (c) c.notesCRE = value;
    // Met à jour le bouton de la ligne
    if (noteBtn) {
      noteBtn.classList.toggle('has-note', !!value);
      noteBtn.textContent = value ? '📝' : '✏️';
      noteBtn.title = value ? value.substring(0,80) : 'Ajouter une note';
    }
    if (value) showToast('✓ Note CRE enregistrée', 'success');
  } catch(e) { showToast('❌ Erreur sauvegarde', 'error'); }
}

function openCandidateCompanies(btn, idx) {
  // Ferme tout popover déjà ouvert
  document.querySelectorAll('.companies-popover').forEach(function(p) { p.remove(); });

  var companies = (window._sheetCompaniesStore && window._sheetCompaniesStore[idx]) || [];
  var candidat  = (window._sheetCandidateInfoStore && window._sheetCandidateInfoStore[idx]) || {};

  var popover = document.createElement('div');
  popover.className = 'companies-popover';

  var listHtml = companies.map(function(c) {
    var loc = '';
    if (c.salle) loc += ' <span class="cpop-loc">📍 ' + c.salle + (c.etage ? ' · ' + c.etage : '') + '</span>';
    return '<div class="cpop-item"><span class="cpop-dot" style="background:' + (FILIERE_COLORS[c.filiere]||'#94a3b8') + '"></span>' +
           '<span class="cpop-name">' + c.nom + '</span>' + loc + '</div>';
  }).join('');

  var mailBtn = '';
  if (candidat.email) {
    mailBtn = '<div class="cpop-mail-row"><button class="cpop-mail-btn" onclick="sendCandidateReminderMail(' + idx + ')">📧 Envoyer un rappel</button></div>';
  }

  popover.innerHTML = listHtml + mailBtn;

  document.body.appendChild(popover);

  // Positionnement sous le bouton
  var rect = btn.getBoundingClientRect();
  var popW = 240;
  var left = rect.left + window.scrollX;
  // Éviter de déborder à droite
  if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
  popover.style.left = left + 'px';
  popover.style.top  = (rect.bottom + window.scrollY + 6) + 'px';

  // Fermeture au clic extérieur (sauf sur le bouton mail)
  setTimeout(function() {
    document.addEventListener('click', function close(e) {
      if (!popover.contains(e.target)) { popover.remove(); document.removeEventListener('click', close); }
    });
  }, 0);
}

async function sendCandidateReminderMail(idx) {
  var companies = (window._sheetCompaniesStore && window._sheetCompaniesStore[idx]) || [];
  var candidat  = (window._sheetCandidateInfoStore && window._sheetCandidateInfoStore[idx]) || {};
  if (!candidat.email) return;

  // Ferme le popover
  document.querySelectorAll('.companies-popover').forEach(function(p) { p.remove(); });

  var btn = document.querySelector('.cpop-mail-btn');
  var originalText = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '⏳ Envoi…'; btn.disabled = true; }

  try {
    var res = await fetch('/api/cre/send-candidate-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin: crePin,
        to: candidat.email,
        prenom: candidat.prenom || '',
        companies: companies
      })
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur serveur');
    showToast('✅ Email envoyé à ' + candidat.email, 'success');
  } catch(e) {
    // Fallback mailto: si le serveur n'est pas configuré
    showToast('⚠️ ' + e.message + ' — ouverture de votre messagerie…', 'error');
    var prenom = candidat.prenom || '';
    var compList = companies.map(function(c, i) {
      var line = (i + 1) + '. ' + c.nom;
      if (c.filiere) line += ' (' + (FILIERE_LABELS[c.filiere] || c.filiere) + ')';
      if (c.salle)   line += ' — ' + c.salle + (c.etage ? ', ' + c.etage : '');
      return line;
    }).join('\n');
    var subject = 'Tes entreprises à rencontrer – Jobs Alternance';
    var body = 'Bonjour ' + prenom + ',\n\nVoici la liste des entreprises sur lesquelles tu as été positionné(e) lors du Jobs Alternance :\n\n' + compList + '\n\nN\'hésite pas à te présenter à chacun de leurs stands !\n\nÀ très bientôt,\nL\'équipe CRE';
    setTimeout(function() {
      window.location.href = 'mailto:' + encodeURIComponent(candidat.email) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    }, 1500);
  }
}

// ===== OFFRES ALTERNANCE =====
var _offresData = [];

async function loadOffresAlternance() {
  var container = document.getElementById('offres-container');
  if (container) container.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center">⏳ Chargement…</div>';
  try {
    var res = await fetch('/api/offres-alternance?pin=' + encodeURIComponent(crePin));
    _offresData = await res.json();
    renderOffresAlternance(_offresData);
  } catch(e) {
    if (container) container.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center;color:#ef4444">Erreur de chargement</div>';
  }
}

function renderOffresAlternance(data) {
  var container = document.getElementById('offres-container');
  if (!container) return;

  if (!data || !data.length) {
    container.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center">Aucune entreprise trouvée</div>';
    return;
  }

  // Grouper par filière
  var groups = {};
  data.forEach(function(c) {
    var f = c.filiere || 'AUTRE';
    if (!groups[f]) groups[f] = [];
    groups[f].push(c);
  });

  var html = '';
  Object.keys(groups).sort().forEach(function(filiere) {
    var color = FILIERE_COLORS[filiere] || '#94a3b8';
    var label = FILIERE_LABELS[filiere] || filiere;
    html += '<div class="offres-filiere-block">';
    html += '<div class="offres-filiere-header" style="border-left:4px solid ' + color + '">' + label + '</div>';
    html += '<div class="offres-cards">';
    groups[filiere].forEach(function(c) {
      var logoHtml = c.logoFile
        ? '<img src="/images/logos/' + c.logoFile + '" class="offres-logo" onerror="this.style.display=\'none\'">'
        : '<div class="offres-logo-fallback" style="background:' + color + '">' + (c.nomAffichage||c.nom||'').substring(0,2).toUpperCase() + '</div>';
      var nom = c.nomAffichage || c.nom || '';
      var postes = c.postes || [];
      var postesHtml = postes.length
        ? postes.map(function(p) { return '<span class="offres-poste-tag">' + p + '</span>'; }).join('')
        : '<span class="offres-no-poste">Aucun poste renseigné</span>';

      html += '<div class="offres-card" data-company-id="' + c.id + '" data-nom="' + nom.toLowerCase() + '" data-postes="' + postes.join(' ').toLowerCase() + '">';
      html += '<div class="offres-card-head">' + logoHtml + '<span class="offres-card-nom">' + nom + '</span>';
      html += '<button class="offres-edit-btn" onclick="toggleOffresEdit(' + c.id + ')" title="Modifier les postes">✏️</button>';
      html += '</div>';
      html += '<div class="offres-postes" id="offres-postes-' + c.id + '">' + postesHtml + '</div>';
      html += '<div class="offres-edit-zone" id="offres-edit-' + c.id + '" style="display:none">';
      html += '<textarea class="offres-textarea" id="offres-ta-' + c.id + '" placeholder="Saisir les postes (un par ligne)&#10;Ex: Chargé(e) de communication&#10;Assistant(e) marketing digital">' + postes.join('\n') + '</textarea>';
      html += '<div class="offres-edit-actions">';
      html += '<button class="btn-save-offres" onclick="savePosteAlternance(' + c.id + ')">💾 Enregistrer</button>';
      html += '<button class="btn-cancel-offres" onclick="toggleOffresEdit(' + c.id + ')">Annuler</button>';
      html += '</div></div>';
      html += '</div>';
    });
    html += '</div></div>';
  });

  container.innerHTML = html;
}

function filterOffres(query) {
  var q = (query || '').toLowerCase().trim();
  var cards = document.querySelectorAll('.offres-card');
  cards.forEach(function(card) {
    if (!q) { card.style.display = ''; return; }
    var nom = card.dataset.nom || '';
    var postes = card.dataset.postes || '';
    card.style.display = (nom.includes(q) || postes.includes(q)) ? '' : 'none';
  });
  // Masque les blocs filière vides
  document.querySelectorAll('.offres-filiere-block').forEach(function(block) {
    var visible = Array.from(block.querySelectorAll('.offres-card')).some(function(c) { return c.style.display !== 'none'; });
    block.style.display = visible ? '' : 'none';
  });
}

function toggleOffresEdit(companyId) {
  var zone = document.getElementById('offres-edit-' + companyId);
  if (!zone) return;
  var open = zone.style.display !== 'none';
  zone.style.display = open ? 'none' : 'block';
  if (!open) document.getElementById('offres-ta-' + companyId).focus();
}

async function savePosteAlternance(companyId) {
  var ta = document.getElementById('offres-ta-' + companyId);
  if (!ta) return;
  var postes = ta.value.split('\n').map(function(p) { return p.trim(); }).filter(function(p) { return p.length > 0; });
  try {
    var res = await fetch('/api/offres-alternance/' + companyId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: crePin, postes: postes })
    });
    if (!res.ok) throw new Error('Erreur serveur');
    // Met à jour le store local
    var entry = _offresData.find(function(c) { return c.id === companyId; });
    if (entry) entry.postes = postes;
    // Rafraîchit l'affichage de ce seul card
    var postesDiv = document.getElementById('offres-postes-' + companyId);
    if (postesDiv) {
      postesDiv.innerHTML = postes.length
        ? postes.map(function(p) { return '<span class="offres-poste-tag">' + p + '</span>'; }).join('')
        : '<span class="offres-no-poste">Aucun poste renseigné</span>';
    }
    var card = document.querySelector('.offres-card[data-company-id="' + companyId + '"]');
    if (card) card.dataset.postes = postes.join(' ').toLowerCase();
    toggleOffresEdit(companyId);
    showToast('✅ Postes enregistrés', 'success');
  } catch(e) {
    showToast('❌ Erreur : ' + e.message, 'error');
  }
}

// ===== OFFRES ALTERNANCE — VUE CANDIDAT (lecture seule) =====
var _studentOffresData = [];
var _studentEntretiensData = [];

function switchStudentView(view) {
  document.getElementById('stab-entreprises').classList.toggle('active', view === 'entreprises');
  document.getElementById('stab-offres').classList.toggle('active', view === 'offres');
  var stabEnt = document.getElementById('stab-entretiens');
  if (stabEnt) stabEnt.classList.toggle('active', view === 'entretiens');
  document.getElementById('student-companies-view').style.display = view === 'entreprises' ? '' : 'none';
  document.getElementById('student-offres-view').style.display = view === 'offres' ? 'block' : 'none';
  var entView = document.getElementById('student-entretiens-view');
  if (entView) entView.style.display = view === 'entretiens' ? 'block' : 'none';
  if (view === 'offres') loadStudentOffres();
  if (view === 'entretiens') loadStudentEntretiens();
}

async function loadStudentOffres() {
  var container = document.getElementById('student-offres-container');
  if (container) container.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center">⏳ Chargement…</div>';
  try {
    var res = await fetch('/api/offres-alternance-public');
    _studentOffresData = await res.json();
    renderStudentOffres(_studentOffresData);
  } catch(e) {
    if (container) container.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center;color:#ef4444">Erreur de chargement</div>';
  }
}

function renderStudentOffres(data) {
  var container = document.getElementById('student-offres-container');
  if (!container) return;
  if (!data || !data.length) {
    container.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center">Aucune offre disponible pour le moment</div>';
    return;
  }
  var groups = {};
  data.forEach(function(c) {
    if (!c.postes || !c.postes.length) return; // N'affiche que les entreprises avec des postes
    var f = c.filiere || 'AUTRE';
    if (!groups[f]) groups[f] = [];
    groups[f].push(c);
  });
  if (!Object.keys(groups).length) {
    container.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center">Aucune offre renseignée pour le moment</div>';
    return;
  }
  var html = '';
  Object.keys(groups).sort().forEach(function(filiere) {
    var color = FILIERE_COLORS[filiere] || '#94a3b8';
    var label = FILIERE_LABELS[filiere] || filiere;
    html += '<div class="offres-filiere-block">';
    html += '<div class="offres-filiere-header" style="border-left:4px solid ' + color + '">' + label + '</div>';
    html += '<div class="offres-cards">';
    groups[filiere].forEach(function(c) {
      var logoHtml = c.logoFile
        ? '<img src="/images/logos/' + c.logoFile + '" class="offres-logo" onerror="this.style.display=\'none\'">'
        : '<div class="offres-logo-fallback" style="background:' + color + '">' + (c.nomAffichage||c.nom||'').substring(0,2).toUpperCase() + '</div>';
      var nom = c.nomAffichage || c.nom || '';
      var postes = c.postes || [];
      var postesHtml = postes.map(function(p) { return '<span class="offres-poste-tag">' + p + '</span>'; }).join('');
      html += '<div class="offres-card" data-nom="' + nom.toLowerCase() + '" data-postes="' + postes.join(' ').toLowerCase() + '">';
      html += '<div class="offres-card-head">' + logoHtml + '<span class="offres-card-nom">' + nom + '</span></div>';
      html += '<div class="offres-postes">' + postesHtml + '</div>';
      html += '</div>';
    });
    html += '</div></div>';
  });
  container.innerHTML = html;
}

function filterStudentOffres(query) {
  var q = (query || '').toLowerCase().trim();
  var cards = document.querySelectorAll('#student-offres-container .offres-card');
  cards.forEach(function(card) {
    if (!q) { card.style.display = ''; return; }
    var nom = card.dataset.nom || '';
    var postes = card.dataset.postes || '';
    card.style.display = (nom.includes(q) || postes.includes(q)) ? '' : 'none';
  });
  document.querySelectorAll('#student-offres-container .offres-filiere-block').forEach(function(block) {
    var visible = Array.from(block.querySelectorAll('.offres-card')).some(function(c) { return c.style.display !== 'none'; });
    block.style.display = visible ? '' : 'none';
  });
}

// ── Mes entretiens (vue candidat) ────────────────────────────────────────────

async function loadStudentEntretiens() {
  var container = document.getElementById('student-entretiens-container');
  if (container) container.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center">⏳ Chargement…</div>';
  try {
    var res = await fetch('/api/entretiens-public');
    _studentEntretiensData = await res.json();
    renderStudentEntretiens(_studentEntretiensData);
  } catch(e) {
    if (container) container.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center;color:#ef4444">Erreur de chargement</div>';
  }
}

function renderStudentEntretiens(data) {
  var container = document.getElementById('student-entretiens-container');
  if (!container) return;
  if (!data || !data.length) {
    container.innerHTML = '<div class="empty-state" style="padding:2rem;text-align:center;color:#64748b">Aucun candidat inscrit pour l\'instant.</div>';
    return;
  }
  var rows = data.map(function(s) {
    var nb = s.companies ? s.companies.length : 0;
    var did = 'ent_' + (s.nom + '_' + s.prenom).replace(/[^a-z0-9]/gi, '_');
    var compRows = (s.companies || []).map(function(c) {
      return '<tr class="stu-comp-row">' +
        '<td>' + (c.nom||'—') + '</td>' +
        '<td><span class="filiere-tag" style="background:' + (FILIERE_COLORS[c.filiere]||'#94a3b8') + ';color:#fff;font-size:0.68rem;padding:1px 6px;border-radius:4px">' + (c.filiere||'') + '</span></td>' +
        '</tr>';
    }).join('');
    return '<tr class="stu-main-row entretien-row" data-candidat="' + ((s.prenom||'') + ' ' + (s.nom||'')).toLowerCase() + '" data-companies="' + (s.companies||[]).map(function(c){return (c.nom||'').toLowerCase();}).join(' ') + '" onclick="toggleStudentEntretienDetail(\'' + did + '\')">' +
      '<td class="td-company"><span class="stu-arrow" id="arr_' + did + '">▸</span> <strong>' + (s.prenom||'') + ' ' + (s.nom||'') + '</strong></td>' +
      '<td class="td-num">' +
        (nb ? '<span class="entretien-nb-badge" onclick="event.stopPropagation();toggleStudentEntretienDetail(\'' + did + '\')">' + nb + ' 🏢</span>' : '—') +
      '</td>' +
      '</tr>' +
      '<tr id="' + did + '" style="display:none" class="entretien-detail-row">' +
        '<td colspan="2" style="padding:0;background:#f8fafc">' +
          '<table class="stu-inner-table"><thead><tr><th>Entreprise</th><th>Filière</th></tr></thead>' +
          '<tbody>' + compRows + '</tbody></table>' +
        '</td>' +
      '</tr>';
  }).join('');

  container.innerHTML =
    '<table class="admin-table entretiens-table"><thead><tr>' +
    '<th>Candidat(e)</th>' +
    '<th class="th-num">Entreprises</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function toggleStudentEntretienDetail(id) {
  var row = document.getElementById(id); if (!row) return;
  var open = row.style.display !== 'none';
  row.style.display = open ? 'none' : 'table-row';
  var arrow = document.getElementById('arr_' + id);
  if (arrow) arrow.textContent = open ? '▸' : '▾';
}

function filterStudentEntretiens(query) {
  var q = (query || '').toLowerCase().trim();
  var rows = document.querySelectorAll('#student-entretiens-container .entretien-row');
  rows.forEach(function(row) {
    if (!q) { row.style.display = ''; return; }
    var cand = row.dataset.candidat || '';
    var comps = row.dataset.companies || '';
    var match = cand.includes(q) || comps.includes(q);
    row.style.display = match ? '' : 'none';
    // hide detail row if parent hidden
    var did = row.querySelector('.stu-arrow') ? row.querySelector('.stu-arrow').id.replace('arr_','') : null;
    if (did) {
      var detail = document.getElementById(did);
      if (detail && !match) detail.style.display = 'none';
    }
  });
}

function exportSheetCandidates() {
  window.open('/api/sheet-candidates/export?pin=' + encodeURIComponent(crePin), '_blank');
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

async function loadAutocompleteList(pin) {
  try {
    const res = await fetch('/api/sheet-candidates/list?pin=' + encodeURIComponent(pin));
    const data = await res.json();
    if (Array.isArray(data)) autocompleteList = data;
  } catch(e) {}
}

function showAutocomplete(query, listId, onSelect) {
  const listEl = document.getElementById(listId);
  if (!listEl) return;
  if (!query || query.length < 2) { listEl.style.display = 'none'; return; }
  const q = query.toLowerCase();
  const matches = autocompleteList.filter(function(c) {
    return (c.nom||'').toLowerCase().includes(q) ||
           (c.prenom||'').toLowerCase().includes(q) ||
           (c.email||'').toLowerCase().includes(q);
  }).slice(0, 8);
  if (!matches.length) { listEl.style.display = 'none'; return; }
  listEl.innerHTML = matches.map(function(c, i) {
    return '<div class="autocomplete-item" onmousedown="event.preventDefault()" onclick="selectAutocompleteItem(' + i + ',\'' + listId + '\')">' +
      '<strong>' + c.nom + ' ' + (c.prenom||'') + '</strong>' +
      '<span class="ac-sub">' + (c.diplome || c.domaines || '') + '</span>' +
    '</div>';
  }).join('');
  listEl._matches = matches;
  listEl._onSelect = onSelect;
  listEl.style.display = 'block';
}

function selectAutocompleteItem(idx, listId) {
  const listEl = document.getElementById(listId);
  if (!listEl || !listEl._matches) return;
  const c = listEl._matches[idx];
  if (listEl._onSelect) listEl._onSelect(c);
  listEl.style.display = 'none';
}

function handleCREAutocomplete(query) {
  showAutocomplete(query, 'cre-autocomplete-list', function(c) {
    const nomEl = document.getElementById('student-nom');
    const prenomEl = document.getElementById('student-prenom');
    const formationEl = document.getElementById('student-formation');
    if (nomEl) nomEl.value = c.nom;
    if (prenomEl) prenomEl.value = c.prenom;
    if (formationEl) formationEl.value = c.diplome || c.domaines || '';
    const searchEl = document.getElementById('cre-autocomplete-search');
    if (searchEl) searchEl.value = c.nom + ' ' + (c.prenom||'');
    document.getElementById('cre-autocomplete-list').style.display = 'none';
  });
}

function handleEntAutocomplete(query) {
  showAutocomplete(query, 'ent-autocomplete-list', function(c) {
    const nomEl = document.getElementById('ent-nom');
    const prenomEl = document.getElementById('ent-prenom');
    const formationEl = document.getElementById('ent-formation');
    const emailEl = document.getElementById('ent-email');
    const phoneEl = document.getElementById('ent-phone');
    if (nomEl) nomEl.value = c.nom;
    if (prenomEl) prenomEl.value = c.prenom;
    if (formationEl) formationEl.value = c.diplome || c.domaines || '';
    if (emailEl) emailEl.value = c.email || '';
    if (phoneEl) phoneEl.value = c.tel || '';
    const searchEl = document.getElementById('ent-autocomplete-search');
    if (searchEl) searchEl.value = c.nom + ' ' + (c.prenom||'');
    document.getElementById('ent-autocomplete-list').style.display = 'none';
  });
}

// Close autocomplete when clicking outside
document.addEventListener('click', function(e) {
  ['cre-autocomplete-list','ent-autocomplete-list'].forEach(function(id) {
    const el = document.getElementById(id);
    if (el && !el.contains(e.target)) el.style.display = 'none';
  });
});

// ═══════════════════════════════════════════════════════════
//  JE M'INSCRIS — Formulaire & Soumission
// ═══════════════════════════════════════════════════════════

let _srCurrentCompany = null;

function openSrForm(companyId) {
  _srCurrentCompany = companyId ? companies.find(c => c.id === companyId) : null;
  const modal = document.getElementById('modal-sr-form');

  // Reset form
  ['sr-nom','sr-prenom','sr-email','sr-tel','sr-diplome','sr-ecole','sr-domaines'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('sr-form-error').style.display = 'none';

  // Header entreprise
  const header = document.getElementById('sr-form-company-header');
  if (_srCurrentCompany) {
    header.style.display = 'flex';
    const company = _srCurrentCompany;
    const color = FILIERE_COLORS[company.filiere] || '#94a3b8';
    const initials = getInitials(company.nomAffichage || company.nom);
    const logoEl = document.getElementById('sr-form-logo');
    const fallbackEl = document.getElementById('sr-form-logo-fallback');
    if (company.logoFile) {
      logoEl.src = `/images/logos/${company.logoFile}`;
      logoEl.style.display = 'block';
      fallbackEl.style.display = 'none';
    } else {
      logoEl.style.display = 'none';
      fallbackEl.style.display = 'flex';
      fallbackEl.style.background = color;
      fallbackEl.textContent = initials;
    }
    document.getElementById('sr-form-company-name').textContent = company.nomAffichage || company.nom;
    document.getElementById('sr-form-company-filiere').textContent = company.filiere || '';
    document.getElementById('sr-form-company-filiere').style.color = color;
  } else {
    header.style.display = 'none';
  }

  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => { const el = document.getElementById('sr-nom'); if (el) el.focus(); }, 100);
}

function closeSrForm() {
  document.getElementById('modal-sr-form').classList.remove('open');
  document.body.style.overflow = '';
}

async function submitSelfReg() {
  const nom    = (document.getElementById('sr-nom').value || '').trim();
  const prenom = (document.getElementById('sr-prenom').value || '').trim();
  const email  = (document.getElementById('sr-email').value || '').trim();
  const tel    = (document.getElementById('sr-tel').value || '').trim();
  const diplome = (document.getElementById('sr-diplome').value || '').trim();
  const ecole   = (document.getElementById('sr-ecole').value || '').trim();
  const domaines = (document.getElementById('sr-domaines').value || '').trim();
  const errEl  = document.getElementById('sr-form-error');

  if (!nom || !prenom) {
    errEl.textContent = 'Veuillez renseigner au minimum votre nom et prénom.';
    errEl.style.display = 'block'; return;
  }
  if (email && !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    errEl.textContent = 'Adresse email invalide.';
    errEl.style.display = 'block'; return;
  }
  errEl.style.display = 'none';

  const submitBtn = document.querySelector('.btn-sr-submit');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '⏳ Enregistrement…'; }

  try {
    const res = await fetch('/api/self-register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nom, prenom, email, telephone: tel, diplome, ecole, domainesInteret: domaines,
        companyId: _srCurrentCompany ? _srCurrentCompany.id : null,
        companyName: _srCurrentCompany ? (_srCurrentCompany.nomAffichage || _srCurrentCompany.nom) : ''
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      errEl.textContent = data.error || 'Erreur serveur.';
      errEl.style.display = 'block';
    } else {
      closeSrForm();
      document.getElementById('modal-sr-success').classList.add('open');
    }
  } catch(e) {
    errEl.textContent = 'Erreur réseau. Vérifiez votre connexion.';
    errEl.style.display = 'block';
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '✅ Valider mon inscription'; }
  }
}

function closeSrSuccess() {
  document.getElementById('modal-sr-success').classList.remove('open');
}
function closeSrSuccessAndStay() {
  document.getElementById('modal-sr-success').classList.remove('open');
  _srCurrentCompany = null;
}
function closeSrSuccessGoHome() {
  document.getElementById('modal-sr-success').classList.remove('open');
  goHome();
}

// ═══════════════════════════════════════════════════════════
//  CRE — Inscriptions sur place (validation)
// ═══════════════════════════════════════════════════════════

let _pendingSelfRegs = [];

async function loadPendingSelfRegs() {
  try {
    const res = await fetch('/api/self-register/pending?pin=' + encodeURIComponent(crePin));
    const data = await res.json();
    if (data.error) return;
    _pendingSelfRegs = data.registrations || [];
    renderPendingSelfRegs();
  } catch(e) { /* silencieux */ }
}

function renderPendingSelfRegs() {
  const section = document.getElementById('sr-pending-section');
  const listEl  = document.getElementById('sr-pending-list');
  const countEl = document.getElementById('sr-pending-count');
  if (!section || !listEl) return;

  if (!_pendingSelfRegs.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  if (countEl) countEl.textContent = _pendingSelfRegs.length;

  listEl.innerHTML = _pendingSelfRegs.map(function(r) {
    const d = r.createdAt ? new Date(r.createdAt).toLocaleString('fr-FR', {hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'}) : '';
    const compBadge = r.companyName ? `<span class="sr-pend-company">🏢 ${r.companyName}</span>` : '';
    return `<div class="sr-pending-card" id="srpend-${r.id}">
      <div class="sr-pend-info">
        <div class="sr-pend-name">${r.nom} ${r.prenom}</div>
        <div class="sr-pend-details">
          ${r.email ? `<span>✉️ ${r.email}</span>` : ''}
          ${r.telephone ? `<span>📱 ${r.telephone}</span>` : ''}
          ${r.diplome ? `<span>🎓 ${r.diplome}</span>` : ''}
          ${r.ecole ? `<span>🏫 ${r.ecole}</span>` : ''}
          ${r.domainesInteret ? `<span>💼 ${r.domainesInteret}</span>` : ''}
          ${compBadge}
          ${d ? `<span class="sr-pend-date">🕐 ${d}</span>` : ''}
        </div>
      </div>
      <div class="sr-pend-actions">
        <button class="btn-sr-validate" onclick="validateSelfReg('${r.id}')">✅ Valider</button>
        <button class="btn-sr-reject" onclick="rejectSelfReg('${r.id}')">❌ Refuser</button>
      </div>
    </div>`;
  }).join('');
}

async function validateSelfReg(id) {
  try {
    const res = await fetch('/api/self-register/' + id + '/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: crePin })
    });
    const data = await res.json();
    if (!res.ok) { showToast('❌ ' + (data.error || 'Erreur'), 'error'); return; }
    // Retirer de la liste en attente
    _pendingSelfRegs = _pendingSelfRegs.filter(r => r.id !== id);
    renderPendingSelfRegs();
    // Rafraîchir la liste des candidats pour inclure ce nouveau validé
    await loadSheetCandidates(true);
    const c = data.candidate;
    showToast(`✅ ${c ? c.prenom + ' ' + c.nom : ''} validé(e) — ajouté(e) aux candidats`, 'success');
  } catch(e) { showToast('❌ Erreur réseau', 'error'); }
}

async function rejectSelfReg(id) {
  if (!confirm('Refuser cette inscription ? Le(la) candidat(e) devra compléter le formulaire officiel d\'inscription.')) return;
  try {
    const res = await fetch('/api/self-register/' + id + '/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: crePin })
    });
    const data = await res.json();
    if (!res.ok) { showToast('❌ ' + (data.error || 'Erreur'), 'error'); return; }
    _pendingSelfRegs = _pendingSelfRegs.filter(r => r.id !== id);
    renderPendingSelfRegs();
    showToast('Inscription refusée', '');
  } catch(e) { showToast('❌ Erreur réseau', 'error'); }
}

function exportSelfRegs() {
  window.open('/api/self-register/export?pin=' + encodeURIComponent(crePin), '_blank');
}

async function deleteSelfRegCandidate(selfRegisteredId) {
  if (!confirm('Annuler la validation de cette inscription sur place ?\nLe(la) candidat(e) sera retiré(e) de la liste des candidats.')) return;
  try {
    const res = await fetch('/api/self-register/' + selfRegisteredId, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: crePin })
    });
    const data = await res.json();
    if (!res.ok) { showToast('❌ ' + (data.error || 'Erreur'), 'error'); return; }
    await loadSheetCandidates(true);
    showToast('🗑️ Inscription annulée', '');
  } catch(e) { showToast('❌ Erreur réseau', 'error'); }
}

// ===== START =====
init();
