/**
 * CTRL Dashboard — YouTube Data Sync via Apify
 * Run: node fetch-youtube.js
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

require('./load-env');

const APIFY_TOKEN  = process.env.APIFY_API_TOKEN;
const YT_ACTOR_ID  = process.env.APIFY_YOUTUBE_OWN_ACTOR_ID;
const YT_USERNAME  = process.env.YOUTUBE_USERNAME || 'jouw_youtube_username';
const DATA_DIR     = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

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
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runActor(actorId, input) {
  console.log(`  ▶ Starting actor ${actorId}...`);
  const run = await apifyRequest('POST', `/acts/${actorId}/runs`, input);
  if (!run.data?.id) throw new Error('Actor start failed: ' + JSON.stringify(run));

  const runId = run.data.id;
  const datasetId = run.data.defaultDatasetId;
  console.log(`  ⏳ Run ID: ${runId}`);

  let status = 'RUNNING', tries = 0;
  while (status === 'RUNNING' && tries < 60) {
    await sleep(5000);
    const s = await apifyRequest('GET', `/actor-runs/${runId}`);
    status = s.data?.status || 'RUNNING';
    process.stdout.write(`  ↻ ${status}\r`);
    tries++;
  }
  console.log(`\n  ✓ ${status}`);

  const items = await apifyRequest('GET', `/datasets/${datasetId}/items`);
  return Array.isArray(items) ? items : items?.items || [];
}

function processYouTube(rawItems) {
  if (!rawItems || rawItems.length === 0) return null;

  const profile = rawItems.find(i => i.channelName || i.subscriberCount !== undefined) || rawItems[0];
  const subscribers = profile.subscriberCount || profile.numberOfSubscribers || 0;
  const videoCount  = profile.videoCount || rawItems.length;
  const channelName = profile.channelName || profile.title || 'YouTube Channel';

  const videos = rawItems
    .filter(i => i.viewCount !== undefined || i.views !== undefined)
    .slice(0, 10)
    .map(item => ({
      title:    (item.title || 'Video').substring(0, 80),
      date:     item.publishedAt ? new Date(item.publishedAt).toLocaleDateString('nl-NL') : '',
      views:    item.viewCount    || item.views    || 0,
      likes:    item.likeCount    || item.likes    || 0,
      comments: item.commentCount || item.comments || 0,
      ctr:      '—',
    }));

  const avgViews = videos.length
    ? Math.round(videos.reduce((s, v) => s + v.views, 0) / videos.length)
    : 0;

  const sparkline = videos.slice(0, 7).reverse().map(v => v.views);

  return { subscribers, videos: videoCount, avgViews, channelName, watchTime: '—', sparkline, posts_data: videos };
}

async function main() {
  console.log('\n📺 CTRL Dashboard — YouTube Sync via Apify\n');
  console.log(`Username: ${YT_USERNAME}\n`);

  const raw = await runActor(YT_ACTOR_ID, {
    startUrls: [{ url: `https://www.youtube.com/@${YT_USERNAME}` }],
    maxVideos: 10,
  });

  const data = processYouTube(raw);
  if (!data) { console.error('❌ Geen data ontvangen'); process.exit(1); }

  fs.writeFileSync(path.join(DATA_DIR, 'youtube.json'), JSON.stringify(data, null, 2));
  console.log(`\n✅ YouTube data opgeslagen in data/youtube.json`);
  console.log(`📺 ${data.channelName}: ${data.subscribers.toLocaleString()} subs, gem. ${data.avgViews.toLocaleString()} views\n`);
}

main().catch(err => { console.error('\n✗ Fout:', err.message); process.exit(1); });
