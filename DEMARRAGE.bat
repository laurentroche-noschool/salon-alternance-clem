@echo off
title Salon Alternance - Demarrage
color 0A
echo.
echo  =========================================
echo   SALON ALTERNANCE - CLEM / CLEM
echo  =========================================
echo.

:: Verifier Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Node.js n'est pas installe !
    echo.
    echo Veuillez installer Node.js depuis : https://nodejs.org
    echo Choisissez la version LTS.
    echo.
    echo Apres installation, relancez ce fichier.
    pause
    start https://nodejs.org
    exit
)

echo [OK] Node.js detecte
echo.

:: Installer les dependances si necessaire
if not exist "node_modules" (
    echo Installation des dependances (1ere fois)...
    npm install
    echo.
)

echo  Application disponible sur :
echo   - Cet ordinateur : http://localhost:3000
echo   - Autres appareils (tablettes, smartphones) :
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set IP=%%a
    setlocal EnableDelayedExpansion
    set IP=!IP: =!
    echo     http://!IP!:3000
    endlocal
)
echo.
echo  PIN CRE par defaut : CRE2025
echo  (modifiable dans server.js ligne 6)
echo.
echo  Appuyez sur Ctrl+C pour arreter le serveur
echo  =========================================
echo.

node server.js
pause
