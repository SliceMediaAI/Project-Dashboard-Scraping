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

const PORT         = process.env.PORT || 3001;
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

// ─── POST TIMES ANALYSE ───────────────────────────────────
// Metriek per platform: TikTok/YouTube → views, Instagram → likes
function analyzePostTimes(platform, postsData, metric) {
  const logFile = path.join(DATA_DIR, 'posttimes_log.json');
  let log = { entries: [], schedule: { tiktok: Array(7).fill(null), instagram: Array(7).fill(null), youtube: Array(7).fill(null) }, last_analyzed: null };
  if (fs.existsSync(logFile)) {
    try { log = JSON.parse(fs.readFileSync(logFile)); } catch(e) {}
  }

  // Voeg nieuwe posts toe aan het logboek (dedupliceer op platform+titel+dag)
  const existing = new Set(log.entries.map(e => `${e.platform}|${e.post_title}|${e.day}`));
  let added = 0;
  (postsData || []).forEach(post => {
    if (!post.timestamp) return;
    const d = new Date(post.timestamp);
    const day  = (d.getDay() + 6) % 7; // 0=Ma … 6=Zo
    const hour = d.getHours();
    const engagement = post[metric] || 0;
    const key = `${platform}|${(post.title||'').substring(0,40)}|${day}`;
    if (!existing.has(key) && engagement > 0) {
      log.entries.push({ platform, day, hour, engagement, metric, post_title: (post.title||'').substring(0,40), logged_at: new Date().toISOString() });
      existing.add(key);
      added++;
    }
  });

  if (added === 0) {
    fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
    return log;
  }

  // Herbereken schema voor dit platform op basis van alle entries
  const byDay = Array.from({length:7}, () => ({ totalEng: 0, totalHour: 0, count: 0 }));
  log.entries.filter(e => e.platform === platform).forEach(e => {
    byDay[e.day].totalEng  += e.engagement;
    byDay[e.day].totalHour += e.hour;
    byDay[e.day].count++;
  });

  // Normaliseer engagement per dag, kies top 3 dagen
  const avgEng = byDay.map((d, i) => ({ day: i, avg: d.count ? d.totalEng / d.count : 0, avgHour: d.count ? Math.round(d.totalHour / d.count) : 12 }));
  const maxAvg = Math.max(...avgEng.map(d => d.avg));
  if (maxAvg === 0) { fs.writeFileSync(logFile, JSON.stringify(log, null, 2)); return log; }

  // Selecteer dagen met minstens 60% van de beste dag
  const threshold = maxAvg * 0.6;
  const newSchedule = Array(7).fill(null);
  avgEng.forEach(d => {
    if (d.avg >= threshold) {
      const h = d.avgHour;
      newSchedule[d.day] = `${String(h).padStart(2,'0')}:00`;
    }
  });
  log.schedule[platform] = newSchedule;
  log.last_analyzed = new Date().toISOString();

  fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
  console.log(`  PostTimes [${platform}]: +${added} posts, schema bijgewerkt`);
  return log;
}

function saveFollowerHistory(platform, followers) {
  const histFile = path.join(DATA_DIR, 'followers_history.json');
  let history = [];
  if (fs.existsSync(histFile)) {
    try { history = JSON.parse(fs.readFileSync(histFile)); } catch(e) {}
  }
  history.push({ platform, followers, timestamp: new Date().toISOString() });
  // Bewaar max 90 dagen
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  history = history.filter(h => h.timestamp > cutoff);
  fs.writeFileSync(histFile, JSON.stringify(history, null, 2));
}

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
    timestamp: item.createTimeISO || null,
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
  // resultsType:'details' returns a profile object with latestPosts nested inside
  const profile = rawItems[0];
  const followers = profile.followersCount || 0;
  const postCount = profile.postsCount || 0;
  const rawPosts = profile.latestPosts || [];
  const posts = rawPosts.slice(0, 10).map(item => {
    const likes    = item.likesCount || 0;
    const comments = item.commentsCount || 0;
    const saves    = item.videoSaveCount || item.saveCount || item.savedCount || item.igtvVideoSaveCount || 0;
    const views    = item.videoViewCount || 0;
    return {
      title: (item.caption || 'Instagram Post').substring(0, 80),
      date: item.timestamp ? new Date(item.timestamp).toLocaleDateString('nl-NL') : '',
      timestamp: item.timestamp || null,
      likes, comments, saves, views,
      engScore: likes + comments + saves,
    };
  });
  const avgLikes = posts.length ? Math.round(posts.reduce((s, p) => s + p.likes, 0) / posts.length) : 0;
  const engRate = followers > 0 && posts.length > 0
    ? ((posts.reduce((s, p) => s + p.likes + p.comments + p.saves, 0) / posts.length / followers) * 100).toFixed(1)
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
    timestamp: item.publishedAt || null,
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
        saveFollowerHistory('tiktok', data.followers);
        analyzePostTimes('tiktok', data.posts_data, 'views');
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
        directUrls: [`https://www.instagram.com/${IG_USERNAME}/`],
        resultsType: 'details',
        resultsLimit: 1
      });
      const data = processInstagram(raw);
      if (data) {
        fs.writeFileSync(path.join(DATA_DIR, 'instagram.json'), JSON.stringify(data, null, 2));
        saveFollowerHistory('instagram', data.followers);
        analyzePostTimes('instagram', data.posts_data, 'engScore');
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
        saveFollowerHistory('youtube', data.subscribers);
        analyzePostTimes('youtube', data.posts_data, 'views');
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

  // ── POST /report/monthly ──────────────────────────────
  if (req.method === 'POST' && url === '/report/monthly') {
    try {
      console.log('  Generating monthly report...');

      // Laad Instagram data
      const igFile  = path.join(DATA_DIR, 'instagram.json');
      const ptFile  = path.join(DATA_DIR, 'posttimes_log.json');
      const fhFile  = path.join(DATA_DIR, 'followers_history.json');

      const ig = fs.existsSync(igFile)  ? JSON.parse(fs.readFileSync(igFile))  : null;
      const pt = fs.existsSync(ptFile)  ? JSON.parse(fs.readFileSync(ptFile))  : null;
      const fh = fs.existsSync(fhFile)  ? JSON.parse(fs.readFileSync(fhFile))  : null;

      if (!ig) throw new Error('Geen Instagram data beschikbaar. Doe eerst een refresh.');

      // Filter posts van de afgelopen 30 dagen (of alle als er niet genoeg zijn)
      const now  = new Date();
      const ago30 = new Date(now - 30 * 24 * 60 * 60 * 1000);
      let posts = (ig.posts_data || []).map(p => ({ ...p, engScore: p.engScore || (p.likes + p.comments + (p.saves||0)) }));
      const recent = posts.filter(p => p.timestamp && new Date(p.timestamp) >= ago30);
      const analysePosts = recent.length >= 3 ? recent : posts;
      analysePosts.sort((a, b) => b.engScore - a.engScore);

      // Follower groei afgelopen 30 dagen
      let followerGrowth = null;
      if (fh) {
        const igHistory = fh.filter(h => h.platform === 'instagram').sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp));
        const oldest30 = igHistory.filter(h => new Date(h.timestamp) <= ago30).pop();
        if (oldest30) followerGrowth = ig.followers - oldest30.followers;
      }

      // Posttijden log samenvatting
      const ptEntries = (pt?.entries || []).filter(e => e.platform === 'instagram');
      const dayNames  = ['Maandag','Dinsdag','Woensdag','Donderdag','Vrijdag','Zaterdag','Zondag'];
      const byDay = Array.from({length:7}, (_,i) => {
        const items = ptEntries.filter(e => e.day === i);
        return { dag: dayNames[i], posts: items.length, gemEng: items.length ? Math.round(items.reduce((s,e)=>s+e.engagement,0)/items.length) : 0 };
      }).filter(d => d.posts > 0).sort((a,b) => b.gemEng - a.gemEng);

      // Bouw de analyse prompt
      const topPosts = analysePosts.slice(0, 5);
      const avgEng   = analysePosts.length ? Math.round(analysePosts.reduce((s,p)=>s+p.engScore,0)/analysePosts.length) : 0;

      const prompt = `Je bent een social media analist voor Slice Media (Instagram: @${IG_USERNAME}).
Analyseer de volgende Instagram data en schrijf een maandrapport in het Nederlands.

ACCOUNT STATUS:
- Volgers: ${ig.followers}
- Totaal posts: ${ig.posts}
${followerGrowth !== null ? `- Follower groei (30d): ${followerGrowth >= 0 ? '+' : ''}${followerGrowth}` : ''}
- Gemiddelde engagement score (likes+comments+saves): ${avgEng}

TOP ${topPosts.length} BEST PRESTERENDE POSTS${recent.length >= 3 ? ' (afgelopen 30 dagen)' : ' (alle beschikbare data)'}:
${topPosts.map((p,i) => `${i+1}. "${p.title}"
   Gepubliceerd: ${p.date} | Dag: ${p.timestamp ? dayNames[(new Date(p.timestamp).getDay()+6)%7] : '?'} | Tijdstip: ${p.timestamp ? new Date(p.timestamp).toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'}) : '?'}
   Likes: ${p.likes} | Comments: ${p.comments} | Saves: ${p.saves||0} | Views: ${p.views||0} | EngScore: ${p.engScore}`).join('\n\n')}

ALLE GEANALYSEERDE POSTS (${analysePosts.length} stuks):
${analysePosts.map(p => `- "${p.title.substring(0,60)}" → EngScore ${p.engScore} (${p.date})`).join('\n')}

BESTE POSTDAGEN (op basis van historische engagement):
${byDay.slice(0,4).map(d => `- ${d.dag}: gem. ${d.gemEng} engagement (${d.posts} posts)`).join('\n') || '- Nog niet genoeg data'}

Schrijf het rapport in deze structuur:

## Wat werkte goed
Analyseer de top posts. Kijk naar: thema, format-signalen (bijv. "COMMENT voor link", vragen stellen, storytelling), toon, tijdstip. Wat hebben de best presterende posts gemeen?

## Patronen in alle content
Wat zie je breed over alle posts? Welke thema's/formats scoren consistent? Wat valt juist tegen?

## Maandadvies
Geef 4-5 concrete, actiegerichte adviezen voor de komende maand. Gebaseerd op de data. Kort en direct.

Schrijf in jouw-stijl: professioneel maar direct. Geen wollig taalgebruik.`;

      let analyse = '';
      try {
        analyse = await generateWithClaude(prompt, 'Je bent een scherpe social media analist. Schrijf altijd in het Nederlands. Geen opsommingen met bullets tenzij gevraagd. Gebruik koppen zoals aangegeven.');
      } catch(e) {
        analyse = `_Claude CLI niet beschikbaar: ${e.message}_\n\nInstalleer de Claude CLI om AI-analyse te activeren.`;
      }

      const report = {
        generated_at: new Date().toISOString(),
        period: recent.length >= 3 ? 'laatste 30 dagen' : 'alle beschikbare data',
        account: { followers: ig.followers, follower_growth_30d: followerGrowth },
        top_posts: topPosts,
        avg_engagement: avgEng,
        posts_analyzed: analysePosts.length,
        best_days: byDay.slice(0,4),
        analyse,
      };

      fs.writeFileSync(path.join(DATA_DIR, 'monthly_report.json'), JSON.stringify(report, null, 2));
      console.log('  Monthly report generated.');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch(e) {
      console.error('Monthly report error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /debug/instagram ───────────────────────────────
  if (req.method === 'GET' && url === '/debug/instagram') {
    try {
      const raw = await runApifyActor(IG_ACTOR_ID, {
        usernames: [IG_USERNAME], resultsType: 'posts', resultsLimit: 3
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: raw.length, first_item: raw[0] || null, keys_first: raw[0] ? Object.keys(raw[0]) : [] }, null, 2));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /topics ────────────────────────────────────────
  if (req.method === 'GET' && url === '/topics') {
    const topicsFile = path.join(__dirname, 'data', 'topics.json');
    if (fs.existsSync(topicsFile)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(topicsFile));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
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
