@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
  echo Starting local server: http://localhost:8000
  start "" "http://localhost:8000"
  python -m http.server 8000
  goto :eof
)

where node >nul 2>nul
if %errorlevel%==0 (
  echo Starting local server: http://localhost:8000
  start "" "http://localhost:8000"
  node -e "const http=require('http'),fs=require('fs'),path=require('path');const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};http.createServer((req,res)=>{let u=decodeURIComponent(req.url.split('?')[0]);if(u==='/')u='/index.html';const f=path.join(process.cwd(),u);if(!f.startsWith(process.cwd()+path.sep)){res.writeHead(403);res.end();return}fs.readFile(f,(err,data)=>{if(err){res.writeHead(404);res.end('404');return}res.writeHead(200,{'Content-Type':types[path.extname(f).toLowerCase()]||'application/octet-stream'});res.end(data)})}).listen(8000,()=>console.log('http://localhost:8000'))"
  goto :eof
)

echo No Python or Node found. Please serve this folder with any static server,
echo e.g. VS Code Live Server, then open index.html in a browser.
pause
