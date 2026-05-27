#!/bin/bash
# ============================================================
# Script d'installation VPS - CRM Parcoursup
# Pour Ubuntu 24.04+ (OVH VPS Starter)
# ============================================================
# Usage: ssh ubuntu@IP_DU_VPS puis:
#   sudo bash setup-vps.sh
# ============================================================

set -e

# Verifier qu'on est root (ou sudo)
if [ "$EUID" -ne 0 ]; then
  echo "Ce script doit etre lance avec sudo:"
  echo "  sudo bash setup-vps.sh"
  exit 1
fi

echo "=========================================="
echo "  Installation CRM Parcoursup"
echo "=========================================="

# 1. Mise a jour systeme
echo "[1/7] Mise a jour du systeme..."
apt update && apt upgrade -y

# 2. Installer Node.js 20
echo "[2/7] Installation de Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 3. Installer Chromium (pour WhatsApp)
echo "[3/7] Installation de Chromium..."
apt install -y chromium || apt install -y chromium-browser
CHROMIUM_PATH=$(which chromium 2>/dev/null || which chromium-browser 2>/dev/null || echo "/usr/bin/chromium")
echo "Chromium installe: $CHROMIUM_PATH"

# 4. Installer Git
echo "[4/7] Installation de Git..."
apt install -y git

# 5. Cloner le projet CLEM
echo "[5/7] Clonage du projet..."
cd /opt
if [ -d "salon-alternance-clem" ]; then
  echo "Le dossier existe deja, mise a jour..."
  cd salon-alternance-clem
  git pull
else
  git clone https://github.com/laurentroche-noschool/salon-alternance-clem.git
  cd salon-alternance-clem
fi

# 6. Installer les dependances
echo "[6/7] Installation des dependances npm..."
npm install

# Creer le dossier data s'il n'existe pas
mkdir -p data

# 7. Creer le fichier de configuration environnement
echo "[7/7] Configuration..."
cat > /opt/salon-alternance-clem/.env.parcoursup <<'ENVEOF'
# ============ CONFIGURATION CRM PARCOURSUP ============
# Port du serveur
PORT=3012

# Code PIN d'acces (celui que tu donnes a tes equipes)
PARCOURSUP_PIN=CLEM2026

# Configuration SMTP (Gmail) - A REMPLIR avec un compte CLEM
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=A_REMPLIR@clem-formation.fr
SMTP_PASS=A_REMPLIR_APP_PASSWORD
SMTP_FROM_NAME=Service Admissions CLEM
ENVEOF

echo ""
echo ">> Fichier .env.parcoursup cree. Modifie-le si besoin :"
echo "   nano /opt/salon-alternance-clem/.env.parcoursup"
echo ""

# Detecter le chemin Chromium pour systemd
CHROMIUM_BIN=$(which chromium 2>/dev/null || which chromium-browser 2>/dev/null || echo "/usr/bin/chromium")

# Creer le service systemd (demarrage automatique)
cat > /etc/systemd/system/parcoursup-clem.service <<SVCEOF
[Unit]
Description=CRM Parcoursup
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/salon-alternance-clem
EnvironmentFile=/opt/salon-alternance-clem/.env.parcoursup
ExecStart=/usr/bin/node parcoursup-server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# Chromium/Puppeteer needs these
Environment=PUPPETEER_EXECUTABLE_PATH=${CHROMIUM_BIN}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF

# Activer et demarrer le service
systemctl daemon-reload
systemctl enable parcoursup-clem
systemctl start parcoursup-clem

# Installer et configurer le pare-feu
apt install -y ufw
ufw allow 22/tcp
ufw allow 3012/tcp
ufw --force enable

echo ""
echo "=========================================="
echo "  INSTALLATION TERMINEE !"
echo "=========================================="
echo ""
echo "  L'app tourne sur : http://$(hostname -I | awk '{print $1}'):3012/parcoursup"
echo ""
echo "  Commandes utiles :"
echo "    Voir les logs     : journalctl -u parcoursup-clem -f"
echo "    Redemarrer        : systemctl restart parcoursup-clem"
echo "    Arreter           : systemctl stop parcoursup-clem"
echo "    Mettre a jour     : cd /opt/salon-alternance-clem && git pull && systemctl restart parcoursup-clem"
echo ""
echo "  PROCHAINE ETAPE :"
echo "    1. Ouvre http://IP_DU_VPS:3012/parcoursup dans ton navigateur"
echo "    2. Connecte-toi avec le PIN : CLEM2026"
echo "    3. Va dans Automatisations > Connecter WhatsApp"
echo "    4. Scanne le QR Code avec ton telephone"
echo "    5. C'est parti ! Email + WhatsApp 24/7"
echo ""
