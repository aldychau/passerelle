@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
 echo Installez Node.js 24 puis relancez ce fichier.
 pause
 exit /b 1
)
node scripts\launch.mjs
if errorlevel 1 pause
