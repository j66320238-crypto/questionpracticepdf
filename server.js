/* Mock Exam Pro — minimal static server for Render / any Node host.
   Zero dependencies. Serves the app and exposes:
   - GET  /api/ai-config : AI keys from env vars (GEMINI_API_KEYS, GROQ_API_KEYS,
                           OPENAI_API_KEYS — comma/newline separated, multiple ok)
                           + community-donated keys (donated-keys.json)
   - GET  /api/donate    : count of donated community keys
   - POST /api/donate    : donate a key to the shared community pool
                           {key: "...", name: "optional"}
                           Key is auto-classified by prefix:
                           AIza…/AQ.… → gemini, gsk_… → groq, sk-… → openai
                           (invalid/unknown/duplicate keys are rejected) */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8090;
const ROOT = __dirname;
const DONATE_FILE = path.join(ROOT, 'donated-keys.json');
const MAX_DONATED = 100;          // hard cap for the community pool
const MAX_DONATE_PER_HOUR = 10;   // per-IP rate limit (abuse guard)

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
function classifyKey(k){
  if(/^AIza/i.test(k) || /^AQ\./i.test(k)) return 'gemini';
  if(/^gsk_/i.test(k)) return 'groq';
  if(/^sk-/i.test(k)) return 'openai';
  return null;
}
function loadDonated(){
  try{
    const j = JSON.parse(fs.readFileSync(DONATE_FILE, 'utf8'));
    if(Array.isArray(j.keys)) return j.keys.filter(e => e && typeof e.key === 'string' && classifyKey(e.key));
  }catch(e){ /* no file yet / corrupt — start fresh */ }
  return [];
}
function saveDonated(keys){
  try{ fs.writeFileSync(DONATE_FILE, JSON.stringify({ updated: Date.now(), keys }, null, 1)); }
  catch(e){ console.error('[donate] save failed:', e.message); }
}
function json(res, code, obj){
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

// per-IP donate rate limit (in-memory; resets on restart — good enough for a study tool)
const donateHits = {};
function rateLimited(ip){
  const now = Date.now();
  const arr = (donateHits[ip] = (donateHits[ip] || []).filter(t => now - t < 3600e3));
  if(arr.length >= MAX_DONATE_PER_HOUR) return true;
  arr.push(now);
  return false;
}

function envKeys(){
  return {
    gemini: splitKeys(process.env.GEMINI_API_KEYS),
    groq: splitKeys(process.env.GROQ_API_KEYS),
    openai: splitKeys(process.env.OPENAI_API_KEYS)
  };
}

function handleDonate(req, res){
  let body = '';
  req.on('data', c => { body += c; if(body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let j;
    try{ j = JSON.parse(body || '{}'); }catch(e){ return json(res, 400, {ok:false, error:'Invalid JSON.'}); }
    const key = String(j.key || '').trim();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
    if(!key) return json(res, 400, {ok:false, error:'No key provided.'});
    if(key.length < 10 || key.length > 400) return json(res, 400, {ok:false, error:'Key length looks wrong (10–400 chars expected).'});
    if(/\s/.test(key)) return json(res, 400, {ok:false, error:'Key contains spaces — paste exactly one key.'});
    const provider = classifyKey(key);
    if(!provider) return json(res, 400, {ok:false, error:'Unrecognized key. Expected a Gemini (AIza…/AQ.…), Groq (gsk_…) or OpenAI (sk-…) key.'});
    if(rateLimited(ip)) return json(res, 429, {ok:false, error:'Too many donations from your connection in the last hour. Try later.'});

    const keys = loadDonated();
    const env = envKeys();
    const allEnv = env.gemini.concat(env.groq, env.openai);
    if(allEnv.includes(key)) return json(res, 409, {ok:false, error:'This key is already in the server env — no need to donate it.'});
    if(keys.some(e => e.key === key)) return json(res, 409, {ok:false, error:'This key was already donated. Thanks anyway!'});
    if(keys.length >= MAX_DONATED) return json(res, 507, {ok:false, error:'Community pool is full (' + MAX_DONATED + ' keys). Try again later.'});

    const name = String(j.name || '').replace(/[^\w .-]/g, '').slice(0, 24) || 'anonymous';
    keys.push({ key, provider, name, ts: Date.now() });
    saveDonated(keys);
    console.log('[donate] +' + provider + ' key from ' + ip + ' (pool: ' + keys.length + ')');
    json(res, 200, {ok:true, provider, total: keys.length, message: 'Key added to the community pool — it now rotates for everyone.'});
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if(req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if(url.pathname === '/api/ai-config'){
    const env = envKeys();
    const keys = loadDonated();
    const community = { gemini: 0, groq: 0, openai: 0 };
    keys.forEach(e => { community[e.provider] = (community[e.provider] || 0) + 1; });
    const cfg = {
      source: 'server',
      gemini: env.gemini.concat(keys.filter(e => e.provider === 'gemini').map(e => e.key)),
      groq: env.groq.concat(keys.filter(e => e.provider === 'groq').map(e => e.key)),
      openai: env.openai.concat(keys.filter(e => e.provider === 'openai').map(e => e.key)),
      community
    };
    const n = cfg.gemini.length + cfg.groq.length + cfg.openai.length;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(cfg));
    console.log('[ai-config] served ' + n + ' key(s) to browser (' + keys.length + ' donated)');
    return;
  }

  if(url.pathname === '/api/donate' && req.method === 'POST'){
    return handleDonate(req, res);
  }

  if(url.pathname === '/api/donate'){
    const keys = loadDonated();
    const c = { gemini: 0, groq: 0, openai: 0 };
    keys.forEach(e => { c[e.provider] = (c[e.provider] || 0) + 1; });
    return json(res, 200, { ok: true, total: keys.length, counts: c, max: MAX_DONATED });
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
  const env = envKeys();
  const k = env.gemini.length + env.groq.length + env.openai.length;
  console.log('Mock Exam Pro listening on :' + PORT +
    (k ? ' (' + k + ' AI key(s) from env)' : ' (no AI keys in env — add via UI)') +
    ' · donated pool: ' + loadDonated().length + '/' + MAX_DONATED);
});
