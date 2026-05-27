#!/bin/bash
# Script d'auto-deploiement execute par cron sur le VPS toutes les 60 secondes.
# Verifie si la branche main a ete mise a jour sur
# GitHub, et si oui fait un pull + restart du service.
#
# Installation (a faire UNE FOIS sur le VPS) :
#   curl -s https://raw.githubusercontent.com/laurentroche-noschool/salon-alternance-clem/main/auto-deploy.sh -o /opt/salon-alternance-clem/auto-deploy.sh
#   chmod +x /opt/salon-alternance-clem/auto-deploy.sh
#   (crontab -l 2>/dev/null; echo "* * * * * /opt/salon-alternance-clem/auto-deploy.sh >> /var/log/auto-deploy-clem.log 2>&1") | crontab -

set -u
REPO_DIR="/opt/salon-alternance-clem"
BRANCH="${DEPLOY_BRANCH:-main}"
LOCK="/tmp/auto-deploy-clem.lock"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')]"

# Evite les executions concurrentes
exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$REPO_DIR" || { echo "$LOG_PREFIX ERREUR: cd $REPO_DIR"; exit 1; }

# Recupere les commits distants sans toucher au working tree
git fetch origin "$BRANCH" --quiet 2>/dev/null || exit 0

LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null)

# Rien a faire si deja a jour
if [ "$LOCAL" = "$REMOTE" ]; then
    exit 0
fi

echo "$LOG_PREFIX Nouveau commit detecte : $LOCAL -> $REMOTE"

# Recupere tout stash precedent pour eviter de perdre .env.parcoursup
git stash pop 2>/dev/null || true

# Backup data ET fichiers env (ne jamais perdre .env.parcoursup)
cp .env.parcoursup /tmp/envp.bak 2>/dev/null || true
cp data/parcoursup-candidates.json /tmp/cand.bak 2>/dev/null || true
cp data/parcoursup-config.json /tmp/cfg.bak 2>/dev/null || true
cp data/parcoursup-relances.json /tmp/rel.bak 2>/dev/null || true
cp data/parcoursup-queue.json /tmp/queue.bak 2>/dev/null || true

# Reset dur sur la branche distante
# IMPORTANT: git stash (sans -u) pour ne PAS stasher les fichiers non-trackes (.env.parcoursup)
git stash 2>/dev/null || true
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"

# Restore data ET env
cp /tmp/envp.bak .env.parcoursup 2>/dev/null || true
cp /tmp/cand.bak data/parcoursup-candidates.json 2>/dev/null || true
cp /tmp/cfg.bak data/parcoursup-config.json 2>/dev/null || true
cp /tmp/rel.bak data/parcoursup-relances.json 2>/dev/null || true
cp /tmp/queue.bak data/parcoursup-queue.json 2>/dev/null || true

# npm install si package.json change
if git diff HEAD@{1} HEAD --name-only 2>/dev/null | grep -q package.json; then
    echo "$LOG_PREFIX package.json modifie, npm install..."
    npm install --no-audit --no-fund 2>&1 | tail -3
fi

# Redemarre le service
systemctl restart parcoursup-clem
sleep 5

# Verifie
if curl -sf --max-time 10 http://localhost:3012/health | grep -q '"status":"ok"'; then
    echo "$LOG_PREFIX DEPLOYED OK : $(git rev-parse --short HEAD)"
else
    echo "$LOG_PREFIX ECHEC health check"
    systemctl status parcoursup-clem --no-pager | head -10
fi
