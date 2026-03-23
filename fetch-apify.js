/**
 * CTRL Dashboard — Apify Data Sync
 * Run: node fetch-apify.js
 *
 * Haalt echte TikTok & Instagram data op via Apify
 * en slaat het op in data/tiktok.json en data/instagram.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────
require('./load-env'); // laad .env variabelen

const APIFY_TOKEN   = process.env.APIFY_API_TOKEN;
const TT_ACTOR_ID   = process.env.APIFY_TIKTOK_OWN_ACTOR_ID;
const IG_ACTOR_ID   = process.env.APIFY_INSTAGRAM_OWN_ACTOR_ID;

// Vul hier jouw usernames in:
const TIKTOK_USERNAME   = process.env.TIKTOK_USERNAME   || 'jouw_tiktok_username';
const INSTAGRAM_USERNAME = process.env.INSTAGRAM_USERNAME || 'jouw_instagram_username';

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ─── HTTP HELPERS ─────────────────────────────────────────
function apifyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.apify.com',
      path: `/v2${path}?token=${APIFY_TOKEN}`,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.substring(0,100))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── RUN ACTOR & WAIT ─────────────────────────────────────
async function runActor(actorId, input) {
  console.log(`  ▶ Starting actor ${actorId}...`);
  const run = await apifyRequest('POST', `/acts/${actorId}/runs`, input);

  if (!run.data || !run.data.id) {
    throw new Error('Actor start failed: ' + JSON.stringify(run));
  }

  const runId = run.data.id;
  console.log(`  ⏳ Run ID: ${runId} — waiting for completion...`);

  // Poll until finished
  let status = 'RUNNING';
  let attempts = 0;
  while (status === 'RUNNING' && attempts < 60) {
    await sleep(5000);
    const statusResp = await apifyRequest('GET', `/actor-runs/${runId}`);
    status = statusResp.data?.status || 'RUNNING';
    process.stdout.write(`  ↻ Status: ${status}\r`);
    attempts++;
  }

  console.log(`\n  ✓ Finished with status: ${status}`);

  const datasetId = run.data.defaultDatasetId;
  const items = await apifyRequest('GET', `/datasets/${datasetId}/items`);
  return items;
}

// ─── PROCESS TIKTOK DATA ──────────────────────────────────
function processTikTok(rawItems) {
  if (!rawItems || !Array.isArray(rawItems) || rawItems.length === 0) {
    return { followers: 0, posts: 0, avgViews: 0, engRate: '0.0', sparkline: [], posts_data: [] };
  }

  const profile = rawItems[0];
  const followers = profile.authorMeta?.fans || profile.followers || 0;
  const postCount = profile.authorMeta?.video || rawItems.length;

  const posts = rawItems.slice(0, 10).map(item => ({
    title: item.text || item.title || 'TikTok Post',
    date: item.createTimeISO ? new Date(item.createTimeISO).toLocaleDateString('nl-NL') : '',
    views: item.playCount || item.views || 0,
    likes: item.diggCount || item.likes || 0,
    comments: item.commentCount || item.comments || 0,
    shares: item.shareCount || 0,
  }));

  const totalViews = posts.reduce((s, p) => s + p.views, 0);
  const avgViews = posts.length > 0 ? Math.round(totalViews / posts.length) : 0;
  const totalEng = posts.reduce((s, p) => s + p.likes + p.comments, 0);
  const engRate = followers > 0 && posts.length > 0
    ? ((totalEng / posts.length / followers) * 100).toFixed(1)
    : '0.0';

  const sparkline = posts.slice(0, 7).reverse().map(p => p.views);

  return { followers, posts: postCount, avgViews, engRate, sparkline, posts_data: posts };
}

// ─── PROCESS INSTAGRAM DATA ───────────────────────────────
function processInstagram(rawItems) {
  if (!rawItems || !Array.isArray(rawItems) || rawItems.length === 0) {
    return { followers: 0, posts: 0, avgLikes: 0, engRate: '0.0', sparkline: [], posts_data: [] };
  }

  // First item is usually profile data
  const profile = rawItems.find(item => item.followersCount !== undefined) || rawItems[0];
  const followers = profile.followersCount || profile.followers || 0;
  const postCount = profile.postsCount || rawItems.length;

  const postItems = rawItems.filter(item => item.likesCount !== undefined || item.url?.includes('/p/')).slice(0, 10);

  const posts = postItems.map(item => ({
    title: item.caption ? item.caption.substring(0, 60) + '...' : 'Instagram Post',
    caption: item.caption || '',
    date: item.timestamp ? new Date(item.timestamp).toLocaleDateString('nl-NL') : '',
    likes: item.likesCount || item.likes || 0,
    comments: item.commentsCount || item.comments || 0,
    reach: item.reach || 0,
  }));

  const avgLikes = posts.length > 0
    ? Math.round(posts.reduce((s, p) => s + p.likes, 0) / posts.length)
    : 0;
  const totalEng = posts.reduce((s, p) => s + p.likes + p.comments, 0);
  const engRate = followers > 0 && posts.length > 0
    ? ((totalEng / posts.length / followers) * 100).toFixed(1)
    : '0.0';

  const sparkline = posts.slice(0, 7).reverse().map(p => p.likes);

  return { followers, posts: postCount, avgLikes, engRate, sparkline, posts_data: posts };
}

// ─── MAIN ─────────────────────────────────────────────────
async function main() {
  console.log('\n🔄 CTRL Dashboard — Apify Data Sync\n');
  console.log(`TikTok username: @${TIKTOK_USERNAME}`);
  console.log(`Instagram username: @${INSTAGRAM_USERNAME}\n`);

  // Run TikTok and Instagram in parallel
  const [ttRaw, igRaw] = await Promise.all([
    (async () => {
      console.log('📱 Fetching TikTok data...');
      try {
        return await runActor(TT_ACTOR_ID, {
          profiles: [TIKTOK_USERNAME],
          resultsType: 'details',
          maxProfilesPerQuery: 1,
          maxItems: 10,
        });
      } catch(e) {
        console.error('  ✗ TikTok error:', e.message);
        return [];
      }
    })(),
    (async () => {
      console.log('📸 Fetching Instagram data...');
      try {
        return await runActor(IG_ACTOR_ID, {
          usernames: [INSTAGRAM_USERNAME],
          resultsType: 'posts',
          resultsLimit: 10,
        });
      } catch(e) {
        console.error('  ✗ Instagram error:', e.message);
        return [];
      }
    })()
  ]);

  // Process data
  const ttData = processTikTok(Array.isArray(ttRaw) ? ttRaw : ttRaw?.items || []);
  const igData = processInstagram(Array.isArray(igRaw) ? igRaw : igRaw?.items || []);

  // Save to data/
  fs.writeFileSync(path.join(DATA_DIR, 'tiktok.json'), JSON.stringify(ttData, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'instagram.json'), JSON.stringify(igData, null, 2));

  // Also generate a localStorage-inject script
  const injectScript = `
// Auto-generated by fetch-apify.js — ${new Date().toISOString()}
localStorage.setItem('ctrl_tiktok_data', ${JSON.stringify(JSON.stringify(ttData))});
localStorage.setItem('ctrl_instagram_data', ${JSON.stringify(JSON.stringify(igData))});
localStorage.setItem('ctrl_last_refresh', '${Date.now()}');
console.log('✓ Dashboard data loaded from Apify sync');
`;
  fs.writeFileSync(path.join(DATA_DIR, 'inject-data.js'), injectScript);

  console.log('\n✅ Data saved to data/tiktok.json & data/instagram.json');
  console.log('✅ inject-data.js gegenereerd — open browser console en plak dit bestand in, of start proxy.js\n');
  console.log(`📊 TikTok: ${ttData.followers} followers, ${ttData.posts} posts, ${ttData.avgViews} gem. views`);
  console.log(`📊 Instagram: ${igData.followers} followers, ${igData.posts} posts, ${igData.avgLikes} gem. likes\n`);
}

main().catch(err => {
  console.error('\n✗ Fout:', err.message);
  process.exit(1);
});
