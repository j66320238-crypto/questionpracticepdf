/* Mock Exam Pro — minimal static server for Render / any Node host.
   Zero dependencies. Serves the app and exposes /api/ai-config so AI keys
   can be provided via environment variables (GEMINI_API_KEYS, GROQ_API_KEYS,
   OPENAI_API_KEYS — comma or newline separated, multiple keys allowed). */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8090;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function splitKeys(v){
  return (v || '').split(/[\n,;\t]+/).map(x => x.trim()).filter(Boolean);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/ai-config') {
    const cfg = {
      source: 'server',
      gemini: splitKeys(process.env.GEMINI_API_KEYS),
      groq: splitKeys(process.env.GROQ_API_KEYS),
      openai: splitKeys(process.env.OPENAI_API_KEYS)
    };
    const n = cfg.gemini.length + cfg.groq.length + cfg.openai.length;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(cfg));
    console.log(`[ai-config] served ${n} key(s) to browser`);
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not found: ' + p); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const k = splitKeys(process.env.GEMINI_API_KEYS).length + splitKeys(process.env.GROQ_API_KEYS).length + splitKeys(process.env.OPENAI_API_KEYS).length;
  console.log('Mock Exam Pro listening on :' + PORT + (k ? ' (' + k + ' AI key(s) from env)' : ' (no AI keys in env — add via UI)'));
});
