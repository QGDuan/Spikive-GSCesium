@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js not found. Please install Node.js 22.22.1 or later.
  exit /b 1
)
where npm >nul 2>nul || (
  echo npm not found. Please reinstall Node.js with npm.
  exit /b 1
)

node -e "const [a,b,c]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&(b<22||(b===22&&c<1)))){console.error('Node.js 22.22.1 or later is required. Current: '+process.versions.node);process.exit(1)}" || exit /b 1

echo Installing runtime dependencies...
call npm ci --omit=dev --workspace @spikive/server --workspace @spikive/shared --include-workspace-root || exit /b 1
if not exist var mkdir var
echo Installation completed. Run start.cmd and open http://localhost:3000
