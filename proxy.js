/**
 * CTRL Dashboard — Local Proxy Server
 * Run: node proxy.js
 * Open: http://localhost:3001/ai-dashboard.html
 *
 * Features:
 * - Serves alle HTML bestanden statisch
 * - POST /generate → Claude CLI script generator
 * - POST /refresh/tiktok → Apify TikTok scraper
 * - POST /refresh/instagram → Apify Instagram scraper
 * - POST /refresh/youtube → YouTube Data API v3
 * - GET /data/:file → JSON data bestanden
 *
 * Geen npm install nodig — alleen built-in Node.js modules
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');

require('./load-env');

const PORT         = 3001;
const APIFY_TOKEN  = process.env.APIFY_API_TOKEN;
const TT_ACTOR_ID  = process.env.APIFY_TIKTOK_OWN_ACTOR_ID;
const IG_ACTOR_ID  = process.env.APIFY_INSTAGRAM_OWN_ACTOR_ID;
const YT_USERNAME  = process.env.YOUTUBE_USERNAME || 'jouw_youtube_username';
const TT_USERNAME  = process.env.TIKTOK_USERNAME  || 'jouw_tiktok_username';
const IG_USERNAME  = process.env.INSTAGRAM_USERNAME || 'jouw_instagram_username';

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ─── MIME TYPES ───────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ─── CORS HEADERS ─────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── APIFY HELPER ─────────────────────────────────────────
function apifyRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.apify.com',
      path: `/v2${apiPath}?token=${APIFY_TOKEN}`,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runApifyActor(actorId, input) {
  const run = await apifyRequest('POST', `/acts/${actorId}/runs`, input);
  if (!run.data?.id) throw new Error('Actor start failed');
  const runId = run.data.id;
  const datasetId = run.data.defaultDatasetId;

  let status = 'RUNNING';
  let tries = 0;
  while (status === 'RUNNING' && tries < 60) {
    await sleep(5000);
    const s = await apifyRequest('GET', `/actor-runs/${runId}`);
    status = s.data?.status || 'RUNNING';
    tries++;
  }

  if (status !== 'SUCCEEDED') throw new Error(`Actor finished with status: ${status}`);
  const items = await apifyRequest('GET', `/datasets/${datasetId}/items`);
  return Array.isArray(items) ? items : items?.items || [];
}

// ─── DATA PROCESSORS ──────────────────────────────────────
function processTikTok(rawItems) {
  if (!rawItems || rawItems.length === 0) return null;
  const profile = rawItems[0];
  const followers = profile.authorMeta?.fans || profile.followers || 0;
  const postCount = profile.authorMeta?.video || rawItems.length;
  const posts = rawItems.slice(0, 10).map(item => ({
    title: (item.text || 'TikTok Post').substring(0, 80),
    date: item.createTimeISO ? new Date(item.createTimeISO).toLocaleDateString('nl-NL') : '',
    views: item.playCount || 0, likes: item.diggCount || 0, comments: item.commentCount || 0,
  }));
  const avgViews = posts.length ? Math.round(posts.reduce((s, p) => s + p.views, 0) / posts.length) : 0;
  const engRate = followers > 0 && posts.length > 0
    ? ((posts.reduce((s, p) => s + p.likes + p.comments, 0) / posts.length / followers) * 100).toFixed(1)
    : '0.0';
  return { followers, posts: postCount, avgViews, engRate, sparkline: posts.slice(0, 7).reverse().map(p => p.views), posts_data: posts };
}

function processInstagram(rawItems) {
  if (!rawItems || rawItems.length === 0) return null;
  const profile = rawItems.find(i => i.followersCount !== undefined) || rawItems[0];
  const followers = profile.followersCount || 0;
  const postCount = profile.postsCount || rawItems.length;
  const postItems = rawItems.filter(i => i.likesCount !== undefined).slice(0, 10);
  const posts = postItems.map(item => ({
    title: (item.caption || 'Instagram Post').substring(0, 80),
    date: item.timestamp ? new Date(item.timestamp).toLocaleDateString('nl-NL') : '',
    likes: item.likesCount || 0, comments: item.commentsCount || 0,
  }));
  const avgLikes = posts.length ? Math.round(posts.reduce((s, p) => s + p.likes, 0) / posts.length) : 0;
  const engRate = followers > 0 && posts.length > 0
    ? ((posts.reduce((s, p) => s + p.likes + p.comments, 0) / posts.length / followers) * 100).toFixed(1)
    : '0.0';
  return { followers, posts: postCount, avgLikes, engRate, sparkline: posts.slice(0, 7).reverse().map(p => p.likes), posts_data: posts };
}

async function fetchYouTube() {
  const raw = await runApifyActor(process.env.APIFY_YOUTUBE_OWN_ACTOR_ID, {
    startUrls: [{ url: `https://www.youtube.com/@${YT_USERNAME}` }],
    maxVideos: 10,
  });
  if (!raw || raw.length === 0) return null;

  const profile = raw.find(i => i.channelName || i.subscriberCount !== undefined) || raw[0];
  const subscribers = profile.subscriberCount || profile.numberOfSubscribers || 0;
  const videoCount  = profile.videoCount || raw.length;
  const channelName = profile.channelName || profile.title || 'YouTube Channel';

  const videos = raw.filter(i => i.viewCount !== undefined || i.views !== undefined).slice(0, 10).map(item => ({
    title:    (item.title || 'Video').substring(0, 80),
    date:     item.publishedAt ? new Date(item.publishedAt).toLocaleDateString('nl-NL') : '',
    views:    item.viewCount    || item.views    || 0,
    likes:    item.likeCount    || item.likes    || 0,
    comments: item.commentCount || item.comments || 0,
    ctr: '—',
  }));

  const avgViews = videos.length ? Math.round(videos.reduce((s, v) => s + v.views, 0) / videos.length) : 0;
  return { subscribers, videos: videoCount, avgViews, channelName, watchTime: '—', sparkline: videos.slice(0, 7).reverse().map(v => v.views), posts_data: videos };
}

// ─── CLAUDE CLI SCRIPT GENERATOR ──────────────────────────
function generateWithClaude(prompt, system) {
  return new Promise((resolve, reject) => {
    const claude = spawn('claude', ['-p', prompt, '--system', system], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Alternative: pipe via stdin
    let output = '';
    let error  = '';

    claude.stdout.on('data', d => output += d.toString());
    claude.stderr.on('data', d => error  += d.toString());

    claude.on('close', code => {
      if (output.trim()) resolve(output.trim());
      else reject(new Error(error || `Claude exited with code ${code}`));
    });

    claude.on('error', err => {
      reject(new Error('Claude CLI niet gevonden. Zorg dat claude in PATH staat.'));
    });
  });
}

// ─── REQUEST BODY PARSER ──────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ─── HTTP SERVER ──────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const url = req.url.split('?')[0];
  console.log(`${req.method} ${url}`);

  // ── POST /generate ─────────────────────────────────────
  if (req.method === 'POST' && url === '/generate') {
    try {
      const body = await readBody(req);
      const script = await generateWithClaude(
        body.prompt || 'Schrijf een video script',
        body.system || 'Je bent een expert content creator. Schrijf in het Nederlands.'
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ script }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /refresh/tiktok ───────────────────────────────
  if (req.method === 'POST' && url === '/refresh/tiktok') {
    try {
      console.log('  Refreshing TikTok...');
      const raw = await runApifyActor(TT_ACTOR_ID, {
        profiles: [TT_USERNAME], resultsType: 'details', maxItems: 10
      });
      const data = processTikTok(raw);
      if (data) {
        fs.writeFileSync(path.join(DATA_DIR, 'tiktok.json'), JSON.stringify(data, null, 2));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data || { error: 'no_data' }));
    } catch(e) {
      console.error('TikTok refresh error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /refresh/instagram ────────────────────────────
  if (req.method === 'POST' && url === '/refresh/instagram') {
    try {
      console.log('  Refreshing Instagram...');
      const raw = await runApifyActor(IG_ACTOR_ID, {
        usernames: [IG_USERNAME], resultsType: 'posts', resultsLimit: 10
      });
      const data = processInstagram(raw);
      if (data) {
        fs.writeFileSync(path.join(DATA_DIR, 'instagram.json'), JSON.stringify(data, null, 2));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data || { error: 'no_data' }));
    } catch(e) {
      console.error('Instagram refresh error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /refresh/youtube ──────────────────────────────
  if (req.method === 'POST' && url === '/refresh/youtube') {
    try {
      console.log('  Refreshing YouTube...');
      const data = await fetchYouTube();
      if (data) {
        fs.writeFileSync(path.join(DATA_DIR, 'youtube.json'), JSON.stringify(data, null, 2));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data || { error: 'no_youtube_config' }));
    } catch(e) {
      console.error('YouTube refresh error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /data/:file ────────────────────────────────────
  if (req.method === 'GET' && url.startsWith('/data/')) {
    const filename = path.basename(url);
    const filePath = path.join(DATA_DIR, filename);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
    return;
  }

  // ── Static file serving ────────────────────────────────
  let filePath = path.join(__dirname, url === '/' ? '/ai-dashboard.html' : url);
  const ext = path.extname(filePath);

  if (!ext && !url.includes('.')) filePath += '.html';

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const mimeType = MIME[path.extname(filePath)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>404 Not Found</h1>');
  }
});

server.listen(PORT, () => {
  console.log('\n🚀 CTRL Dashboard Proxy Server\n');
  console.log(`   http://localhost:${PORT}/ai-dashboard.html`);
  console.log(`   http://localhost:${PORT}/performance.html`);
  console.log(`   http://localhost:${PORT}/pipeline.html\n`);
  console.log('Endpoints:');
  console.log(`   POST /generate         — Claude script generator`);
  console.log(`   POST /refresh/tiktok   — Live TikTok data`);
  console.log(`   POST /refresh/instagram — Live Instagram data`);
  console.log(`   POST /refresh/youtube  — Live YouTube data`);
  console.log(`   GET  /data/:file       — JSON data bestanden\n`);
  console.log('Ctrl+C om te stoppen\n');
});
