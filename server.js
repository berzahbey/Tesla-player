const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const multer = require('multer');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;
const MEDIA_ROOT = process.env.MEDIA_ROOT || '/media';
const XTREAM_SERVER = (process.env.XTREAM_SERVER || '').replace(/\/$/, '');
const XTREAM_USERNAME = process.env.XTREAM_USERNAME || '';
const XTREAM_PASSWORD = process.env.XTREAM_PASSWORD || '';

const NEEDS_REMUX = new Set(['mkv', 'avi', 'flv', 'wmv', 'ts', 'mpg', 'mpeg', 'm2ts', 'vob']);

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const M3U_DIR = path.join(DATA_DIR, 'm3u');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(M3U_DIR)) fs.mkdirSync(M3U_DIR, { recursive: true });

function defaultState() {
  return {
    m3uSource: { type: 'url', value: 'https://iptv-org.github.io/iptv/languages/tur.m3u' },
    iptvMode: 'm3u',
    xtreamSection: 'live',
    lastChannel: null,
    mediaPlayerLastPath: '',
    resumeMediaPlayer: null,
    resumeXtream: null,
    transcodeKeys: [],
    favorites: [],
    favoritesManualOrder: {}
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();
// Eski sürümlerin yanlışlıkla işaretlediği kanalları bir kere temizle
if (state.transcodeKeysVersion !== 2) {
  state.transcodeKeys = [];
  state.transcodeKeysVersion = 2;
  saveState(state);
}

// Tek bir bozuk bağlantı tüm uygulamayı çökertmesin
process.on('uncaughtException', err => console.error('Beklenmeyen hata (uygulama çalışmaya devam ediyor):', err && err.message));
process.on('unhandledRejection', err => console.error('Beklenmeyen hata (uygulama çalışmaya devam ediyor):', err && err.message));

app.use(express.json());
// index.html: dosya adlarına sürüm ekle, böylece güncellemeden sonra tarayıcı/Cloudflare eski app.js'i kullanmaz
const PUBLIC_DIR = path.join(__dirname, 'public');
const BUILD_ID = require('crypto').createHash('md5')
  .update(['app.js', 'style.css', 'index.html'].map(f => fs.readFileSync(path.join(PUBLIC_DIR, f))).join(''))
  .digest('hex').slice(0, 10);
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8')
  .replace(/(src|href)="(app\.js|style\.css|vendor\/[^"]+)"/g, `$1="$2?v=${BUILD_ID}"`);
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('html').send(INDEX_HTML);
});
app.use(express.static(PUBLIC_DIR, { index: false }));
// Oynatıcı kütüphaneleri container içinden (CDN'e gerek yok)
app.get('/vendor/hls.min.js', (req, res) => res.sendFile(require.resolve('hls.js/dist/hls.min.js')));
app.get('/vendor/mpegts.js', (req, res) => res.sendFile(require.resolve('mpegts.js/dist/mpegts.js')));

function safeResolve(relPath) {
  const root = path.normalize(MEDIA_ROOT);
  const target = path.normalize(path.join(root, relPath || ''));
  if (!target.startsWith(root)) {
    throw new Error('Geçersiz yol');
  }
  return target;
}

function remuxStream(source, req, res) {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'none');
  res.status(200);
  const ff = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-user_agent', 'VLC/3.0.18 LibVLC/3.0.18',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_delay_max', '5',
    '-i', source,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', 'frag_keyframe+empty_moov+faststart',
    '-f', 'mp4',
    'pipe:1'
  ]);
  ff.stdout.pipe(res);
  ff.stderr.on('data', d => console.error('ffmpeg hata:', d.toString()));
  ff.on('error', err => {
    console.error('ffmpeg başlatılamadı:', err.message);
    if (!res.headersSent) res.status(500).end('ffmpeg başlatılamadı');
  });
  req.on('close', () => {
    try { ff.kill('SIGKILL'); } catch {}
  });
}

// ---- Genel config ----
app.get('/api/config', (req, res) => {
  res.json({
    jellyfinUrl: process.env.JELLYFIN_URL || '',
    xtreamEnabled: !!(XTREAM_SERVER && XTREAM_USERNAME && XTREAM_PASSWORD)
  });
});

// ---- State (kalıcı ayarlar) ----
app.get('/api/state', async (req, res) => {
  // Grup bilgisi eksik favoriler varsa tamamlanmasını kısa süre bekle
  const pending = backfillFavoriteGroups();
  if (pending) await Promise.race([pending, new Promise(r => setTimeout(r, 15000))]);
  res.json(state);
});

app.post('/api/state/m3u-mode', (req, res) => {
  state.iptvMode = req.body.mode === 'xtream' ? 'xtream' : 'm3u';
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/state/m3u-url', (req, res) => {
  const url = req.body.url || '';
  state.m3uSource = { type: 'url', value: url };
  saveState(state);
  res.json({ ok: true });
});

const upload = multer({ dest: M3U_DIR });
app.post('/api/state/m3u-file', upload.single('m3ufile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya yok' });
  const finalPath = path.join(M3U_DIR, 'current.m3u');
  fs.renameSync(req.file.path, finalPath);
  state.m3uSource = { type: 'file', value: 'current.m3u' };
  saveState(state);
  res.json({ ok: true });
});

app.get('/api/m3u-file-content', (req, res) => {
  const filePath = path.join(M3U_DIR, 'current.m3u');
  if (!fs.existsSync(filePath)) return res.status(404).send('');
  res.sendFile(filePath);
});

app.post('/api/state/last-channel', (req, res) => {
  const b = req.body || {};
  state.lastChannel = { name: b.name || '', url: b.url || '' };
  if (b.xtream) Object.assign(state.lastChannel, { xtream: true, tsUrl: b.tsUrl || '', key: b.key || '' });
  saveState(state);
  res.json({ ok: true });
});

// ---- Cihaz teşhis kaydı: oynatıcıdaki olaylar sunucu loguna yazılır (docker logs ile okunur) ----
app.post('/api/client-log', (req, res) => {
  const b = req.body || {};
  const dev = String(b.dev || '?').slice(0, 40);
  (Array.isArray(b.lines) ? b.lines : []).slice(0, 100).forEach(l => console.log(`[cihaz ${dev}] ${String(l).slice(0, 300)}`));
  res.json({ ok: true });
});

// ---- Favoriler (Xtream canlı + M3U) ----
// Xtream kategorisinin sağlayıcıdaki sırası ve adı (favori gruplarını sıralamak için)
// Grubu (kategorisi) bilinmeyen Xtream favorilerini sağlayıcının kategori listesini tarayarak tamamla.
// Sadece kanal listeleri çekilir (yayın açılmaz); sonuçlar önbelleğe girer.
let favBackfillPromise = null;
function backfillFavoriteGroups() {
  if (favBackfillPromise) return favBackfillPromise;
  const missing = () => (state.favorites || []).filter(f => f.kind === 'xtream' && !f.group);
  if (!missing().length || !XTREAM_SERVER || !XTREAM_USERNAME || !XTREAM_PASSWORD) return null;
  favBackfillPromise = (async () => {
    try {
      const cats = await xtreamApi('get_live_categories');
      let found = 0;
      for (let pos = 0; pos < (cats || []).length && missing().length; pos++) {
        const c = cats[pos];
        let streams;
        try { streams = await xtreamApi('get_live_streams', { category_id: c.category_id }); } catch { continue; }
        const byKey = new Map((streams || []).map(st => ['xt-live-' + st.stream_id, st]));
        for (const f of missing()) {
          const st = byKey.get(f.id);
          if (!st) continue;
          f.group = String(c.category_id);
          f.groupName = c.category_name;
          f.groupPos = pos;
          if (Number(st.num)) f.num = Number(st.num);
          found++;
        }
      }
      // Eski sürümde grupsuz yapılmış elle sıralama artık geçersiz
      if (state.favoritesManualOrder) delete state.favoritesManualOrder['xtream|'];
      saveState(state);
      console.log(`Favori grupları tamamlandı: ${found} favori, kalan grupsuz: ${missing().length}`);
    } catch (e) {
      console.error('Favori grupları tamamlanamadı:', e.message);
    } finally {
      favBackfillPromise = null;
    }
  })();
  return favBackfillPromise;
}
setTimeout(backfillFavoriteGroups, 3000);

async function xtreamCategoryInfo(catId) {
  try {
    const cats = await xtreamApi('get_live_categories');
    const i = (cats || []).findIndex(c => String(c.category_id) === String(catId));
    return i >= 0 ? { pos: i, name: cats[i].category_name } : null;
  } catch { return null; }
}

app.post('/api/state/favorite-toggle', async (req, res) => {
  const it = (req.body && req.body.item) || {};
  if (!it.kind || !it.id) return res.status(400).json({ error: 'kind ve id gerekli' });
  state.favorites = Array.isArray(state.favorites) ? state.favorites : [];
  const i = state.favorites.findIndex(f => f.kind === it.kind && f.id === it.id);
  let added;
  if (i >= 0) { state.favorites.splice(i, 1); added = false; }
  else {
    const fav = {
      kind: it.kind, id: String(it.id), name: String(it.name || ''), url: String(it.url || ''),
      tsUrl: String(it.tsUrl || ''), icon: String(it.icon || ''),
      num: Number.isFinite(Number(it.num)) && it.num !== null && it.num !== '' ? Number(it.num) : null,
      // Grup: Xtream kategorisi ya da M3U group-title; favoriler grup grup ve grubun kendi sırasıyla durur
      group: it.group != null ? String(it.group) : '', groupName: String(it.groupName || ''),
      groupPos: Number.isFinite(Number(it.groupPos)) && it.groupPos !== null && it.groupPos !== '' ? Number(it.groupPos) : null
    };
    if (fav.kind === 'xtream' && fav.group) {
      const info = await xtreamCategoryInfo(fav.group);
      if (info) { fav.groupPos = info.pos; fav.groupName = fav.groupName || info.name; }
    }
    // Aynı grupta elle sıralama yapıldıysa yeni kanal o grubun sonuna; değilse sıralamayı istemci yapar
    state.favorites.push(fav);
    added = true;
  }
  saveState(state);
  res.json({ ok: true, added, favorites: state.favorites });
});

// Favorilerin elle sıralanması (basılı tut + sürükle) — bir grubun içinde
app.post('/api/state/favorites-order', (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '');
  const group = String(b.group || '');
  const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
  if (!kind || !ids.length) return res.status(400).json({ error: 'kind ve ids gerekli' });
  const match = f => f.kind === kind && (f.group || '') === group;
  const positions = [];
  state.favorites.forEach((f, i) => { if (match(f)) positions.push(i); });
  const byId = new Map(positions.map(i => [state.favorites[i].id, state.favorites[i]]));
  const ordered = ids.map(id => byId.get(id)).filter(Boolean);
  positions.forEach(i => { const f = state.favorites[i]; if (!ids.includes(f.id)) ordered.push(f); });
  const next = state.favorites.slice();
  positions.forEach((pos, k) => { next[pos] = ordered[k]; });
  state.favorites = next;
  state.favoritesManualOrder = { ...(state.favoritesManualOrder || {}), [kind + '|' + group]: true };
  saveState(state);
  res.json({ ok: true, favorites: state.favorites, favoritesManualOrder: state.favoritesManualOrder });
});

app.post('/api/state/xtream-category', (req, res) => {
  const b = req.body || {};
  state.xtreamCategory = b.id ? { section: b.section || 'live', id: String(b.id), name: b.name || '' } : null;
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/state/xtream-section', (req, res) => {
  state.xtreamSection = req.body.section || 'live';
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/state/mediaplayer-path', (req, res) => {
  state.mediaPlayerLastPath = req.body.path || '';
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/state/resume-mediaplayer', (req, res) => {
  state.resumeMediaPlayer = {
    path: req.body.path,
    position: req.body.position,
    label: req.body.label || req.body.path
  };
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/state/resume-xtream', (req, res) => {
  state.resumeXtream = {
    url: req.body.url,
    position: req.body.position,
    label: req.body.label || ''
  };
  saveState(state);
  res.json({ ok: true });
});

// ---- Media Player: dosya listeleme ----
app.get('/api/files', (req, res) => {
  try {
    const relPath = req.query.path || '';
    const dirPath = safeResolve(relPath);
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const videoExt = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ts'];
    const audioExt = ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ogg'];

    const items = entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => {
        const ext = path.extname(e.name).toLowerCase();
        let type = 'other';
        if (e.isDirectory()) type = 'folder';
        else if (videoExt.includes(ext)) type = 'video';
        else if (audioExt.includes(ext)) type = 'audio';
        return { name: e.name, type, path: path.posix.join(relPath, e.name) };
      })
      .sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return a.name.localeCompare(b.name, 'tr');
      });

    res.json({ path: relPath, items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/stream', (req, res) => {
  try {
    const relPath = req.query.path || '';
    const filePath = safeResolve(relPath);
    const ext = path.extname(filePath).slice(1).toLowerCase();

    if (NEEDS_REMUX.has(ext)) {
      remuxStream(filePath, req, res);
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const contentType = mime.lookup(filePath) || 'application/octet-stream';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;
      const stream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    res.status(404).send('Dosya bulunamadı');
  }
});

// ---- Xtream Codes proxy ----
function xtreamCheck(res) {
  if (!XTREAM_SERVER || !XTREAM_USERNAME || !XTREAM_PASSWORD) {
    res.status(400).json({ error: 'Xtream ayarları tanımlı değil' });
    return false;
  }
  return true;
}

// Kanal/kategori listelerini sakla: sağlayıcı bazen 4+ sn'de cevap veriyor.
// Saklanan liste anında döner, 10 dk'dan eskiyse arka planda yenilenir.
const xtreamCache = new Map();
const XTREAM_CACHE_FRESH_MS = 10 * 60 * 1000;
async function xtreamApi(action, extraParams) {
  const cacheKey = action + '|' + JSON.stringify(extraParams || {});
  const hit = xtreamCache.get(cacheKey);
  if (hit) {
    if (Date.now() - hit.at > XTREAM_CACHE_FRESH_MS && !hit.refreshing) {
      hit.refreshing = true;
      xtreamApiFetch(action, extraParams)
        .then(data => xtreamCache.set(cacheKey, { data, at: Date.now() }))
        .catch(() => { hit.refreshing = false; });
    }
    return hit.data;
  }
  const data = await xtreamApiFetch(action, extraParams);
  xtreamCache.set(cacheKey, { data, at: Date.now() });
  return data;
}

async function xtreamApiFetch(action, extraParams) {
  const params = new URLSearchParams({
    username: XTREAM_USERNAME,
    password: XTREAM_PASSWORD,
    action
  });
  if (extraParams) {
    Object.keys(extraParams).forEach(k => params.append(k, extraParams[k]));
  }
  const url = `${XTREAM_SERVER}/player_api.php?${params.toString()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Xtream sunucusu yanıt vermedi: ' + r.status);
  return r.json();
}

function buildProxiedUrl(rawUrl, needsRemux) {
  return `/api/xtream-stream?url=${encodeURIComponent(rawUrl)}` + (needsRemux ? '&remux=1' : '');
}

app.get('/api/xtream/categories', async (req, res) => {
  if (!xtreamCheck(res)) return;
  try {
    const type = req.query.type;
    const actionMap = {
      live: 'get_live_categories',
      vod: 'get_vod_categories',
      series: 'get_series_categories'
    };
    const action = actionMap[type];
    if (!action) return res.status(400).json({ error: 'Geçersiz tip' });
    const data = await xtreamApi(action);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/xtream/streams', async (req, res) => {
  if (!xtreamCheck(res)) return;
  try {
    const type = req.query.type;
    const categoryId = req.query.category_id;
    const actionMap = { live: 'get_live_streams', vod: 'get_vod_streams' };
    const action = actionMap[type];
    if (!action) return res.status(400).json({ error: 'Geçersiz tip' });
    const data = await xtreamApi(action, { category_id: categoryId });

    const items = data.map(item => {
      let rawUrl = '';
      let ext = '';
      if (type === 'live') {
        rawUrl = `${XTREAM_SERVER}/live/${XTREAM_USERNAME}/${XTREAM_PASSWORD}/${item.stream_id}.m3u8`;
      } else {
        ext = (item.container_extension || 'mp4').toLowerCase();
        rawUrl = `${XTREAM_SERVER}/movie/${XTREAM_USERNAME}/${XTREAM_PASSWORD}/${item.stream_id}.${ext}`;
      }
      const needsRemux = NEEDS_REMUX.has(ext);
      const out = {
        id: item.stream_id,
        num: Number(item.num) || null,
        group: String(item.category_id || categoryId || ''),
        name: item.name,
        icon: item.stream_icon || '',
        remux: type === 'vod' ? needsRemux : false,
        url: (type === 'vod' && needsRemux) ? rawUrl : buildProxiedUrl(rawUrl, false)
      };
      if (type === 'live') {
        out.key = 'xt-live-' + item.stream_id;
        out.tsUrl = buildProxiedUrl(`${XTREAM_SERVER}/live/${XTREAM_USERNAME}/${XTREAM_PASSWORD}/${item.stream_id}.ts`, false);
      }
      return out;
    });
    // Numarası/grubu kayıtlı olmayan eski favorileri tamamla
    if (type === 'live' && Array.isArray(state.favorites)) {
      let changed = false;
      let info;
      for (const f of state.favorites) {
        if (f.kind !== 'xtream') continue;
        const m = items.find(i => i.key === f.id);
        if (!m) continue;
        if (!f.num && m.num) { f.num = m.num; changed = true; }
        if (!f.group && categoryId) {
          if (info === undefined) info = await xtreamCategoryInfo(categoryId);
          f.group = String(categoryId);
          if (info) { f.groupName = info.name; f.groupPos = info.pos; }
          changed = true;
        }
      }
      if (changed) saveState(state);
    }
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/xtream/series', async (req, res) => {
  if (!xtreamCheck(res)) return;
  try {
    const categoryId = req.query.category_id;
    const data = await xtreamApi('get_series', { category_id: categoryId });
    const items = data.map(item => ({
      id: item.series_id,
      name: item.name,
      icon: item.cover || ''
    }));
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/xtream/series-info', async (req, res) => {
  if (!xtreamCheck(res)) return;
  try {
    const seriesId = req.query.series_id;
    const data = await xtreamApi('get_series_info', { series_id: seriesId });
    const episodes = [];
    const seasons = data.episodes || {};
    Object.keys(seasons).forEach(seasonNum => {
      seasons[seasonNum].forEach(ep => {
        const ext = (ep.container_extension || 'mp4').toLowerCase();
        const rawUrl = `${XTREAM_SERVER}/series/${XTREAM_USERNAME}/${XTREAM_PASSWORD}/${ep.id}.${ext}`;
        const needsRemux = NEEDS_REMUX.has(ext);
        episodes.push({
          season: seasonNum,
          episodeNum: ep.episode_num,
          title: ep.title || `Bölüm ${ep.episode_num}`,
          remux: needsRemux,
          url: needsRemux ? rawUrl : buildProxiedUrl(rawUrl, false)
        });
      });
    });
    res.json({ info: data.info || {}, episodes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Xtream/canlı akış proxy'si (HTTPS mixed-content çözümü + gerekirse remux) ----
// Node'un temel http modülüyle: fetch (undici), kaynak bağlantıyı kapatınca tüm uygulamayı çökertebiliyordu
const http = require('http');
const https = require('https');
// Sağlayıcı tek bağlantıya izin veriyor: boşta açık bağlantı bırakma
const keepAliveHttp = new http.Agent({ keepAlive: false });
const keepAliveHttps = new https.Agent({ keepAlive: false });

function upstreamGet(url, headers, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : http;
    const agent = u.protocol === 'https:' ? keepAliveHttps : keepAliveHttp;
    const r = mod.get(u, { headers, agent, timeout: 20000 }, up => {
      if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location && redirectsLeft > 0) {
        up.resume();
        const next = new URL(up.headers.location, u).href;
        return upstreamGet(next, headers, redirectsLeft - 1).then(resolve, reject);
      }
      up.finalUrl = u.href;
      resolve(up);
    });
    r.on('timeout', () => r.destroy(new Error('Kaynak zaman aşımı')));
    r.on('error', reject);
  });
}

app.get('/api/xtream-stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('url parametresi gerekli');
  if (req.query.remux === '1') return remuxStream(targetUrl, req, res);

  const headers = { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18' };
  if (req.headers.range) headers['Range'] = req.headers.range;

  let up;
  try {
    up = await upstreamGet(targetUrl, headers);
  } catch (err) {
    if (!res.headersSent) res.status(502).send('Hata: ' + err.message);
    return;
  }
  // İstemci ayrılırsa sağlayıcı bağlantısını hemen bırak (tek bağlantı limiti)
  res.on('close', () => { if (!up.complete) up.destroy(); });
  up.on('error', () => { try { res.end(); } catch {} });

  const contentType = String(up.headers['content-type'] || '');
  const isM3U8 = up.finalUrl.toLowerCase().includes('.m3u8') || contentType.toLowerCase().includes('mpegurl');

  if (isM3U8 && up.statusCode < 400) {
    let text = '';
    up.setEncoding('utf8');
    up.on('data', c => { text += c; });
    up.on('end', () => {
      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const absolute = new URL(trimmed, up.finalUrl).href;
        return '/api/xtream-stream?url=' + encodeURIComponent(absolute);
      }).join('\n');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.send(rewritten);
    });
    return;
  }

  res.status(up.statusCode);
  ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
    if (up.headers[h]) res.setHeader(h, up.headers[h]);
  });
  res.setHeader('Cache-Control', 'no-store');
  up.pipe(res);
});

// ---- M3U URL proxy (CORS bypass) ----
app.get('/api/m3u-proxy', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('url parametresi gerekli');
    const r = await fetch(url);
    if (!r.ok) return res.status(502).send('Kaynak sunucu hata döndürdü: ' + r.status);
    const text = await r.text();
    res.set('Content-Type', 'text/plain');
    res.send(text);
  } catch (err) {
    res.status(500).send('Hata: ' + err.message);
  }
});

// ---- ffmpeg oturumları: remux (kopya) veya transcode (4K/HEVC -> H.264) ----
// Canlı kanallarda tarayıcının çözemediği HEVC/4K akışlarını H.264 1080p'ye çevirir.
// Intel GPU (/dev/dri) varsa VAAPI donanım hızlandırma, yoksa yazılım (libx264) kullanılır.
const crypto = require('crypto');
const os = require('os');
const HLS_TMP_ROOT = path.join(os.tmpdir(), 'tesla-player-hls');
fs.rmSync(HLS_TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(HLS_TMP_ROOT, { recursive: true });

const FF_UA = 'VLC/3.0.18 LibVLC/3.0.18';
const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
// Dönüştürülen kanallar (4K/UHD HEVC) her cihazda 720p: parçalar yarı boyutta -> daha hızlı açılış,
// mobil bağlantıda (Tesla) daha az takılma, 1080p çözemeyen tabletlerde de çalışır.
const TRANSCODE_MAX_HEIGHT = parseInt(process.env.TRANSCODE_MAX_HEIGHT || '720', 10);
const sessions = new Map();

// ffmpeg canlı yayını gerçek zamanlı okuyabiliyor mu (sağlayıcının ani patlamalarını yumuşatmak için)
let readrateOk = false;
let readrateCatchupOk = false;
(function testReadrate() {
  const t = spawn('ffmpeg', ['-hide_banner', '-h', 'full']);
  let out = '';
  t.stdout.on('data', d => { out += d; });
  t.on('exit', () => {
    readrateOk = out.includes('readrate_initial_burst');
    readrateCatchupOk = out.includes('readrate_catchup');
  });
  t.on('error', () => {});
})();

// Yeni ffmpeg sürümleri uzantısı olmayan parça adreslerini reddediyor (extension_picky)
let hlsPickyOpt = false;
(function testHlsOpts() {
  const t = spawn('ffmpeg', ['-hide_banner', '-h', 'demuxer=hls']);
  let out = '';
  t.stdout.on('data', d => { out += d; });
  t.on('exit', () => { hlsPickyOpt = out.includes('extension_picky'); });
  t.on('error', () => {});
})();

// Açılışta VAAPI gerçekten çalışıyor mu test et
let vaapiOk = false;
(function testVaapi() {
  if (process.env.DISABLE_VAAPI === '1' || !fs.existsSync(VAAPI_DEVICE)) {
    console.log('Transcode: yazılım (libx264) kullanılacak');
    return;
  }
  const t = spawn('ffmpeg', ['-loglevel', 'error', '-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`,
    '-filter_hw_device', 'va', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '1',
    '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-']);
  t.on('exit', code => {
    vaapiOk = code === 0;
    console.log('Transcode: ' + (vaapiOk ? 'VAAPI donanım hızlandırma aktif' : 'VAAPI yok, yazılım (libx264) kullanılacak'));
  });
  t.on('error', () => {});
})();

// İstemciden gelen /api/xtream-stream?url=... adresini gerçek kaynak URL'ye çevir
function resolveRemoteSrc(src) {
  if (src && src.startsWith('/api/xtream-stream')) {
    const u = new URL(src, 'http://localhost');
    return u.searchParams.get('url');
  }
  return src;
}

function probe(input, isRemote) {
  return new Promise(resolve => {
    const args = ['-v', 'error'];
    if (isRemote) args.push('-user_agent', FF_UA, '-rw_timeout', '10000000');
    args.push('-analyzeduration', '3000000', '-probesize', '3000000',
      '-show_entries', 'stream=codec_type,codec_name,height', '-of', 'json', '-i', input);
    const p = spawn('ffprobe', args);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 12000);
    p.on('exit', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out).streams || []); } catch { resolve(null); }
    });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

function needsTranscode(streams) {
  if (!streams) return true; // bilinmiyorsa güvenli taraf
  const v = streams.find(s => s.codec_type === 'video');
  if (!v) return false; // sadece ses (radyo)
  if (v.codec_name !== 'h264') return true; // hevc, mpeg2 vs.
  return (v.height || 0) > TRANSCODE_MAX_HEIGHT;
}

function buildArgs({ input, isRemote, live, transcode, hw, dir, lowres }) {
  // 720p ve altı: Main profil, seviye 3.1 (en eski cihazların bile çözebildiği biçim)
  const H = lowres ? Math.min(720, TRANSCODE_MAX_HEIGHT) : TRANSCODE_MAX_HEIGHT;
  lowres = H <= 720;
  const args = ['-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts+discardcorrupt'];
  if (isRemote) {
    args.push('-user_agent', FF_UA, '-reconnect', '1', '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5');
  }
  if (transcode && hw) {
    args.push('-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`, '-filter_hw_device', 'va',
      '-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-hwaccel_output_format', 'vaapi');
  }
  if (live && isRemote && /\.m3u8(\?|$)/i.test(input)) {
    // Sağlayıcının HLS listesinden oku: parçalar sıra numaralı gelir (tekrar/döngü olmaz).
    // ffmpeg listenin birkaç parça gerisinden başlar; gerçek zamanlı okuyunca elimizde
    // her zaman 20-30 sn'lik kaynak tamponu olur ve çıktı düzenli akar.
    // Sağlayıcı tek bağlantıya izin veriyor: ffmpeg'in ikinci (ön-indirme) bağlantısını kapat,
    // yoksa liste yenilemesi "HTTP 509" ile reddediliyor ve yayın ~30 sn sonra kesiliyor
    args.push('-live_start_index', '-3', '-seg_max_retry', '5', '-http_multiple', '0',
      '-allowed_extensions', 'ALL');
    if (hlsPickyOpt) args.push('-extension_picky', '0');
    // Sağlayıcı yayını gerçek zamandan ~2 kat hızlı veriyor; gerçek zamanlı okumazsak oynatıcı
    // geride kalıp ileri atlıyor. Açılış hızlı olsun diye ilk 10 sn'yi bir anda işle,
    // ilk parça geç gelirse (sağlayıcı kanal değişiminde ~2-8 sn bekletiyor) 4 kat hızla yetiş.
    if (readrateOk) {
      args.push('-readrate', '1', '-readrate_initial_burst', '10');
      if (readrateCatchupOk) args.push('-readrate_catchup', '4');
    } else {
      args.push('-re');
    }
  }
  args.push('-analyzeduration', '2000000', '-i', input, '-map', '0:v:0?', '-map', '0:a:0?');

  if (!transcode) {
    args.push('-c:v', 'copy');
  } else if (hw) {
    // Not: scale_vaapi ifade (min(...)) kabul etmiyor; sabit yükseklik kullan (sunucuda test edildi)
    args.push('-vf', `format=nv12|vaapi,hwupload,scale_vaapi=w=-2:h=${H}:format=nv12`,
      '-c:v', 'h264_vaapi', '-b:v', lowres ? '3M' : '6M', '-maxrate', lowres ? '4M' : '8M', '-bufsize', lowres ? '6M' : '12M',
      '-g', '50', '-bf', '0', '-force_key_frames', 'expr:gte(t,n_forced*1)');
    if (lowres) args.push('-profile:v', 'main', '-level', '31');
  } else {
    args.push('-vf', `scale=-2:'min(${H},ih)'`, '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'superfast', '-crf', '22', '-maxrate', lowres ? '4M' : '6M', '-bufsize', lowres ? '6M' : '12M',
      '-g', '50', '-keyint_min', '25', '-sc_threshold', '0', '-force_key_frames', 'expr:gte(t,n_forced*1)');
    if (lowres) args.push('-profile:v', 'main', '-level', '3.1');
  }
  args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-f', 'hls');
  if (live) {
    // Dönüştürmede her 1 sn'de anahtar kare var: 1 sn'lik parçalar -> oynatıcı 2-3 sn'de başlar
    // (Safari/hls.js canlıda ~3 parça bekliyor; 6 sn'lik parçalarda bu ~18 sn ediyordu)
    args.push('-hls_time', transcode ? '1' : '6', '-hls_list_size', transcode ? '40' : '15', '-hls_delete_threshold', '10',
      '-hls_flags', 'delete_segments+independent_segments+omit_endlist');
  } else {
    args.push('-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_flags', 'independent_segments');
  }
  args.push(path.join(dir, 'index.m3u8'));
  return args;
}

function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.proc.kill('SIGKILL'); } catch {}
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
  sessions.delete(id);
}

// Oturumu başlat, ilk segment hazır olana kadar bekle. false dönerse ffmpeg erken öldü.
// Loglarda sağlayıcı kullanıcı adı/şifresi görünmesin
function redact(line) {
  let out = String(line);
  for (const secret of [XTREAM_PASSWORD, XTREAM_USERNAME]) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join('***').split(encodeURIComponent(secret)).join('***');
  }
  return out;
}

async function runFfmpeg(session, opts) {
  const ff = spawn('ffmpeg', buildArgs(opts));
  const tag = `ffmpeg [${session.id.slice(0, 8)}${opts.hw ? ' vaapi' : ''}]`;
  const started = Date.now();
  session.proc = ff;
  session.exited = false;
  // ffmpeg mesajlarını sakla; sadece sorun olunca loga yaz (her kare uyarısıyla log dolmasın)
  const tail = [];
  ff.stderr.on('data', d => {
    d.toString().split(/\r?\n/).filter(Boolean).forEach(l => { tail.push(l); if (tail.length > 12) tail.shift(); });
  });
  ff.on('exit', (code, signal) => {
    session.exited = true;
    if (signal !== 'SIGKILL' && (code !== 0 || !session.ready)) {
      console.error(`${tag} kapandı: kod=${code} sinyal=${signal} süre=${((Date.now() - started) / 1000).toFixed(1)}sn`);
      tail.forEach(l => console.error(`${tag}   ${redact(l)}`));
    }
    // Sağlayıcı yayını hiç vermediyse (ör. tek bağlantı limiti dolu: 4XX / 509) bunu işaretle
    session.sourceRejected = !session.ready && tail.some(l => /Server returned|HTTP error|Error opening input/i.test(l));
  });
  ff.on('error', err => { session.exited = true; console.error(`${tag} başlatılamadı: ${err.message}`); });
  session.dumpTail = (why) => {
    console.error(`${tag} ${why} (süre=${((Date.now() - started) / 1000).toFixed(1)}sn)`);
    tail.forEach(l => console.error(`${tag}   ${redact(l)}`));
  };

  const playlistPath = path.join(session.dir, 'index.m3u8');
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (fs.existsSync(playlistPath)) {
      // Canlıda birkaç parça hazır olsun ki oynatıcı yayının hemen ucunda takılmasın
      // Parça sayısı değil, hazır yayın süresi önemli (kopyalamada parça boyu kaynağa bağlı)
      const pl = fs.readFileSync(playlistPath, 'utf-8');
      const secs = (pl.match(/#EXTINF:([\d.]+)/g) || []).reduce((a, x) => a + parseFloat(x.slice(8)), 0);
      const need = opts.live ? (opts.transcode ? 3 : 5) : 0;
      if (pl.includes('.ts') && secs >= need) {
        session.ready = true;
        console.log(`${tag} hazır: ${((Date.now() - started) / 1000).toFixed(1)}sn (${secs.toFixed(0)} sn yayın)`);
        return true;
      }
    }
    if (session.exited) return false;
    if (session.cancelled) return false;
    await new Promise(r => setTimeout(r, 200));
  }
  session.dumpTail('zaman aşımı: yeterli çıktı üretilemedi');
  return false;
}

// GET /api/session/start?src=...&local=0|1&live=0|1&mode=auto|transcode|copy
app.get('/api/session/start', async (req, res) => {
  const isLocal = req.query.local === '1';
  const live = req.query.live === '1';
  const mode = ['auto', 'transcode', 'copy'].includes(req.query.mode) ? req.query.mode : 'copy';
  const lowres = req.query.q === '720';
  let input;
  try {
    input = isLocal ? safeResolve(req.query.src || '') : resolveRemoteSrc(req.query.src);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!input) return res.status(400).json({ error: 'src gerekli' });

  // Aynı anda tek canlı oturum: yeni kanal açılınca eskisini kapat (sağlayıcı bağlantı limiti)
  if (live) for (const [id, s] of sessions) if (s.live) stopSession(id);

  // Canlı HLS'yi ffmpeg'e kendi aracı bağlantımız üzerinden ver: sağlayıcı ffmpeg'in doğrudan
  // liste yenilemesini "HTTP 509" ile reddediyor, tarayıcıların kullandığı bu yol ise sorunsuz
  if (live && !isLocal && /\.m3u8(\?|$)/i.test(input)) {
    input = `http://127.0.0.1:${PORT}/api/xtream-stream?url=${encodeURIComponent(input)}`;
  }

  let transcode = mode === 'transcode';
  if (mode === 'auto') transcode = needsTranscode(await probe(input, !isLocal));

  const id = crypto.randomUUID();
  const dir = path.join(HLS_TMP_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const session = { id, dir, live, lastAccess: Date.now(), idleLimit: live ? 45000 : 20 * 60000 };
  sessions.set(id, session);
  res.on('close', () => { if (!res.writableEnded) session.cancelled = true; });

  if (lowres) transcode = true;
  const base = { input, isRemote: !isLocal, live, transcode, dir, lowres };
  const resetDir = () => {
    try { session.proc.kill('SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  };
  let ok = await runFfmpeg(session, { ...base, hw: transcode && vaapiOk });
  // Sağlayıcı reddettiyse (önceki kanalın oturumu henüz kapanmadı): biraz bekleyip tekrar dene
  for (let attempt = 1; !ok && session.sourceRejected && !session.cancelled && attempt <= 2; attempt++) {
    console.error(`Sağlayıcı yayını vermedi, ${attempt * 1.5} sn sonra tekrar deneniyor (${attempt}/2)`);
    await new Promise(r => setTimeout(r, attempt * 1500));
    if (session.cancelled) break;
    resetDir();
    session.sourceRejected = false;
    ok = await runFfmpeg(session, { ...base, hw: transcode && vaapiOk });
  }
  if (!ok && transcode && vaapiOk && !session.cancelled && !session.sourceRejected) {
    console.error('VAAPI başarısız, yazılım transcode deneniyor');
    try { session.proc.kill('SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    ok = await runFfmpeg(session, { ...base, hw: false });
  }
  if (!ok) {
    stopSession(id);
    if (session.cancelled) return;
    return res.status(500).json({ error: 'Akış dönüştürülemedi (kaynak yanıt vermedi veya zaman aşımı)' });
  }
  session.lastAccess = Date.now();
  res.json({ id, playlist: `/api/session/${id}/index.m3u8`, transcoded: transcode });
});

app.get('/api/session/:id/:file', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).send('Bulunamadı');
  s.lastAccess = Date.now();
  const filePath = path.join(s.dir, path.basename(req.params.file));
  if (!fs.existsSync(filePath)) return res.status(404).send('Segment bulunamadı');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(filePath);
});

app.post('/api/session/stop', (req, res) => {
  stopSession(req.body && req.body.id);
  res.json({ ok: true });
});

// Kimse izlemiyorsa ffmpeg'i kapat (bağlantı ve CPU sızıntısını önler)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastAccess > s.idleLimit) stopSession(id);
}, 10000);

// Eski istemciler için uyumluluk
app.get('/api/remux/start', (req, res) => {
  const q = new URLSearchParams({ src: req.query.src || '', local: req.query.type === 'local' ? '1' : '0', live: '0', mode: 'copy' });
  res.redirect(307, '/api/session/start?' + q.toString());
});

// ---- Transcode gerektiren kanalları hatırla ----
app.post('/api/state/transcode-key', (req, res) => {
  const key = req.body && req.body.key;
  if (key && !state.transcodeKeys.includes(key)) {
    state.transcodeKeys.push(key);
    if (state.transcodeKeys.length > 500) state.transcodeKeys.shift();
    saveState(state);
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Tesla Player ${PORT} portunda çalışıyor, medya kökü: ${MEDIA_ROOT}`);
});
