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
let XTREAM_SERVER = '';
let XTREAM_USERNAME = '';
let XTREAM_PASSWORD = '';
const ENV_XTREAM = {
  server: (process.env.XTREAM_SERVER || '').replace(/\/$/, ''),
  username: process.env.XTREAM_USERNAME || '',
  password: process.env.XTREAM_PASSWORD || ''
};

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

// ---- Çoklu M3U listesi ve çoklu Xtream hesabı (eski tek kayıttan otomatik aktarım) ----
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
if (!Array.isArray(state.m3uLists)) {
  state.m3uLists = [];
  const src = state.m3uSource;
  if (src && src.type === 'file' && fs.existsSync(path.join(M3U_DIR, src.value))) {
    state.m3uLists.push({ id: 'm1', name: 'M3U listesi', type: 'file', value: src.value });
  } else if (src && src.type === 'url' && src.value) {
    state.m3uLists.push({ id: 'm1', name: autoName(src.value), type: 'url', value: src.value });
  }
  state.activeM3u = state.m3uLists.length ? 'm1' : '';
}
if (!Array.isArray(state.xtreamAccounts)) {
  state.xtreamAccounts = [];
  state.activeXtream = '';
}
if (ENV_XTREAM.server && ENV_XTREAM.username && ENV_XTREAM.password &&
    !state.xtreamAccounts.some(a => a.server === ENV_XTREAM.server && a.username === ENV_XTREAM.username)) {
  const first = !state.xtreamAccounts.length;
  state.xtreamAccounts.push({ id: 'x1', name: autoName(ENV_XTREAM.server), ...ENV_XTREAM });
  if (first) { state.activeXtream = 'x1'; state.legacyXtreamAcct = 'x1'; }
}
if (!state.xtreamAccounts.some(a => a.id === state.activeXtream)) {
  state.activeXtream = state.xtreamAccounts.length ? state.xtreamAccounts[0].id : '';
}
saveState(state);

function autoName(v) {
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : 'http://' + v);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '').replace(/\.(m3u8?|php)$/i, '');
    return last && last !== 'get' ? u.hostname + ' / ' + last : u.hostname;
  } catch { return String(v).slice(0, 40); }
}
function applyActiveXtream() {
  const a = state.xtreamAccounts.find(x => x.id === state.activeXtream);
  XTREAM_SERVER = a ? a.server : '';
  XTREAM_USERNAME = a ? a.username : '';
  XTREAM_PASSWORD = a ? a.password : '';
}
applyActiveXtream();
function syncM3uSource() {
  const l = state.m3uLists.find(x => x.id === state.activeM3u);
  state.m3uSource = l ? { type: l.type, value: l.value } : null;
}
function favAcct(f) { return f.acct || (f.kind === 'm3u' ? 'm1' : state.legacyXtreamAcct || ''); }
function favVisible(f) {
  if (f.kind === 'xtream') return favAcct(f) === state.activeXtream;
  if (f.kind === 'm3u') return favAcct(f) === state.activeM3u;
  return true;
}
function favScope(kind) { return kind === 'xtream' ? state.activeXtream : kind === 'm3u' ? state.activeM3u : ''; }
function visibleFavs() { return (state.favorites || []).filter(favVisible); }
// Her favori hangi listeye/hesaba ait olduğunu taşır; istemci kendi gösterdiği listeye göre süzer.
// (Sunucudaki "aktif liste" tek: başka bir cihaz liste değiştirince favoriler yanlış listeye yazılıyordu.)
function allFavs() { return (state.favorites || []).map(f => ({ ...f, acct: favAcct(f) })); }
function reqScope(kind, acct) {
  acct = acct == null ? '' : String(acct);
  if (kind === 'm3u' && state.m3uLists.some(l => l.id === acct)) return acct;
  if (kind === 'xtream' && state.xtreamAccounts.some(a => a.id === acct)) return acct;
  return favScope(kind);
}
function publicState() {
  const { jellyfin, ...rest } = state;
  return {
    ...rest,
    favorites: allFavs(),
    xtreamAccounts: state.xtreamAccounts.map(a => ({ id: a.id, name: a.name, server: a.server, username: a.username }))
  };
}
// Eski sürümlerin yanlışlıkla işaretlediği kanalları bir kere temizle
if (state.transcodeKeysVersion !== 2) {
  state.transcodeKeys = [];
  state.transcodeKeysVersion = 2;
  saveState(state);
}

// Tek bir bozuk bağlantı tüm uygulamayı çökertmesin
process.on('uncaughtException', err => console.error('Beklenmeyen hata (uygulama çalışmaya devam ediyor):', err && err.message));
process.on('unhandledRejection', err => console.error('Beklenmeyen hata (uygulama çalışmaya devam ediyor):', err && err.message));

// JSON gövdesini sadece kendi /api isteklerimizde çöz; diğerleri (Jellyfin) olduğu gibi aktarılır
const jsonBody = express.json();
app.use((req, res, next) => (req.path.startsWith('/api/') ? jsonBody(req, res, next) : next()));
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
    jellyfinProxy: JF_PROXY,
    xtreamEnabled: !!(XTREAM_SERVER && XTREAM_USERNAME && XTREAM_PASSWORD)
  });
});

// ---- State (kalıcı ayarlar) ----
app.get('/api/state', async (req, res) => {
  // Grup bilgisi eksik favoriler varsa tamamlanmasını kısa süre bekle
  const pending = backfillFavoriteGroups();
  if (pending) await Promise.race([pending, new Promise(r => setTimeout(r, 15000))]);
  res.json(publicState());
});

app.post('/api/state/m3u-mode', (req, res) => {
  state.iptvMode = req.body.mode === 'xtream' ? 'xtream' : 'm3u';
  saveState(state);
  res.json({ ok: true });
});

function m3uLists() { return state.m3uLists.map(l => ({ id: l.id, name: l.name, type: l.type, value: l.type === 'url' ? l.value : '' })); }
function m3uReply(res, extra) {
  syncM3uSource();
  saveState(state);
  res.json({ ok: true, m3uLists: m3uLists(), activeM3u: state.activeM3u, favorites: allFavs(), favoritesManualOrder: state.favoritesManualOrder, ...(extra || {}) });
}

app.post('/api/state/m3u-url', (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Adres boş' });
  let l = state.m3uLists.find(x => x.type === 'url' && x.value === url);
  if (!l) {
    l = { id: newId('m'), name: String(req.body.name || '').trim() || autoName(url), type: 'url', value: url };
    state.m3uLists.push(l);
  }
  state.activeM3u = l.id;
  m3uReply(res);
});

const upload = multer({ dest: M3U_DIR });
app.post('/api/state/m3u-file', upload.single('m3ufile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya yok' });
  const id = newId('m');
  const fileName = id + '.m3u';
  fs.renameSync(req.file.path, path.join(M3U_DIR, fileName));
  const orig = Buffer.from(req.file.originalname || '', 'latin1').toString('utf8').replace(/\.(m3u8?)$/i, '').trim();
  state.m3uLists.push({ id, name: String(req.body.name || '').trim() || orig || 'M3U dosyası', type: 'file', value: fileName });
  state.activeM3u = id;
  m3uReply(res);
});

app.post('/api/state/m3u-select', (req, res) => {
  if (!state.m3uLists.some(x => x.id === req.body.id)) return res.status(404).json({ error: 'Liste yok' });
  state.activeM3u = req.body.id;
  m3uReply(res);
});

app.post('/api/state/m3u-rename', (req, res) => {
  const l = state.m3uLists.find(x => x.id === req.body.id);
  const name = String(req.body.name || '').trim();
  if (!l || !name) return res.status(400).json({ error: 'Geçersiz' });
  l.name = name;
  m3uReply(res);
});

app.post('/api/state/m3u-delete', (req, res) => {
  const i = state.m3uLists.findIndex(x => x.id === req.body.id);
  if (i < 0) return res.status(404).json({ error: 'Liste yok' });
  const [l] = state.m3uLists.splice(i, 1);
  if (l.type === 'file') { try { fs.unlinkSync(path.join(M3U_DIR, l.value)); } catch {} }
  state.favorites = (state.favorites || []).filter(f => !(f.kind === 'm3u' && favAcct(f) === l.id));
  if (state.activeM3u === l.id) state.activeM3u = state.m3uLists.length ? state.m3uLists[0].id : '';
  m3uReply(res);
});

app.get('/api/m3u-file-content', (req, res) => {
  const l = state.m3uLists.find(x => x.id === (req.query.id || state.activeM3u) && x.type === 'file');
  const filePath = l ? path.join(M3U_DIR, l.value) : '';
  if (!l || !fs.existsSync(filePath)) return res.status(404).send('');
  res.sendFile(filePath);
});

// ---- Çoklu Xtream hesapları ----
function xtreamAccountsReply(res) {
  applyActiveXtream();
  xtreamCache.clear();
  state.xtreamCategory = null;
  saveState(state);
  res.json({
    ok: true,
    activeXtream: state.activeXtream,
    xtreamEnabled: !!XTREAM_SERVER,
    xtreamAccounts: publicState().xtreamAccounts,
    favorites: allFavs()
  });
}

app.post('/api/state/xtream-add', async (req, res) => {
  const b = req.body || {};
  let server = String(b.server || '').trim().replace(/\/+$/, '');
  const username = String(b.username || '').trim();
  const password = String(b.password || '').trim();
  if (!server || !username || !password) return res.status(400).json({ error: 'Sunucu, kullanıcı adı ve şifre gerekli' });
  if (!/^https?:\/\//i.test(server)) server = 'http://' + server;
  try {
    const r = await fetch(`${server}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, { signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    if (!j || !j.user_info || Number(j.user_info.auth) === 0) return res.status(400).json({ error: 'Giriş başarısız: kullanıcı adı veya şifre yanlış' });
  } catch (e) {
    return res.status(400).json({ error: 'Sunucuya ulaşılamadı: ' + e.message });
  }
  let a = state.xtreamAccounts.find(x => x.server === server && x.username === username);
  if (a) { a.password = password; if (String(b.name || '').trim()) a.name = String(b.name).trim(); }
  else {
    a = { id: newId('x'), name: String(b.name || '').trim() || autoName(server), server, username, password };
    state.xtreamAccounts.push(a);
  }
  state.activeXtream = a.id;
  xtreamAccountsReply(res);
});

app.post('/api/state/xtream-select', (req, res) => {
  if (!state.xtreamAccounts.some(x => x.id === req.body.id)) return res.status(404).json({ error: 'Hesap yok' });
  state.activeXtream = req.body.id;
  xtreamAccountsReply(res);
});

app.post('/api/state/xtream-rename', (req, res) => {
  const a = state.xtreamAccounts.find(x => x.id === req.body.id);
  const name = String(req.body.name || '').trim();
  if (!a || !name) return res.status(400).json({ error: 'Geçersiz' });
  a.name = name;
  saveState(state);
  res.json({ ok: true, xtreamAccounts: publicState().xtreamAccounts });
});

app.post('/api/state/xtream-delete', (req, res) => {
  const i = state.xtreamAccounts.findIndex(x => x.id === req.body.id);
  if (i < 0) return res.status(404).json({ error: 'Hesap yok' });
  const [a] = state.xtreamAccounts.splice(i, 1);
  state.favorites = (state.favorites || []).filter(f => !(f.kind === 'xtream' && favAcct(f) === a.id));
  if (state.activeXtream === a.id) state.activeXtream = state.xtreamAccounts.length ? state.xtreamAccounts[0].id : '';
  xtreamAccountsReply(res);
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
  const missing = () => (state.favorites || []).filter(f => f.kind === 'xtream' && favVisible(f) && !f.group);
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
  const scope = reqScope(it.kind, it.acct);
  const i = state.favorites.findIndex(f => f.kind === it.kind && f.id === String(it.id) && favAcct(f) === scope);
  let added;
  if (i >= 0) { state.favorites.splice(i, 1); added = false; }
  else {
    const fav = {
      kind: it.kind, id: String(it.id), acct: scope, name: String(it.name || ''), url: String(it.url || ''),
      tsUrl: String(it.tsUrl || ''), icon: String(it.icon || ''),
      num: Number.isFinite(Number(it.num)) && it.num !== null && it.num !== '' ? Number(it.num) : null,
      // Grup: Xtream kategorisi ya da M3U group-title; favoriler grup grup ve grubun kendi sırasıyla durur
      group: it.kind === 'm3u' ? scope : (it.group != null ? String(it.group) : ''), groupName: String(it.groupName || ''),
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
  res.json({ ok: true, added, favorites: allFavs() });
});

// Yanlış listeye yazılmış M3U favorilerini düzelt: istemci listeyi yükleyince
// release = bu listeye kayıtlı ama listede olmayan kanallar (sahipsiz kalır),
// claim   = sahipsiz/eski favorilerden bu listede bulunanlar (bu listeye alınır)
app.post('/api/state/m3u-fav-fix', (req, res) => {
  const b = req.body || {};
  const list = String(b.list || '');
  if (!state.m3uLists.some(l => l.id === list)) return res.status(404).json({ error: 'Liste yok' });
  const claim = new Set((Array.isArray(b.claim) ? b.claim : []).map(String));
  const release = new Set((Array.isArray(b.release) ? b.release : []).map(String));
  let changed = 0;
  for (const f of state.favorites || []) {
    if (f.kind !== 'm3u') continue;
    const owner = favAcct(f);
    if (release.has(f.id) && owner === list) { f.acct = '?'; f.group = '?'; changed++; }
    else if (claim.has(f.id) && (!f.acct || f.acct === '?' || !state.m3uLists.some(l => l.id === owner))) {
      if (state.favorites.some(g => g !== f && g.kind === 'm3u' && g.id === f.id && favAcct(g) === list)) continue;
      f.acct = list; f.group = list; changed++;
    }
  }
  if (changed) saveState(state);
  res.json({ ok: true, changed, favorites: allFavs() });
});

// Favorilerin elle sıralanması (basılı tut + sürükle) — bir grubun içinde
app.post('/api/state/favorites-order', (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '');
  const group = String(b.group || '');
  const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
  if (!kind || !ids.length) return res.status(400).json({ error: 'kind ve ids gerekli' });
  const scope = reqScope(kind, b.acct);
  const match = f => f.kind === kind && favAcct(f) === scope && (f.group || '') === group;
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
  res.json({ ok: true, favorites: allFavs(), favoritesManualOrder: state.favoritesManualOrder });
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

// Film kaldığı yer (her film ayrı): { url: { position, duration, label, t } }
app.post('/api/state/resume-movie', (req, res) => {
  const b = req.body || {};
  const url = String(b.url || '');
  if (!url) return res.status(400).json({ error: 'url gerekli' });
  state.resumeMovies = state.resumeMovies && typeof state.resumeMovies === 'object' ? state.resumeMovies : {};
  const pos = Number(b.position) || 0;
  const dur = Number(b.duration) || 0;
  if (b.done || pos < 10 || (dur && pos > dur - 90)) delete state.resumeMovies[url];
  else state.resumeMovies[url] = { position: Math.round(pos), duration: Math.round(dur), label: String(b.label || ''), t: Date.now() };
  const keys = Object.keys(state.resumeMovies);
  if (keys.length > 300) keys.sort((a, c) => state.resumeMovies[a].t - state.resumeMovies[c].t)
    .slice(0, keys.length - 300).forEach(k => delete state.resumeMovies[k]);
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
        if (f.kind !== 'xtream' || !favVisible(f)) continue;
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
// Jellyfin'e konteynerden ulaşılan adres (ev ağı, ör. http://192.168.1.10:8096). Yoksa JELLYFIN_URL kullanılır.
const JF_UPSTREAM = (process.env.JELLYFIN_INTERNAL_URL || process.env.JELLYFIN_URL || '').replace(/\/+$/, '');
const JF_PROXY = !!JF_UPSTREAM && process.env.JELLYFIN_PROXY !== '0';
let JF_PUBLIC_HOST = '';
try { JF_PUBLIC_HOST = process.env.JELLYFIN_URL ? new URL(process.env.JELLYFIN_URL).host : ''; } catch {}
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

function buildArgs({ input, input2, ua, isRemote, live, transcode, hw, dir, lowres, start, audio, subs }) {
  // 720p ve altı: Main profil, seviye 3.1 (en eski cihazların bile çözebildiği biçim)
  const H = lowres ? Math.min(720, TRANSCODE_MAX_HEIGHT) : TRANSCODE_MAX_HEIGHT;
  lowres = H <= 720;
  const args = ['-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts+discardcorrupt'];
  const remoteOpts = isRemote ? ['-user_agent', ua || FF_UA, '-reconnect', '1', '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5'] : [];
  args.push(...remoteOpts);
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
  // Film: istenen saniyeden başla (ileri/geri sarma) ve seçilen ses dilini al
  // -copyts: altyazılar filmin gerçek saatiyle yazılır (atlanan kısmın altyazıları yanlış yere düşmesin)
  if (!live && start > 0) args.push('-ss', String(start), '-copyts');
  const aIdx = Number.isInteger(audio) && audio >= 0 ? audio : 0;
  args.push('-analyzeduration', '2000000', '-i', input);
  if (input2) {
    // YouTube: görüntü ve ses ayrı dosyalar
    args.push(...remoteOpts);
    if (!live && start > 0) args.push('-ss', String(start));
    args.push('-i', input2, '-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-map', '0:v:0?', '-map', `0:a:${aIdx}?`);
  }

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
    args.push('-hls_time', input2 ? '2' : '6', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_flags', 'independent_segments');
  }
  args.push(path.join(dir, 'index.m3u8'));
  // Altyazılar: her metin altyazısı ayrı bir WebVTT dosyasına (film ilerledikçe dolar)
  if (!live) for (const n of subs || []) {
    args.push('-map', `0:s:${n}`, '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', path.join(dir, `sub_${n}.vtt`));
  }
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

// ---- YouTube (yt-dlp ile; YouTube'un gömülü oynatıcısı kullanılmaz) ----
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
// yt-dlp YouTube için bir JavaScript motoru istiyor: konteynerdeki node kullanılır
const YTDLP_BASE = ['--no-warnings', '--js-runtimes', 'node'];
// Kendi YouTube hesabı: tarayıcıdan alınan çerez dosyası (yt-dlp şifreyle giriş yapamıyor)
const YT_COOKIES = path.join(DATA_DIR, 'yt-cookies.txt');
function ytHasAccount() { try { return fs.statSync(YT_COOKIES).size > 0; } catch { return false; } }
function runYtdlp(args, timeoutMs = 45000, opts = {}) {
  return new Promise((resolve, reject) => {
    const extra = [...(opts.playlist ? [] : ['--no-playlist']), ...(ytHasAccount() && !opts.noCookies ? ['--cookies', YT_COOKIES] : [])];
    const p = spawn(YTDLP, [...YTDLP_BASE, ...extra, ...args]);
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.on('error', e => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'yt-dlp kurulu değil (image yeniden derlenmeli)' : e.message)); });
    p.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      const last = err.split('\n').filter(l => /ERROR/.test(l)).pop() || err.trim().split('\n').pop() || ('kod ' + code);
      console.error('yt-dlp hata:', last);
      reject(new Error(last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?(\S+:\s*)?/, '').slice(0, 200)));
    });
  });
}
// Açılışta yt-dlp'yi arka planda güncelle (YouTube değiştikçe eski sürüm bozulabiliyor)
if (process.env.YTDLP_AUTO_UPDATE !== '0') {
  const up = spawn('pip', ['install', '-q', '-U', '--break-system-packages', '--no-cache-dir', 'yt-dlp', 'yt-dlp-ejs']);
  up.on('exit', code => {
    console.log('yt-dlp güncelleme: ' + (code === 0 ? 'tamam' : 'yapılamadı (kod ' + code + ')'));
    if (code === 0) setTimeout(() => { ytdRestart(); ytdWorker(); }, 500);
  });
  up.on('error', () => {});
}

// Sürekli açık yt-dlp yardımcıları (ytd.py): her istekte Python/yt-dlp yüklenmez, bağlantı açık kalır.
// İki tane: biri önceden hazırlamayla meşgulken tıklanan video beklemesin.
const YTD_PY = process.env.YTDLP_PYTHON || 'python3';
const YTD_SCRIPT = path.join(__dirname, 'ytd.py');
const ytdPool = [];
let ytdRid = 0;
function ytdStart() {
  const w = { proc: null, ready: false, busy: 0, pending: new Map(), buf: '', dead: false };
  let p;
  try { p = spawn(YTD_PY, [YTD_SCRIPT]); } catch { w.dead = true; return w; }
  w.proc = p;
  p.stdout.on('data', d => {
    w.buf += d;
    let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i); w.buf = w.buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.ready) { w.ready = true; continue; }
      const cb = w.pending.get(m.rid);
      if (cb) { w.pending.delete(m.rid); w.busy--; cb(m); }
    }
  });
  p.stderr.on('data', () => {});
  const die = () => {
    w.dead = true;
    for (const cb of w.pending.values()) cb({ ok: false, error: 'yardımcı kapandı' });
    w.pending.clear();
  };
  p.on('exit', die);
  p.on('error', die);
  return w;
}
function ytdWorker() {
  for (let i = 0; i < 2; i++) if (!ytdPool[i] || ytdPool[i].dead) ytdPool[i] = ytdStart();
  return ytdPool.filter(w => !w.dead).sort((a, b) => a.busy - b.busy)[0];
}
function ytdRestart() { ytdPool.splice(0).forEach(w => { try { w.proc.kill(); } catch {} }); }
function ytdExtract(url, client, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const w = ytdWorker();
    if (!w || !w.proc) return reject(new Error('yardımcı yok'));
    const rid = ++ytdRid;
    const timer = setTimeout(() => {
      if (!w.pending.has(rid)) return;
      w.pending.delete(rid); w.busy--;
      try { w.proc.kill('SIGKILL'); } catch {}
      reject(new Error('zaman aşımı'));
    }, timeoutMs);
    w.busy++;
    w.pending.set(rid, m => { clearTimeout(timer); m.ok ? resolve(m.info) : reject(new Error(m.error)); });
    w.proc.stdin.write(JSON.stringify({ rid, url, client }) + '\n');
  });
}
if (process.env.YT_DAEMON !== '0') ytdWorker();

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
function ytIdFrom(q) {
  q = String(q || '').trim();
  if (YT_ID.test(q)) return q;
  const m = q.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function ytThumb(id) { return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`; }

app.get('/api/yt/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const direct = ytIdFrom(q);
  if (direct) return res.json([{ id: direct, title: 'YouTube videosu', channel: '', duration: 0, thumb: ytThumb(direct), link: true }]);
  try {
    const out = await runYtdlp(['--flat-playlist', '-J', `ytsearch30:${q}`], 30000, { playlist: true });
    const j = JSON.parse(out);
    res.json((j.entries || []).filter(e => e && YT_ID.test(e.id || '')).map(e => ({
      id: e.id, title: e.title || '', channel: e.channel || e.uploader || '',
      duration: e.duration || 0, live: e.live_status === 'is_live', thumb: ytThumb(e.id)
    })));
  } catch (e) { res.status(502).json({ error: 'Arama yapılamadı: ' + e.message }); }
});


// ---- YouTube hesabı: abonelikler, sonra izle, beğenilenler, geçmiş, oynatma listeleri ----
const YT_FEEDS = {
  subs: { src: ':ytsubs', title: 'Abonelikler' },
  wl: { src: ':ytwatchlater', title: 'Sonra izle' },
  liked: { src: ':ytfav', title: 'Beğenilenler' },
  history: { src: ':ythis', title: 'Geçmiş' },
  rec: { src: ':ytrec', title: 'Önerilenler' },
  playlists: { src: 'https://www.youtube.com/feed/playlists', title: 'Oynatma listelerim' },
  channels: { src: 'https://www.youtube.com/feed/channels', title: 'Kanallarım' }
};
app.get('/api/yt/account', (req, res) => res.json({ connected: ytHasAccount() }));
app.post('/api/yt/account', async (req, res) => {
  const b = req.body || {};
  if (b.remove) { try { fs.unlinkSync(YT_COOKIES); } catch {} ytListCache.clear(); return res.json({ ok: true, connected: false }); }
  const text = String(b.text || '');
  if (!/youtube\.com/.test(text) || !/\t/.test(text)) return res.status(400).json({ error: 'Bu bir YouTube cookies.txt dosyası değil' });
  const tmp = YT_COOKIES + '.new';
  fs.writeFileSync(tmp, text.startsWith('# Netscape') ? text : '# Netscape HTTP Cookie File\n' + text, { mode: 0o600 });
  try {
    // Gerçekten giriş yapılmış mı: "Sonra izle" listesine bakmayı dene
    await new Promise((resolve, reject) => {
      const p = spawn(YTDLP, [...YTDLP_BASE, '--cookies', tmp, '--flat-playlist', '-J', '--playlist-end', '1', ':ytwatchlater']);
      let err = '';
      p.stderr.on('data', d => { err += d; });
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 45000);
      p.on('exit', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(err)); });
      p.on('error', e => { clearTimeout(t); reject(e); });
    });
    fs.renameSync(tmp, YT_COOKIES);
    ytListCache.clear();
    res.json({ ok: true, connected: true });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    console.error('YouTube çerez denemesi başarısız:', String(e.message).split('\n').filter(l => /ERROR/.test(l)).pop() || e.message);
    res.status(400).json({ error: 'Bu çerezlerle YouTube\'a giriş yapılamadı (süresi dolmuş olabilir). Yeniden dışa aktarıp tekrar dene.' });
  }
});
const ytListCache = new Map();
function ytEntry(e) {
  const thumbs = e.thumbnails || [];
  const thumb = thumbs.length ? thumbs[thumbs.length - 1].url : '';
  const isVideo = YT_ID.test(e.id || '') && (!e.ie_key || e.ie_key === 'Youtube') && !/[?&]list=|\/playlist|\/channel\/|\/@/.test(e.url || '');
  if (isVideo) return { type: 'video', id: e.id, title: e.title || '', channel: e.channel || e.uploader || '', duration: e.duration || 0,
    live: e.live_status === 'is_live', thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg` };
  const url = e.url || (e.id && /^(PL|LL|WL|UU|FL|RD|OL)/.test(e.id) ? 'https://www.youtube.com/playlist?list=' + e.id : '');
  if (!url) return null;
  return { type: 'list', title: e.title || e.channel || 'Liste', channel: e.channel || e.uploader || '', count: e.playlist_count || 0, thumb, url };
}
// GET /api/yt/list?feed=subs|wl|liked|history|rec|playlists|channels  ya da  ?url=<youtube oynatma listesi/kanal>
app.get('/api/yt/list', async (req, res) => {
  let src, title;
  if (req.query.feed) {
    const f = YT_FEEDS[req.query.feed];
    if (!f) return res.status(400).json({ error: 'Bilinmeyen liste' });
    if (!ytHasAccount()) return res.status(400).json({ error: 'YouTube hesabı bağlı değil' });
    src = f.src; title = f.title;
  } else {
    const u = String(req.query.url || '');
    if (!/^https:\/\/(www\.|m\.)?youtube\.com\//.test(u)) return res.status(400).json({ error: 'Geçersiz adres' });
    src = /\/(@[^/]+|channel\/[^/]+|c\/[^/]+)\/?$/.test(u) ? u.replace(/\/?$/, '/videos') : u;
    title = String(req.query.title || '');
  }
  const c = ytListCache.get(src);
  if (c && Date.now() - c.t < 120000) return res.json(c.data);
  try {
    const out = await runYtdlp(['--flat-playlist', '-J', '--playlist-end', '80', src], 60000, { playlist: true });
    const j = JSON.parse(out);
    const data = { title: title || j.title || '', items: (j.entries || []).map(ytEntry).filter(Boolean) };
    ytListCache.set(src, { t: Date.now(), data });
    res.json(data);
  } catch (e) { res.status(502).json({ error: 'Liste alınamadı: ' + e.message }); }
});

// Video bilgisi ve en uygun biçimler (H.264 görüntü + AAC ses). 1 saat saklanır (adresler ~6 saat geçerli)
const ytCache = new Map();
const ytInflight = new Map();
// Aynı video aynı anda iki kez hazırlanmasın (önceden hazırlama + tıklama)
function ytRaw(id) {
  const c = ytCache.get(id);
  if (c && Date.now() - c.t < 3600000) return Promise.resolve(c.j);
  if (ytInflight.has(id)) return ytInflight.get(id);
  const p = ytRawFetch(id).finally(() => ytInflight.delete(id));
  ytInflight.set(id, p);
  return p;
}
// Önceden hazırlama: listedeki ilk videolar arka planda (sırayla, sunucuyu yormadan)
const ytPrefetchQueue = [];
let ytPrefetching = false;
function ytPrefetch(ids, front) {
  ids = ids.filter(id => YT_ID.test(id) && !ytCache.has(id) && !ytInflight.has(id) && !ytPrefetchQueue.includes(id));
  if (front) ytPrefetchQueue.unshift(...ids); else ytPrefetchQueue.push(...ids);
  ytPrefetchQueue.splice(12);
  if (ytPrefetching) return;
  ytPrefetching = true;
  (async () => {
    while (ytPrefetchQueue.length) {
      const id = ytPrefetchQueue.shift();
      try { await ytRaw(id); } catch {}
    }
    ytPrefetching = false;
  })();
}
app.post('/api/yt/prefetch', (req, res) => {
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(String).slice(0, 8);
  ytPrefetch(ids, !!(req.body && req.body.now));
  res.json({ ok: true });
});
async function ytRawFetch(id) {
  // Videoyu hesapsız al: giriş yapılmış istekte YouTube biçimleri farklı veriyor ve çoğu zaman
  // oynatılabilir biçim çıkmıyor ("Requested format is not available"). Hesap sadece yedek (yaş sınırı vb.)
  const url = `https://www.youtube.com/watch?v=${id}`;
  const args = ['-J', '--ignore-no-formats-error', url];
  const usable = j => (j.formats || []).some(f => f.url && f.vcodec && f.vcodec !== 'none');
  const t0 = Date.now();
  // Hızlı yol: visionos istemcisi — JavaScript bulmacası ve ek anahtar (PO token) gerektirmiyor.
  // H.264 görüntü çıkmazsa normal (yavaş) yola geç.
  if (process.env.YT_FAST !== '0') {
    try {
      let jf;
      if (process.env.YT_DAEMON !== '0') { try { jf = await ytdExtract(url, 'visionos'); } catch (e) { console.error(`yt-dlp yardımcı [${id}]: ${e.message}`); } }
      if (!jf) jf = JSON.parse(await runYtdlp(['-J', '--ignore-no-formats-error', '--extractor-args', 'youtube:player_client=visionos', url], 25000, { noCookies: true }));
      const avc = (jf.formats || []).some(f => f.url && /^avc1/.test(f.vcodec || '') && !/m3u8/.test(f.protocol || ''));
      if (avc && !jf.is_live) {
        console.log(`yt-dlp [${id}] hızlı yol: ${((Date.now() - t0) / 1000).toFixed(1)}sn`);
        ytCache.set(id, { t: Date.now(), j: jf });
        if (ytCache.size > 100) ytCache.delete(ytCache.keys().next().value);
        return jf;
      }
    } catch {}
  }
  let j = null, firstErr = null;
  try { j = JSON.parse(await runYtdlp(args, 45000, { noCookies: true })); } catch (e) { firstErr = e; }
  if ((!j || !usable(j)) && ytHasAccount()) {
    try { const j2 = JSON.parse(await runYtdlp(args)); if (usable(j2) || !j) j = j2; } catch (e) { if (!j) throw firstErr || e; }
  }
  if (!j) throw firstErr || new Error('Video bilgisi alınamadı');
  console.log(`yt-dlp [${id}] normal yol: ${((Date.now() - t0) / 1000).toFixed(1)}sn`);
  ytCache.set(id, { t: Date.now(), j });
  if (ytCache.size > 100) ytCache.delete(ytCache.keys().next().value);
  return j;
}
async function ytResolve(id, maxH) {
  if (!YT_ID.test(id)) throw new Error('Geçersiz video');
  const j = await ytRaw(id);
  const fm = (j.formats || []).filter(f => f.url);
  const ua = (j.http_headers && j.http_headers['User-Agent']) || undefined;
  if (j.is_live) {
    const hlsF = fm.filter(f => /m3u8/.test(f.protocol || '') && f.vcodec && f.vcodec !== 'none' && (f.height || 0) <= maxH)
      .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))[0];
    if (!hlsF) throw new Error('Canlı yayın açılamadı');
    return { live: true, v: hlsF, a: null, ua, h264: /^avc1/.test(hlsF.vcodec || '') };
  }
  const isHttp = f => /^https?$/.test(f.protocol || "https");
  const vids = fm.filter(f => isHttp(f) && /^avc1/.test(f.vcodec || '') && (!f.acodec || f.acodec === 'none') && (f.height || 0) <= maxH)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
  const auds = fm.filter(f => isHttp(f) && /^mp4a/.test(f.acodec || '') && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => ((/original|default/i.test(b.format_note || '') ? 1 : 0) - (/original|default/i.test(a.format_note || '') ? 1 : 0)) || (b.abr || 0) - (a.abr || 0));
  const fua = f => (f && f.http_headers && f.http_headers['User-Agent']) || ua;
  if (vids[0] && auds[0]) return { live: false, v: vids[0], a: auds[0], ua: fua(vids[0]), h264: true };
  // Yedek: görüntü+ses birlikte olan biçim (genelde 360p)
  const both = fm.filter(f => isHttp(f) && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  if (both) return { live: false, v: both, a: null, ua: fua(both), h264: /^avc1/.test(both.vcodec || '') };
  throw new Error('Uygun biçim bulunamadı');
}

app.get('/api/yt/info', async (req, res) => {
  const id = String(req.query.id || '');
  try {
    const j = await ytRaw(id);
    const r = await ytResolve(id, 1080);
    const subs = [];
    const add = (lang, list, auto) => {
      const v = (list || []).find(x => x.ext === 'vtt');
      if (!v) return;
      subs.push({ n: subs.length, lang, title: auto ? 'otomatik' : '', codec: 'webvtt', text: true, ext: true, auto,
        url: `/api/yt/sub?id=${id}&lang=${encodeURIComponent(lang)}&auto=${auto ? 1 : 0}` });
    };
    Object.keys(j.subtitles || {}).filter(l => l !== 'live_chat').forEach(l => add(l, j.subtitles[l], false));
    // Otomatik altyazılardan: Türkçe, İngilizce ve videonun kendi dili
    const autoC = j.automatic_captions || {};
    const orig = Object.keys(autoC).find(l => /-orig$/.test(l));
    [...new Set(['tr', 'en', orig, j.language].filter(Boolean))].forEach(l => { if (autoC[l] && !(j.subtitles || {})[l]) add(l.replace(/-orig$/, ''), autoC[l], true); });
    res.json({
      title: j.title || '', channel: j.channel || j.uploader || '', duration: r.live ? 0 : (j.duration || 0), live: r.live, container: 'youtube',
      video: { codec: r.h264 ? 'h264' : (r.v.vcodec || ''), height: r.v.height || 0 },
      audio: [{ n: 0, codec: 'aac', channels: (r.a && r.a.audio_channels) || 2, lang: (r.a && r.a.language) || j.language || '', title: '' }],
      subs
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Otomatik altyazılar kayan yazı gibi her satırı iki kez veriyor: tekrarları ayıkla
function cleanYtVtt(text) {
  const cues = [];
  const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/);
  let prevLast = '';
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const time = lines[i].replace(/\s+(align|position|line|size):\S+/g, '');
    const txt = lines.slice(i + 1).map(l => l.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    const fresh = txt.filter(l => l !== prevLast);
    if (txt.length) prevLast = txt[txt.length - 1];
    const [a, z] = time.split('-->').map(x => x.trim());
    if (!fresh.length || a === z) continue;
    cues.push(`${a} --> ${z}\n${fresh.join('\n')}`);
  }
  return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
}
app.get('/api/yt/sub', async (req, res) => {
  const id = String(req.query.id || '');
  const lang = String(req.query.lang || '');
  const auto = req.query.auto === '1';
  try {
    const j = await ytRaw(id);
    const src = auto ? (j.automatic_captions || {}) : (j.subtitles || {});
    const list = src[lang] || src[lang + '-orig'] || [];
    const v = list.find(x => x.ext === 'vtt');
    if (!v) return res.status(404).send('Altyazı yok');
    const up = await upstreamGet(v.url, { 'User-Agent': (j.http_headers && j.http_headers['User-Agent']) || FF_UA });
    let body = '';
    up.setEncoding('utf8');
    up.on('data', c => { body += c; });
    up.on('end', () => {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(auto ? cleanYtVtt(body) : body);
    });
    up.on('error', e => { if (!res.headersSent) res.status(502).send(e.message); });
  } catch (e) { res.status(502).send(e.message); }
});

// ---- Film bilgisi: süre, ses dilleri, altyazılar ----
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const mediaInfoCache = new Map();
app.get('/api/media/info', async (req, res) => {
  const isLocal = req.query.local === '1';
  let input;
  try { input = isLocal ? safeResolve(req.query.src || '') : resolveRemoteSrc(req.query.src); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!input) return res.status(400).json({ error: 'src gerekli' });
  if (mediaInfoCache.has(input)) return res.json(mediaInfoCache.get(input));
  const args = ['-v', 'error'];
  if (!isLocal) args.push('-user_agent', FF_UA, '-rw_timeout', '15000000');
  args.push('-analyzeduration', '5000000', '-probesize', '5000000',
    '-show_entries', 'format=duration,format_name:stream=index,codec_type,codec_name,height,channels:stream_tags=language,title',
    '-of', 'json', '-i', input);
  const out = await new Promise(resolve => {
    const p = spawn('ffprobe', args);
    let o = '';
    p.stdout.on('data', d => { o += d; });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 20000);
    p.on('exit', () => { clearTimeout(timer); try { resolve(JSON.parse(o)); } catch { resolve(null); } });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  if (!out) return res.status(502).json({ error: 'Dosya bilgisi alınamadı' });
  const streams = out.streams || [];
  const tag = (st, k) => (st.tags && (st.tags[k] || st.tags[k.toUpperCase()])) || '';
  const v = streams.find(st => st.codec_type === 'video');
  const info = {
    duration: parseFloat(out.format && out.format.duration) || 0,
    container: (out.format && out.format.format_name) || '',
    video: v ? { codec: v.codec_name, height: v.height || 0 } : null,
    audio: streams.filter(st => st.codec_type === 'audio').map((st, n) => ({
      n, codec: st.codec_name, channels: st.channels || 0, lang: tag(st, 'language'), title: tag(st, 'title')
    })),
    subs: streams.filter(st => st.codec_type === 'subtitle').map((st, n) => ({
      n, codec: st.codec_name, lang: tag(st, 'language'), title: tag(st, 'title'), text: TEXT_SUBS.has(st.codec_name)
    }))
  };
  mediaInfoCache.set(input, info);
  if (mediaInfoCache.size > 300) mediaInfoCache.delete(mediaInfoCache.keys().next().value);
  res.json(info);
});

// GET /api/session/start?src=...&local=0|1&live=0|1&mode=auto|transcode|copy
app.get('/api/session/start', async (req, res) => {
  const reqStart = Date.now();
  const isLocal = req.query.local === '1';
  const mode = ['auto', 'transcode', 'copy'].includes(req.query.mode) ? req.query.mode : 'copy';
  const lowres = req.query.q === '720';
  const start = Math.max(0, parseFloat(req.query.start) || 0);
  const audio = req.query.audio != null && req.query.audio !== '' ? parseInt(req.query.audio, 10) : 0;
  const subs = String(req.query.subs || '').split(',').filter(x => /^\d+$/.test(x)).map(Number).slice(0, 12);
  let input, input2 = null, ytUa = null, ytTranscode = null;
  let live = req.query.live === '1';
  if (req.query.yt) {
    // YouTube: adresleri yt-dlp ile çöz
    const yt = await ytResolve(String(req.query.yt), lowres ? 720 : 1080).catch(e => ({ error: e.message }));
    if (!yt || yt.error) return res.status(502).json({ error: (yt && yt.error) || 'YouTube videosu açılamadı' });
    input = yt.v.url; input2 = yt.a ? yt.a.url : null; ytUa = yt.ua; live = !!yt.live;
    ytTranscode = !yt.h264;
  } else {
    try {
      input = isLocal ? safeResolve(req.query.src || '') : resolveRemoteSrc(req.query.src);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  if (!input) return res.status(400).json({ error: 'src gerekli' });

  // Aynı anda tek canlı oturum: yeni kanal açılınca eskisini kapat (sağlayıcı bağlantı limiti)
  if (live) for (const [id, s] of sessions) if (s.live) stopSession(id);

  // Canlı HLS'yi ffmpeg'e kendi aracı bağlantımız üzerinden ver: sağlayıcı ffmpeg'in doğrudan
  // liste yenilemesini "HTTP 509" ile reddediyor, tarayıcıların kullandığı bu yol ise sorunsuz
  if (live && !isLocal && !req.query.yt && /\.m3u8(\?|$)/i.test(input)) {
    input = `http://127.0.0.1:${PORT}/api/xtream-stream?url=${encodeURIComponent(input)}`;
  }

  let transcode = mode === 'transcode';
  if (ytTranscode !== null) transcode = ytTranscode;
  else if (mode === 'auto') transcode = needsTranscode(await probe(input, !isLocal));

  const id = crypto.randomUUID();
  const dir = path.join(HLS_TMP_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const session = { id, dir, live, started: reqStart, lastAccess: Date.now(), idleLimit: live ? 45000 : 20 * 60000 };
  sessions.set(id, session);
  res.on('close', () => { if (!res.writableEnded) session.cancelled = true; });

  if (lowres && !req.query.yt) transcode = true;
  const base = { input, input2, ua: ytUa, isRemote: !isLocal, live, transcode, dir, lowres, start, audio, subs: req.query.yt ? [] : subs };
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
  if (req.query.yt) console.log(`YouTube [${req.query.yt}] akış hazır: ${((Date.now() - session.started) / 1000).toFixed(1)}sn`);
  res.json({ id, playlist: `/api/session/${id}/index.m3u8`, transcoded: transcode, start: live ? 0 : start,
    subs: live ? [] : subs.map(n => ({ n, url: `/api/session/${id}/sub_${n}.vtt` })) });
});

app.get('/api/session/:id/:file', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).send('Bulunamadı');
  s.lastAccess = Date.now();
  const filePath = path.join(s.dir, path.basename(req.params.file));
  if (!fs.existsSync(filePath)) {
    // Altyazı henüz yazılmadıysa boş WebVTT ver
    if (/\.vtt$/.test(filePath)) { res.setHeader('Content-Type', 'text/vtt'); res.setHeader('Cache-Control', 'no-store'); return res.send('WEBVTT\n\n'); }
    return res.status(404).send('Segment bulunamadı');
  }
  res.setHeader('Cache-Control', 'no-store');
  if (!s.live && /\.m3u8$/.test(filePath)) {
    const pl = fs.readFileSync(filePath, 'utf-8');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    return res.send(pl.includes('#EXT-X-START') ? pl : pl.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES'));
  }
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

// ---- Jellyfin: aynı adres üzerinden (player.dedplay.nl/web/...) ----
// Jellyfin başka bir adresten iframe ile açılınca tarayıcı (özellikle iPhone/Safari ve Tesla)
// girişi saklamıyordu. Aynı adresten açılınca Jellyfin'in kendi girişi ("Beni Hatırla") kalıcı olur.
// Kalan bütün istekler (/web, /Users, /Items, /socket ...) Jellyfin'e aktarılır
function jfTarget(url) { return new URL(JF_UPSTREAM + url); }
app.use((req, res, next) => {
  if (!JF_PROXY || req.path.startsWith('/api/')) return next();
  const u = jfTarget(req.originalUrl);
  const mod = u.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: u.host };
  Object.keys(headers).forEach(k => { if (k.startsWith('cf-') || k === 'cdn-loop') delete headers[k]; });
  const up = mod.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers }, upRes => {
    const h = { ...upRes.headers };
    if (h.location) {
      try {
        const loc = new URL(h.location, JF_UPSTREAM + '/');
        if (loc.host === u.host || (JF_PUBLIC_HOST && loc.host === JF_PUBLIC_HOST)) h.location = loc.pathname + loc.search;
      } catch {}
    }
    delete h['x-frame-options'];
    res.writeHead(upRes.statusCode, h);
    upRes.pipe(res);
  });
  up.on('error', e => { if (!res.headersSent) res.status(502).send('Jellyfin\'e ulaşılamadı: ' + e.message); else res.end(); });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
});

const server = app.listen(PORT, () => {
  console.log(`Tesla Player ${PORT} portunda çalışıyor, medya kökü: ${MEDIA_ROOT}`);
  if (JF_PROXY) console.log(`Jellyfin bu adres üzerinden açılıyor (kaynak: ${JF_UPSTREAM})`);
});
// Jellyfin canlı bağlantısı (websocket) aktarımı
server.on('upgrade', (req, socket, head) => {
  if (!JF_PROXY || req.url.startsWith('/api/')) return socket.destroy();
  const u = jfTarget(req.url);
  const mod = u.protocol === 'https:' ? https : http;
  const up = mod.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { ...req.headers, host: u.host } });
  up.on('upgrade', (upRes, upSocket, upHead) => {
    let raw = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const [k, v] of Object.entries(upRes.headers)) (Array.isArray(v) ? v : [v]).forEach(x => { raw += `${k}: ${x}\r\n`; });
    socket.write(raw + '\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    const kill = () => { socket.destroy(); upSocket.destroy(); };
    socket.on('error', kill); upSocket.on('error', kill);
    socket.on('close', kill); upSocket.on('close', kill);
  });
  up.on('response', r => { socket.end(`HTTP/1.1 ${r.statusCode} Error\r\n\r\n`); });
  up.on('error', () => socket.destroy());
  up.end();
});
