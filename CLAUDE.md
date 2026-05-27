# CLEM Formation - CRM Parcoursup

## Projet

CRM de suivi des candidats Parcoursup pour **CLEM Formation**. Fork du projet `salon-alternance` (Will.School / Noschool Bordeaux), rebrandé et adapté CLEM.

Fonctions principales : suivi Kanban des candidats, automatisations email + WhatsApp, modèles personnalisables, courriers PDF, anti-ban WhatsApp.

## Stack

- **Backend:** Node.js + Express
- **Frontend:** React 18 + Babel via CDN (pas de build step)
- **Stockage:** Fichiers JSON locaux dans `data/`
- **Communication:** Nodemailer (email), whatsapp-web.js (WhatsApp via Chromium)
- **UI:** CSS custom, Font Awesome 6.5, Google Fonts (Inter)

## Architecture - 4 serveurs

| Serveur | Fichier | Port | Rôle |
|---------|---------|------|------|
| Principal | `server.js` | 3010 | Job dating (non utilisé pour CLEM par défaut) |
| Admission Hub | `admission-server.js` | 3011 | Hub admission (non utilisé pour CLEM par défaut) |
| **Parcoursup** | `parcoursup-server.js` | **3012** | **CRM admissions, automations, WhatsApp** ← cœur CLEM |
| Cockpit | `cockpit-server.js` | 3013 | Tableau de bord global (Puppeteer) |

## Démarrage local

```bash
npm install
cp .env.parcoursup.example .env.parcoursup
# Remplir SMTP_USER / SMTP_PASS dans .env.parcoursup
npm run start:parcoursup     # http://localhost:3012/parcoursup
```

PIN par défaut : `CLEM2026` (à changer en prod via `PARCOURSUP_PIN` dans `.env.parcoursup`)

## Couleurs CLEM

- **Accent** : `#DDDF4B` (jaune-vert officiel, RGB 221/223/75)
- **Texte/CTA** : noir / gris foncé
- Le bleu marine de l'origine Will/Noschool a été remplacé par du noir pour lisibilité.

## Conventions

- **JS:** camelCase pour variables, UPPERCASE pour constantes
- **HTML/CSS:** kebab-case
- **Langue:** Code et UI en français
- **Auth:** PINs simples (pas de comptes utilisateurs)
- **Exports:** CSV UTF-8 BOM (compatibilité Excel)

## Points d'attention

- WhatsApp nécessite un scan QR initial — dégradation gracieuse si indisponible
- Le fichier `parcoursup-server.js` fait ~2000 lignes, `parcoursup.html` ~4080 lignes : lire avec offset/limit
- Frontend Parcoursup = React via CDN + Babel (pas de build step)
- Données sensibles dans `/data/` et `.env.parcoursup` — jamais committer (dans .gitignore)

## Appli en ligne

- **URL Parcoursup :** http://51.77.223.57:3012/parcoursup
- **PIN d'accès :** `CLEM2026`
- **Health check :** http://51.77.223.57:3012/health
- **Host :** VPS OVH Starter (partagé avec Will/Noschool), service systemd `parcoursup-clem`
- **Repo GitHub :** `laurentroche-noschool/salon-alternance-clem`

## Déploiement

Deux mécanismes complémentaires :

1. **GitHub Actions `deploy-vps.yml`** : déclenché à chaque push sur `main`. Connexion SSH au VPS (secrets `VPS_HOST`, `VPS_USER`, `VPS_PASSWORD`), `git pull`, sauvegarde + restauration de `data/parcoursup-*.json` et `.env.parcoursup`, `npm install` si `package.json` change, puis `systemctl restart parcoursup-clem`.
2. **Cron `auto-deploy.sh`** : tourne chaque minute sur le VPS. Poll la branche `main`, applique la même procédure si nouveau commit. Filet de sécurité.

**Branche principale :** `main`

```bash
git checkout main
# ... modifications ...
git commit -m "feat: ..."
git push origin main
# Le VPS se met à jour automatiquement sous 1-2 minutes
```

## Configuration spécifique CLEM (à finaliser après le brief)

Choses laissées en placeholder par le bootstrap, à adapter avec CLEM :

1. **Écoles** : dans `parcoursup-server.js` (`DEFAULT_PARCOURSUP_CONFIG.ecoles`), 1 seule entrée "CLEM" avec 4 formations BTS placeholder. À étoffer.
2. **Chargé(e)s d'admission** : `chargesAdmission: []` — vide, à remplir avec les noms des chargé(e)s CLEM.
3. **Conseillers en formation** : à renseigner dans la config (via l'UI ou directement dans le JSON).
4. **Adresses écoles** : dans `public/parcoursup.html` (`ECOLES_ADRESSES`), valeur "A_COMPLETER_CLEM" à remplacer.
5. **SMTP** : remplir `.env.parcoursup` avec compte CLEM.
6. **WhatsApp** : scan QR depuis l'UI (onglet Automatisations) avec un téléphone CLEM.
7. **Modèles emails/WhatsApp** : par défaut hérités, à reformuler depuis l'UI pour le ton CLEM.

## Origine du projet

Fork de `laurentroche-noschool/salon-alternance` (branche `claude/parcoursup-crm-tasks-2GW6m`).
Les améliorations / bug fixes peuvent être portés à la main entre les deux dépôts (cherry-pick), mais les deux applications évoluent désormais indépendamment.
