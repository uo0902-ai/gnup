@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 가 설치되어 있지 않습니다. 사용법.txt 의 1번을 먼저 하세요.
  pause
  exit /b 1
)
if not exist node_modules (
  echo 처음 한 번만 필요한 부품을 설치합니다. 인터넷이 필요합니다...
  call npm install --no-audit --no-fund
)
node server.js
pause
