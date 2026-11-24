function supportsNativeHls() {
  const testVideo = document.createElement('video');
  return testVideo.canPlayType('application/vnd.apple.mpegurl') !== '';
}

function detectPlatform() {
  const ua = navigator.userAgent || "";
  let platform;
  if (/Tesla|QtCarBrowser/i.test(ua) && !/TeslaPlayerTV/.test(ua)) {
    platform = "tesla";
  } else if (/TeslaPlayerTV/.test(ua) || (/Android/i.test(ua) && /\bTV\b|AFT|BRAVIA|MiBOX|MIBOX|Google ?TV|SMART-TV|AndroidTV|Chromecast/i.test(ua))) {
    platform = "tv";
  } else if (/iPhone|iPad|iPod|Android/i.test(ua)) {
    platform = "mobile";
  } else {
    platform = "desktop";
  }
  document.body.classList.add("platform-" + platform);
  return platform;
}
const currentPlatform = detectPlatform();

let appState = {};
let xtreamEnabled = false;

async function fetchState() {
  const r = await fetch('/api/state');
  appState = await r.json();
}

async function postJson(endpoint, body) {
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.error || ('Hata ' + r.status) };
    return j;
  } catch (e) { return { ok: false, error: e.message }; }
}

function saveStateField(endpoint, body) {
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => {});
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

document.querySelectorAll('.drawer-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    const panel = document.getElementById(target === 'iptv' ? 'iptv-side-panel' : target === 'youtube' ? 'yt-side-panel' : 'mp-side-panel');
    panel.classList.toggle('open');
  });
});

// Tam ekran: sadece oynatıcıyı değil bütün sekmeyi (liste + oynatıcı) tam ekrana al ki dokununca liste gelebilsin.
// iPhone Safari'de öğe tam ekranı yok -> sayfa içi tam ekran (sekme çubuğu gizlenir, oynatıcı ekranı kaplar).
function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
document.querySelectorAll('.fullscreen-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.closest('.tab-content') || document.getElementById(btn.dataset.target);
    const req = target.requestFullscreen || target.webkitRequestFullscreen;
    if (document.body.classList.contains('pseudo-fs')) {
      document.body.classList.remove('pseudo-fs');
    } else if (fsElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (req) {
      const r = req.call(target);
      if (r && r.catch) r.catch(() => document.body.classList.add('pseudo-fs'));
    } else {
      document.body.classList.add('pseudo-fs');
    }
  });
});
// body.fs-on: gerçek tam ekran, sayfa içi tam ekran ya da iPhone yan çevrilmiş
const landscapeMq = window.matchMedia('(orientation: landscape) and (max-height: 540px)');
function syncFs() {
  const on = !!fsElement() || document.body.classList.contains('pseudo-fs') ||
    (currentPlatform === 'mobile' && landscapeMq.matches);
  if (on === document.body.classList.contains('fs-on')) return;
  document.body.classList.toggle('fs-on', on);
  // Tam ekrana girince/çıkınca liste kapalı başlasın (dokununca açılır)
  document.querySelectorAll('.side-panel, .mp-browser').forEach(p => p.classList.remove('open'));
}
['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => document.addEventListener(ev, () => {
  const el = fsElement();
  dbg(`tam ekran: ${el ? (el.id || el.tagName) : 'kapalı'}`);
  // Videonun kendi tam ekran düğmesi (ya da çift tık) sadece videoyu büyütür, liste gelemez:
  // çık ve bütün sekmeyi tam ekrana al
  if (el && el.tagName === 'VIDEO') {
    const tab = el.closest('.tab-content');
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    const req = tab && (tab.requestFullscreen || tab.webkitRequestFullscreen);
    if (tab && exit && req) {
      Promise.resolve(exit.call(document)).then(() => req.call(tab)).then(() => {}, e => dbg('sekme tam ekranı reddedildi: ' + (e && e.message)));
    }
  }
  syncFs();
}));
if (landscapeMq.addEventListener) landscapeMq.addEventListener('change', syncFs); else landscapeMq.addListener(syncFs);
new MutationObserver(syncFs).observe(document.body, { attributes: true, attributeFilter: ['class'] });
syncFs();

document.getElementById('mode-m3u-btn').addEventListener('click', () => setIptvMode('m3u'));
document.getElementById('mode-xtream-btn').addEventListener('click', () => setIptvMode('xtream'));

function setIptvMode(mode) {
  document.getElementById('mode-m3u-btn').classList.toggle('active', mode === 'm3u');
  document.getElementById('mode-xtream-btn').classList.toggle('active', mode === 'xtream');
  document.getElementById('m3u-mode').style.display = mode === 'm3u' ? 'block' : 'none';
  document.getElementById('xtream-mode').style.display = mode === 'xtream' ? 'block' : 'none';
  saveStateField('/api/state/m3u-mode', { mode });

  if (mode === 'xtream') {
    renderXtreamAccounts();
    if (!xtreamEnabled) {
      document.getElementById('xt-main').style.display = 'none';
      document.getElementById('xt-acc-form').style.display = 'block';
      return;
    }
    const lastCat = appState.xtreamCategory;
    if (currentXtSection === 'fav' || (favList('xtream').length && !setIptvMode.opened)) showXtreamFavorites();
    else if (lastCat && lastCat.section === currentXtSection) loadXtreamItems(currentXtSection, lastCat.id, lastCat.name);
    else loadXtreamCategories(currentXtSection);
    setIptvMode.opened = true;
  }
}

const iptvVideo = document.getElementById('iptv-video');
let hls = null;

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let name = '';
  let group = '';
  let logo = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const gm = line.match(/group-title="([^"]*)"/i);
      const lm = line.match(/tvg-logo="([^"]*)"/i);
      group = gm ? gm[1].trim() : '';
      logo = lm ? lm[1].trim() : '';
      const idx = line.lastIndexOf(',');
      name = idx >= 0 ? line.slice(idx + 1).trim() : '';
    } else if (line.startsWith('#EXTGRP:')) {
      if (!group) group = line.slice(8).trim();
    } else if (!line.startsWith('#')) {
      channels.push({ name: name || line, url: line, group: group || 'Diğer', logo: logo });
      name = ''; group = ''; logo = '';
    }
  }
  return channels;
}

// ===== Oynatıcı motoru =====
let tsPlayer = null;          // mpegts.js oynatıcı
let liveSessionId = null;     // sunucudaki ffmpeg oturumu
let playToken = 0;            // kanal değişince eski işlemleri iptal etmek için
let watchdogTimer = null;
const statusEl = document.getElementById('iptv-status');

// ===== Teşhis kaydı: oynatıcı olayları sunucu loguna gider (docker logs tesla-player | grep cihaz) =====
const DEV = (() => {
  const ua = navigator.userAgent;
  const kind = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Tesla|QtCarBrowser/.test(ua) ? 'Tesla' : /Mac/.test(ua) ? 'Mac' : 'PC';
  const br = /SamsungBrowser\/[\d.]+/.exec(ua) || /CriOS\/[\d]+|Chrome\/[\d]+|Version\/[\d.]+ (Mobile\/\w+ )?Safari|Firefox\/[\d]+/.exec(ua);
  return kind + ' ' + (br ? br[0].replace(/ Mobile\/\w+/, '') : '?') + ' #' + Math.random().toString(36).slice(2, 6);
})();
let dbgQueue = [], dbgT0 = performance.now(), dbgTimer = null;
function dbg(msg) {
  const line = `${((performance.now() - dbgT0) / 1000).toFixed(1)}s ${msg}`;
  dbgQueue.push(line);
  if (!dbgTimer) dbgTimer = setTimeout(flushDbg, 1500);
}
function flushDbg() {
  dbgTimer = null;
  if (!dbgQueue.length) return;
  const lines = dbgQueue.splice(0, 100);
  fetch('/api/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dev: DEV, lines }), keepalive: true }).catch(() => {});
}
function dbgHls(h, label) {
  h.on(Hls.Events.MANIFEST_PARSED, (_, d) => dbg(`${label} hls: liste tamam (${d.levels.length} seviye)`));
  h.on(Hls.Events.BUFFER_CODECS, (_, d) => dbg(`${label} hls: kodekler ses=${d.audio ? d.audio.codec : '-'} görüntü=${d.video ? d.video.codec : 'YOK'}`));
  h.on(Hls.Events.FRAG_LOADED, (_, d) => { if (d.frag.sn !== 'initSegment' && !h.__fl) { h.__fl = 1; dbg(`${label} hls: ilk parça indi ${Math.round(d.frag.stats.loaded / 1024)}KB`); } });
  h.on(Hls.Events.ERROR, (_, d) => dbg(`${label} hls HATA: ${d.details} fatal=${d.fatal} ${d.reason || (d.error && d.error.message) || ''} ${d.response ? 'http=' + d.response.code : ''}`));
}
(function dbgVideo() {
  const v = document.getElementById('iptv-video');
  ['loadedmetadata', 'playing', 'waiting', 'stalled', 'error', 'pause'].forEach(ev => v.addEventListener(ev, () => {
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
    dbg(`video ${ev} t=${v.currentTime.toFixed(1)} ${v.videoWidth}x${v.videoHeight} kare=${q.totalVideoFrames ?? '?'}${v.error ? ' hata=' + v.error.code + ' ' + (v.error.message || '') : ''}`);
  }));
  dbg(`açıldı: ${navigator.userAgent}`);
  const MS = window.ManagedMediaSource || window.MediaSource;
  dbg(`destek: nativeHLS=${!!document.createElement('video').canPlayType('application/vnd.apple.mpegurl')} hls.js=${typeof Hls !== 'undefined' && Hls.isSupported()} MSE=${!!MS} h264=${MS ? MS.isTypeSupported('video/mp4; codecs="avc1.640028"') : '-'} hevc=${MS ? MS.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"') : '-'}`);
})();

function setStatus(text) {
  // Ekranda yazı gösterilmiyor (kullanıcı istemedi); mesaj sadece sunucu loguna gider
  if (text) dbg(`ekran yazısı (gösterilmedi): "${text}"`);
  statusEl.textContent = '';
  statusEl.classList.remove('show');
}

function isAppleNative() {
  // iPhone/iPad ve Safari: HLS'i kendisi oynatır
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/.test(ua));
}

function canUseMpegts() {
  return typeof mpegts !== 'undefined' && mpegts.getFeatureList().mseLivePlayback && !isAppleNative();
}

function stopPlayback() {
  playToken++;
  if (typeof bgStop === 'function') bgStop();
  if (movie.active && movie.ctx === iptvCtx) setMovieMode(false);
  clearTimeout(watchdogTimer);
  iptvVideo.ontimeupdate = null;
  iptvVideo.onplaying = null;
  iptvVideo.onended = null;
  onDecodeError = null;
  if (hls) { hls.destroy(); hls = null; }
  if (tsPlayer) {
    try { tsPlayer.pause(); tsPlayer.unload(); tsPlayer.detachMediaElement(); tsPlayer.destroy(); } catch {}
    tsPlayer = null;
  }
  if (liveSessionId) {
    saveStateField('/api/session/stop', { id: liveSessionId });
    liveSessionId = null;
  }
  iptvVideo.removeAttribute('src');
  iptvVideo.load();
  setStatus('');
}

function attachHls(url, opts = {}) {
  dbg(`oynatıcı: ${supportsNativeHls() && isAppleNative() ? 'tarayıcının kendi HLS' : Hls.isSupported() ? 'hls.js' : 'doğrudan'} ${opts.session ? '(sunucu akışı)' : ''}`);
  if (supportsNativeHls() && isAppleNative()) {
    iptvVideo.src = url;
  } else if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      startFragPrefetch: true,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      maxLiveSyncPlaybackRate: 1,
      maxBufferLength: 30,
      maxBufferHole: 1,
      nudgeMaxRetry: 10,
      backBufferLength: 30
    });
    dbgHls(hls, opts.session ? 'sunucu-akışı' : 'hls');
    hls.on(Hls.Events.BUFFER_CODECS, (_, data) => {
      // Video izi yoksa (HEVC/4K desteklenmiyor) -> ses gelir, ekran siyah kalır
      if (!data.video && opts.onNoVideo) opts.onNoVideo('codec');
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal && opts.onFatal) opts.onFatal(data.details);
    });
    hls.loadSource(url);
    hls.attachMedia(iptvVideo);
  } else {
    iptvVideo.src = url;
  }
  iptvVideo.play().catch(() => {});
}

function attachMpegts(url, opts = {}) {
  tsPlayer = mpegts.createPlayer(
    { type: 'mpegts', isLive: true, url: new URL(url, location.href).href },
    {
      enableWorker: true,
      lazyLoad: false,
      enableStashBuffer: true,
      stashInitialSize: 1024 * 1024,
      liveBufferLatencyChasing: false,
      autoCleanupSourceBuffer: true
    }
  );
  tsPlayer.on(mpegts.Events.ERROR, (type, detail) => {
    if (opts.onFatal) opts.onFatal(type + ':' + detail);
  });
  tsPlayer.on(mpegts.Events.MEDIA_INFO, info => {
    if (!info || !opts.onNoVideo) return;
    if (info.hasVideo === false) return opts.onNoVideo();
    const vc = info.videoCodec || '';
    const MS = window.ManagedMediaSource || window.MediaSource;
    if (vc && MS && !MS.isTypeSupported(`video/mp4; codecs="${vc}"`)) opts.onNoVideo('codec');
  });
  tsPlayer.attachMediaElement(iptvVideo);
  tsPlayer.load();
  iptvVideo.play().catch(() => {});
}

// Ses geliyor ama görüntü yok mu? (4K/HEVC belirtisi)
function startBlackScreenWatchdog(onBlack) {
  const token = playToken;
  let firedAt = null;
  iptvVideo.onplaying = () => { if (!firedAt) firedAt = Date.now(); };
  const check = () => {
    if (token !== playToken) return;
    if (firedAt && Date.now() - firedAt > 2500 && iptvVideo.currentTime > 1) {
      const q = iptvVideo.getVideoPlaybackQuality ? iptvVideo.getVideoPlaybackQuality() : null;
      const noFrames = q && q.totalVideoFrames === 0;
      if (iptvVideo.videoWidth === 0 || noFrames) onBlack();
      return;
    }
    watchdogTimer = setTimeout(check, 700);
  };
  watchdogTimer = setTimeout(check, 1500);
}

// Sunucuda ffmpeg ile oynat (mode: auto = gerekirse 4K/HEVC -> H.264)
async function playViaSession(src, { live, mode, key, label, retried, low }) {
  const token = playToken;
  low = low || lowResDevice;
  setStatus('');
  try {
    const q = new URLSearchParams({ src, live: live ? '1' : '0', mode: mode || 'auto' });
    if (low) q.set('q', '720');
    const ts = performance.now();
    const r = await fetch('/api/session/start?' + q.toString());
    const data = await r.json();
    dbg(`sunucu oturumu: ${((performance.now() - ts) / 1000).toFixed(1)}sn ${data.playlist ? 'hazır, dönüştürüldü=' + data.transcoded : 'HATA ' + (data.error || r.status)}`);
    if (token !== playToken) {
      if (data.id) saveStateField('/api/session/stop', { id: data.id });
      return;
    }
    if (!data.playlist) {
      // Bir kere otomatik tekrar dene (sağlayıcı bazen ilk istekte geç yanıt veriyor)
      if (!retried) {
        setStatus('Tekrar deneniyor…');
        return playViaSession(src, { live, mode, key, label, retried: true, low });
      }
      setStatus('Kanal açılamadı: ' + (data.error || 'bilinmeyen hata'));
      return;
    }
    liveSessionId = data.id;
    // (720p cihaz moduyla açılan kanallar diğer cihazlar için işaretlenmez)
    if (data.transcoded && !low && key && !(appState.transcodeKeys || []).includes(key)) {
      appState.transcodeKeys = [...(appState.transcodeKeys || []), key];
      saveStateField('/api/state/transcode-key', { key });
    }
    setStatus('');
    if (data.transcoded) setTimeout(() => { if (token === playToken) setStatus(''); }, 4000);
    // 1080p çıktıyı bu cihaz çözemezse 720p ile tekrar aç
    if (!low) onDecodeError = () => {
      if (token !== playToken) return;
      markLowRes(key);
      stopPlayback();
      playViaSession(src, { live, mode: 'transcode', key, label, low: true });
    };
    attachHls(data.playlist, {
      session: true,
      onFatal: () => { if (token === playToken) setStatus('Akış kesildi, kanalı tekrar seçin'); }
    });
  } catch (e) {
    if (token === playToken) setStatus('Kanal açılamadı: ' + e.message);
  }
}

// M3U kanalları (değişmedi: doğrudan oynatılır)
function playChannel(name, url) {
  if (looksLikeMovie(url)) {
    playMovie(url, name);
    document.querySelectorAll('.channel-item, .xt-item').forEach(el => el.classList.remove('playing'));
    return;
  }
  stopPlayback();
  iptvVideo.dataset.title = name;
  if (url.includes('.m3u8') && supportsNativeHls()) {
    iptvVideo.src = url;
  } else if (url.includes('.m3u8') && Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(iptvVideo);
  } else {
    iptvVideo.src = url;
    // Adresinden film olduğu anlaşılmayanlar: süresi uzunsa ya da tarayıcı açamazsa (mkv vb.)
    // film oynatıcıya geç (sarma, ses dili, altyazı; açılamayanı sunucu çevirir)
    const token = playToken;
    iptvVideo.addEventListener('loadedmetadata', () => {
      if (token === playToken && isFinite(iptvVideo.duration) && iptvVideo.duration > 600) {
        dbg('uzun süreli dosya: film moduna alındı');
        playMovie(url, name, { adopt: true });
      }
    }, { once: true });
    iptvVideo.addEventListener('error', () => {
      if (token === playToken && iptvVideo.getAttribute('src')) {
        dbg('tarayıcı açamadı: sunucu üzerinden deneniyor');
        playMovie(url, name, { server: true });
      }
    }, { once: true });
  }
  iptvVideo.play().catch(() => {});
  saveStateField('/api/state/last-channel', { name, url });
  document.querySelectorAll('.channel-item, .xt-item').forEach(el => el.classList.remove('playing'));
}

// Xtream canlı kanal: .ts (hızlı açılış) -> .m3u8 -> sunucu dönüştürme
// 4K/UHD kanallar bu sağlayıcıda HEVC; tarayıcı HLS oynatıcısı TS içindeki HEVC'yi hiçbir cihazda
// oynatamıyor. Önce deneyip sonra dönüştürmek açılışı uzatıyordu: doğrudan sunucuda dönüştür.
function looksLike4K(name) {
  return /\b(4K|UHD|2160p?)\b/i.test(name || '');
}

function canDecodeHevc() {
  const MS = window.ManagedMediaSource || window.MediaSource;
  if (!MS || !canUseMpegts()) return false;
  // Android Chrome "destekliyorum" diyor ama tablet/telefon donanımı 4K/UHD HEVC'yi çoğu zaman çözemiyor
  if (/Android/i.test(navigator.userAgent)) return false;
  return MS.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"') || MS.isTypeSupported('video/mp4; codecs="hev1.1.6.L153.B0"');
}

// hls.js 1.6+ TS içindeki HEVC'yi açabiliyor (1.5 "Unsupported HEVC in M2TS" diyordu).
// Tarayıcı 4K HEVC çözebiliyorsa (Mac/iPhone Safari) 4K kanal sunucuda çevrilmeden oynar.
function hevcDirectOk() {
  if (typeof Hls === 'undefined' || !Hls.isSupported()) return false;
  // Android Chrome "destekliyorum" diyor ama tablet/telefon donanımı 4K HEVC'yi çoğu zaman çözemiyor
  if (/Android/i.test(navigator.userAgent)) return false;
  const MS = window.ManagedMediaSource || window.MediaSource;
  if (!MS) return false;
  return MS.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"') || MS.isTypeSupported('video/mp4; codecs="hev1.1.6.L153.B0"');
}

// 4K/HEVC kanalı doğrudan aç; görüntü çözülemezse sunucu dönüştürmesine geç ve bu cihazda hatırla
function playHevcDirect(item, key, attempt = 0) {
  const token = playToken;
  dbg(`oynatıcı: hls.js (4K/HEVC doğrudan)${attempt ? ' tekrar ' + attempt : ''}`);
  let fellBack = false;
  const fallback = (why, codec) => {
    if (fellBack || token !== playToken) return;
    fellBack = true;
    dbg(`4K doğrudan olmadı (${why}) -> sunucu dönüştürmesi`);
    if (codec) {
      const fails = lsGet('tp-hevc-fail', []);
      if (!fails.includes(key)) { fails.push(key); if (fails.length > 300) fails.shift(); lsSet('tp-hevc-fail', fails); }
    }
    stopPlayback();
    playViaSession(item.url, { live: true, mode: 'transcode', key, label: item.name });
  };
  hls = new Hls();
  dbgHls(hls, 'kanal-4k');
  hls.on(Hls.Events.BUFFER_CODECS, (_, data) => { if (!data.video) fallback('görüntü izi yok', true); });
  let mediaRecovered = false;
  hls.on(Hls.Events.ERROR, (_, data) => {
    // Ölümcül medya hatasında bir kez hls.js'in kendi kurtarmasını dene (Safari ilk açılışta MediaSource'u kapatabiliyor)
    if (data.fatal && data.type === 'mediaError' && !mediaRecovered && hls && token === playToken && !fellBack) {
      mediaRecovered = true;
      dbg(`4K medya hatası (${data.details}) -> kurtarma deneniyor`);
      hls.recoverMediaError();
      return;
    }
    const codecErr = /codec|parsing/i.test(data.details || '') || data.type === 'mediaError';
    if (codecErr && (data.fatal || /Codec/.test(data.details || ''))) fallback(data.details, true);
    // Sağlayıcı kanal değişiminde eski oturumu birkaç sn bırakmıyor (tek bağlantı): bekle, doğrudan tekrar dene
    else if (data.fatal && data.type === 'networkError' && attempt < 2) {
      if (fellBack || token !== playToken) return;
      fellBack = true;
      dbg(`4K ağ hatası (${data.details}) -> ${attempt ? 3 : 1.5} sn sonra tekrar`);
      if (hls) { hls.destroy(); hls = null; }
      setTimeout(() => { if (token === playToken) playHevcDirect(item, key, attempt + 1); }, attempt ? 3000 : 1500);
    }
    else if (data.fatal) fallback(data.details, false);
  });
  const onDecode = () => {
    if (token !== playToken || fellBack) return;
    if (!mediaRecovered && hls) {
      mediaRecovered = true;
      dbg('4K çözme hatası -> kurtarma deneniyor');
      onDecodeError = onDecode;
      hls.recoverMediaError();
      return;
    }
    fallback('çözme hatası', true);
  };
  onDecodeError = onDecode;
  setTimeout(() => {
    if (token !== playToken || fellBack) return;
    const q = iptvVideo.getVideoPlaybackQuality ? iptvVideo.getVideoPlaybackQuality() : {};
    if (!(q.totalVideoFrames > 0) && iptvVideo.videoWidth === 0) fallback('12 sn görüntü yok', true);
  }, 12000);
  hls.loadSource(item.url);
  hls.attachMedia(iptvVideo);
  iptvVideo.play().catch(() => {});
}

let currentLiveItem = null;

// ===== Düşük çözünürlük cihazı: 1080p H.264'ü çözemeyen cihazlar (ör. Android 10 tablet) =====
// Bu cihaza özel (localStorage): bir kere çözme hatası görülünce 1080p kanallar sunucuda 720p'ye çevrilir.
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
// TV (Mi Box / Google TV) 1080p'yi çözebiliyor: eski donmalar sırasında konan "düşük çözünürlük"
// işaretini bir kere sil ve TV'de bu işareti kalıcı yapma (yoksa kanallar gereksiz yere sunucuda çevriliyordu)
if (currentPlatform === 'tv' && !lsGet('tp-tv-lowres-reset1', false)) {
  lsSet('tp-lowres', false); lsSet('tp-lowres-keys', []); lsSet('tp-tv-lowres-reset1', true);
}
let lowResDevice = currentPlatform === 'tv' ? false : lsGet('tp-lowres', false);
let lowResKeys = currentPlatform === 'tv' ? [] : lsGet('tp-lowres-keys', []);
const tvDecodeRetried = new Set();
function markLowRes(key) {
  if (currentPlatform === 'tv') { dbg('TV: çözme hatası (işaret kalıcı yapılmadı)'); return; }
  if (!lowResDevice) { lowResDevice = true; lsSet('tp-lowres', true); dbg('cihaz 1080p çözemiyor -> 720p moduna geçildi'); }
  if (key && !lowResKeys.includes(key)) { lowResKeys.push(key); if (lowResKeys.length > 300) lowResKeys.shift(); lsSet('tp-lowres-keys', lowResKeys); }
}
// Çözme hatası (MEDIA_ERR_DECODE = 3) gelince o anki oynatmanın yedeği çalışsın
let onDecodeError = null;
iptvVideo.addEventListener('error', () => {
  if (iptvVideo.error && iptvVideo.error.code === 3 && onDecodeError) { const f = onDecodeError; onDecodeError = null; f(); }
});

function playXtreamLive(item) {
  stopPlayback();
  iptvVideo.dataset.title = item.name || '';
  currentLiveItem = item;
  const token = playToken;
  const key = item.key || item.url;
  saveStateField('/api/state/last-channel', { name: item.name, url: item.url, tsUrl: item.tsUrl || '', key, xtream: true });

  dbg(`kanal: "${item.name}"`);
  // 4K/UHD (HEVC): cihaz çözebiliyorsa doğrudan, tam kalitede (bu cihazda daha önce olmadıysa)
  if (looksLike4K(item.name) && hevcDirectOk() && !lsGet('tp-hevc-fail', []).includes(key)) {
    playHevcDirect(item, key);
    return;
  }
  // 4K/UHD (HEVC) ama cihaz çözemiyor -> sunucuda dönüştür
  if ((appState.transcodeKeys || []).includes(key) || looksLike4K(item.name) || (lowResDevice && lowResKeys.includes(key))) {
    playViaSession(item.url, { live: true, mode: 'transcode', key, label: item.name });
    return;
  }

  // Diğer kanallar: ilk sürümdeki oynatma. Tek fark: tarayıcının kendi HLS oynatıcısı sadece
  // iPhone/iPad/Safari'de. Güncel Chrome (Android tablet dahil) de HLS'i kendisi oynatıyor ama
  // HEVC kanalda hata vermeden donuk kalıyordu; hls.js ise HEVC'yi açıkça bildiriyor.
  const url = item.url;
  // Safari'nin kendi HLS'i kanal başına 2-5 sn bekletiyordu; hls.js varsa (güncel Mac/iPhone) onu kullan
  if (url.includes('.m3u8') && supportsNativeHls() && isAppleNative() && !Hls.isSupported()) {
    dbg('oynatıcı: tarayıcının kendi HLS (doğrudan kanal)');
    // Safari HEVC'li veya uyumsuz sesli (AC3/MP2) .ts parçalarını çözemiyor ve hls.js gibi
    // nedenini söylemiyor: "Media failed to decode" verip duruyor. O zaman sunucuya geç.
    let sentToServer = false;
    const toServer = (why, mode) => {
      if (sentToServer || token !== playToken) return;
      sentToServer = true;
      dbg(`Safari: ${why} -> sunucu akışına geçiliyor`);
      stopPlayback();
      playViaSession(item.url, { live: true, mode, key, label: item.name });
    };
    onDecodeError = () => toServer('çözme hatası', 'transcode');
    // Hata da vermeden 12 sn'de hiç kare gelmezse: sunucu bakıp gerekirse dönüştürsün
    setTimeout(() => {
      if (token !== playToken || sentToServer) return;
      const q = iptvVideo.getVideoPlaybackQuality ? iptvVideo.getVideoPlaybackQuality() : {};
      if (!(q.totalVideoFrames > 0) && iptvVideo.currentTime < 0.5) toServer('12 sn görüntü yok', 'auto');
    }, 12000);
    iptvVideo.src = url;
  } else if (url.includes('.m3u8') && Hls.isSupported()) {
    dbg('oynatıcı: hls.js (doğrudan kanal)');
    // TV kutuları (Mi Box) zayıf: daha az tampon, yayının birkaç parça gerisinden, ön indirme açık
    hls = new Hls(currentPlatform === 'tv' ? { startFragPrefetch: true, maxBufferLength: 20, backBufferLength: 10,
      liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 10, capLevelToPlayerSize: true, enableWorker: true } : {});
    dbgHls(hls, 'kanal');
    // Tek ek kural: görüntü izi hiç çözülemiyorsa (HEVC kanal) sunucuda dönüştür
    let sentToServer = false;
    const toServer = () => {
      if (sentToServer || token !== playToken) return;
      dbg('HEVC görüldü -> sunucu dönüştürmesine geçiliyor');
      sentToServer = true;
      stopPlayback();
      playViaSession(item.url, { live: true, mode: 'transcode', key, label: item.name });
    };
    hls.on(Hls.Events.BUFFER_CODECS, (_, data) => { if (!data.video) toServer(); });
    // Cihaz bu kanalın görüntüsünü çözemiyor (ör. tablette 1080p) -> sunucuda 720p'ye çevir
    onDecodeError = () => {
      if (token !== playToken || sentToServer) return;
      // TV: tek seferlik bir çözme hatası (ör. yayındaki bozuk kare) için önce doğrudan bir kez daha dene
      if (currentPlatform === 'tv' && !tvDecodeRetried.has(key)) {
        tvDecodeRetried.add(key);
        dbg('TV: çözme hatası -> doğrudan bir kez daha');
        sentToServer = true;
        stopPlayback();
        playXtreamLive(item);
        return;
      }
      if (currentPlatform === 'tv') { dbg('TV: çözme hatası tekrarladı -> sunucu dönüştürmesi'); return toServer(); }
      // Mac/iPhone 1080p'yi çözebiliyor: hata yayının kendisinde (ör. bozuk H.264) -> sadece bu kanal sunucuda
      if (isAppleNative()) { dbg('çözme hatası (Safari) -> sunucu dönüştürmesi'); return toServer(); }
      dbg('çözme hatası -> sunucuda 720p');
      markLowRes(key);
      sentToServer = true;
      stopPlayback();
      playViaSession(item.url, { live: true, mode: 'transcode', key, label: item.name, low: true });
    };
    // hls.js HEVC'li TS'yi açıkça reddediyor: "Unsupported HEVC in M2TS found"
    hls.on(Hls.Events.ERROR, (_, data) => {
      const why = String(data.reason || (data.error && data.error.message) || '');
      if (data.details === 'fragParsingError' && /HEVC|H\.?265/i.test(why)) toServer();
      // hls.js 1.6+ HEVC'yi ayrıştırıyor; cihaz çözemezse kodek/medya hatası olarak geliyor
      else if (/Codec/.test(data.details || '') || (data.fatal && data.type === 'mediaError')) toServer();
    });
    hls.loadSource(url);
    hls.attachMedia(iptvVideo);
  } else {
    iptvVideo.src = url;
  }
  iptvVideo.play().catch(() => {});
}

// ===== Favoriler =====
// Favoriler tek düz liste (başlık yok), ama eklendikleri grubun (Xtream kategorisi / M3U grubu)
// sağlayıcıdaki sırasına göre dizilir: TR grupları bir arada, sonra NL vb. Grubun içinde kanallar
// o gruptaki sırayla; bir grup elle sıralandıysa o grubun içi o sırayla.
function favGroups(kind) {
  const manual = appState.favoritesManualOrder || {};
  const groups = new Map();
  (appState.favorites || []).filter(f => f.kind === kind && f.acct === favScopeC(kind)).forEach((f, i) => {
    const g = f.group || '';
    if (!groups.has(g)) groups.set(g, { group: g, pos: f.groupPos, first: i, items: [] });
    const G = groups.get(g);
    if (G.pos == null && f.groupPos != null) G.pos = f.groupPos;
    G.items.push(f);
  });
  const out = [...groups.values()];
  out.forEach(G => { if (!manual[kind + '|' + G.group]) G.items.sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9)); });
  // Grubu henüz bilinmeyenler en sonda
  return out.sort((a, b) => (a.group ? 0 : 1) - (b.group ? 0 : 1) || (a.pos ?? 1e9) - (b.pos ?? 1e9) || a.first - b.first);
}
// Favoriler her M3U listesine / Xtream hesabına ayrı: bu cihazda açık olan listeninkiler gösterilir
function favScopeC(kind) { return kind === 'm3u' ? appState.activeM3u : kind === 'xtream' ? appState.activeXtream : ''; }
function favList(kind) {
  return favGroups(kind).flatMap(G => G.items);
}

async function saveFavOrder(kind, group, ids) {
  const r = await fetch('/api/state/favorites-order', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, group, ids, acct: favScopeC(kind) })
  }).then(r => r.json()).catch(() => null);
  if (!r || !r.ok) { showToast('Sıra kaydedilemedi'); return; }
  appState.favorites = r.favorites;
  appState.favoritesManualOrder = r.favoritesManualOrder;
  showToast('Sıra kaydedildi');
}

// Favorilerde: kısa dokunuş = aç; ~0,8 sn basılı tut = kaldır (kanal "kalkar");
// kalkınca sürükle = sırasını değiştir; hiç kıpırdatmadan bırak = favorilerden çıkar.
// Mac/PC'de fareyle aynı; sağ tık = çıkar.
function bindFavItem(el, kind, id, onTap, onRemove, group) {
  group = group || '';
  el.dataset.favId = id;
  el.dataset.favKind = kind;
  el.dataset.favGroup = group;
  let timer = null, lifted = false, dragging = false, suppressClick = false;
  let sx = 0, sy = 0, lastType = 'mouse', scrollTimer = null;
  const container = () => el.parentElement;
  // Sürükleme sadece aynı grubun kanalları arasında (gruplar bir arada kalsın)
  const sameGroup = c => c.dataset && c.dataset.favKind === kind && (c.dataset.favGroup || '') === group;
  const siblings = () => [...container().children].filter(c => c.dataset.favId && sameGroup(c));
  const cancelTimer = () => { clearTimeout(timer); timer = null; el.classList.remove('pressing'); };

  // Kalktıktan sonra hareketleri tüm sayfadan izle (öğe listede taşınınca tarayıcı öğe takibini bırakıyor)
  const onMove = e => {
    if (!dragging && Math.abs(e.clientY - sy) > 8) { dragging = true; el.classList.add('dragging'); }
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    const over = document.elementsFromPoint(e.clientX, e.clientY)
      .map(x => x.closest && x.closest('[data-fav-kind]'))
      .find(x => x && x !== el && sameGroup(x) && x.parentElement === container());
    if (over) {
      const r = over.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      const ref = before ? over : over.nextSibling;
      if (ref !== el && el.nextSibling !== ref) container().insertBefore(el, ref);
    }
    // Listenin kenarına gelince kaydır
    const scroller = el.closest('.side-panel, .mp-browser');
    clearInterval(scrollTimer); scrollTimer = null;
    if (scroller) {
      const pr = scroller.getBoundingClientRect();
      const dir = e.clientY < pr.top + 60 ? -1 : e.clientY > pr.bottom - 60 ? 1 : 0;
      if (dir) scrollTimer = setInterval(() => scroller.scrollBy(0, dir * 12), 16);
    }
  };
  const onTouchMove = e => { if (lifted) e.preventDefault(); };
  const onUp = async () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('touchmove', onTouchMove);
    clearInterval(scrollTimer); scrollTimer = null;
    el.classList.remove('lifted', 'dragging', 'pressing');
    document.body.classList.remove('fav-dragging');
    const wasDragging = dragging;
    lifted = false; dragging = false;
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 400);
    if (wasDragging) await saveFavOrder(kind, group, siblings().map(c => c.dataset.favId));
    else onRemove();
  };
  const onCancel = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('touchmove', onTouchMove);
    clearInterval(scrollTimer); scrollTimer = null;
    el.classList.remove('lifted', 'dragging', 'pressing');
    document.body.classList.remove('fav-dragging');
    if (dragging) saveFavOrder(kind, group, siblings().map(c => c.dataset.favId));
    lifted = false; dragging = false;
  };

  el.addEventListener('pointerdown', e => {
    if (e.button && e.button !== 0) return;
    lastType = e.pointerType; sx = e.clientX; sy = e.clientY;
    el.classList.add('pressing');
    timer = setTimeout(() => {
      timer = null; lifted = true;
      el.classList.remove('pressing'); el.classList.add('lifted');
      document.body.classList.add('fav-dragging');
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch {} }
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
    }, LONG_PRESS_MS);
  });
  // Kalkmadan önce kaydırma/kıpırdatma = basılı tutmayı iptal et
  el.addEventListener('pointermove', e => {
    if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) cancelTimer();
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => el.addEventListener(ev, () => { if (timer) cancelTimer(); }));
  // Dokunmatikte kalktıktan sonra sayfa kaymasın (ilk hareketten önce engellenmeli)
  el.addEventListener('touchmove', e => { if (lifted) e.preventDefault(); }, { passive: false });
  el.addEventListener('click', e => {
    if (suppressClick || lifted) { e.preventDefault(); e.stopPropagation(); return; }
    onTap();
  });
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    // Android'de uzun basma da contextmenu tetikler: sadece gerçek fare sağ tıkı çıkarır
    if (lastType === 'mouse' && !lifted) { cancelTimer(); onRemove(); }
  });
}
function isFav(kind, id) {
  return (appState.favorites || []).some(f => f.kind === kind && f.id === String(id) && f.acct === favScopeC(kind));
}
// Normal listede basılı tutmak sadece EKLER (kazara silinmesin); çıkarmak Favoriler sekmesinden.
async function addFav(item) {
  if (isFav(item.kind, item.id)) { showToast('★ Zaten favorilerde'); return false; }
  return toggleFav(item);
}
async function toggleFav(item) {
  const r = await fetch('/api/state/favorite-toggle', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { ...item, acct: item.acct || favScopeC(item.kind) } })
  }).then(r => r.json()).catch(() => null);
  if (!r || !r.ok) { showToast('Favori kaydedilemedi'); return false; }
  appState.favorites = r.favorites;
  showToast(r.added ? '★ Favorilere eklendi' : 'Favorilerden çıkarıldı');
  return r.added;
}

let toastTimer = null;
function showToast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// Basılı tutma (dokunmatik + fare). Kısa dokunuş = onTap, ~0,8 sn basılı tutma = onLong.
// Mac/PC'de sağ tık da onLong.
const LONG_PRESS_MS = 800;
function bindPress(el, onTap, onLong) {
  let timer = null, fired = false, sx = 0, sy = 0;
  const cancel = () => { clearTimeout(timer); timer = null; el.classList.remove('pressing'); };
  el.addEventListener('pointerdown', e => {
    if (e.button && e.button !== 0) return;
    fired = false; sx = e.clientX; sy = e.clientY;
    el.classList.add('pressing');
    timer = setTimeout(() => {
      timer = null; fired = true; el.classList.remove('pressing');
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch {} }
      onLong();
    }, LONG_PRESS_MS);
  });
  el.addEventListener('pointermove', e => {
    if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) cancel();
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => el.addEventListener(ev, cancel));
  el.addEventListener('click', e => {
    if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; return; }
    onTap();
  });
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!fired) { cancel(); onLong(); }
    fired = false;
  });
}

function itemHtml(icon, name, fav) {
  return (icon ? `<img src="${icon}">` : '') + `<span>${name}</span>` + (fav ? '<span class="fav-star">★</span>' : '');
}

let lastM3UChannels = [];
let m3uAllChannels = [];
let m3uGroups = {};
let m3uSelectedUrl = null;

function m3uItem(text, onClick) {
  const el = document.createElement('div');
  el.className = 'channel-item';
  el.textContent = text;
  el.onclick = onClick;
  return el;
}

function m3uFavItemData(ch) {
  return { kind: 'm3u', id: ch.url, name: ch.name, url: ch.url, icon: ch.logo || '' };
}
function m3uMarkPlaying(el) {
  document.querySelectorAll('.channel-item').forEach(x => x.classList.remove('playing'));
  el.classList.add('playing');
}

function showM3uGroups() {
  const list = document.getElementById('m3u-channel-list');
  list.innerHTML = '';
  list.appendChild(m3uItem('★ Favoriler (' + favList('m3u').length + ')', showM3uFavorites));
  list.appendChild(m3uItem('📺 Tüm Kanallar (' + m3uAllChannels.length + ')', () => showM3uChannels(m3uAllChannels, true)));
  Object.keys(m3uGroups).forEach(g => {
    list.appendChild(m3uItem('📁 ' + g + ' (' + m3uGroups[g].length + ')', () => showM3uChannels(m3uGroups[g], true)));
  });
}

// Favoriler: dokun = oynat; basılı tut + sürükle = sırala; basılı tutup bırak (Mac'te sağ tık) = favoriden çıkar
function showM3uFavorites() {
  const list = document.getElementById('m3u-channel-list');
  list.innerHTML = '';
  list.appendChild(m3uItem('⬅ Gruplar', showM3uGroups));
  const favs = favList('m3u');
  if (!favs.length) {
    list.insertAdjacentHTML('beforeend', '<p class="hint">Bu listede henüz favori yok. Bir kanalın üzerine basılı tut (Mac/PC\'de sağ tıkla), favorilere eklensin.</p>');
    return;
  }
  list.insertAdjacentHTML('beforeend', '<p class="hint">Basılı tutup sürükle: sırala · Basılı tutup bırak: çıkar</p>');
  favs.forEach(f => {
    const el = document.createElement('div');
    el.className = 'channel-item';
    el.innerHTML = itemHtml('', String(f.name).replace(/</g, '&lt;'), false);
    if (m3uSelectedUrl && f.url === m3uSelectedUrl) el.classList.add('playing');
    bindFavItem(el, 'm3u', f.id, () => {
      m3uSelectedUrl = f.url;
      playChannel(f.name, f.url);
      m3uMarkPlaying(el);
    }, async () => {
      await toggleFav({ kind: 'm3u', id: f.id, name: f.name });
      showM3uFavorites();
    }, f.group);
    list.appendChild(el);
  });
}

function showM3uChannels(channels, withBack) {
  const list = document.getElementById('m3u-channel-list');
  list.innerHTML = '';
  if (withBack) {
    list.appendChild(m3uItem('⬅ Gruplar', showM3uGroups));
  }
  channels.forEach(ch => {
    const el = document.createElement('div');
    el.className = 'channel-item';
    el.innerHTML = itemHtml('', ch.name.replace(/</g, '&lt;'), isFav('m3u', ch.url));
    if (m3uSelectedUrl && ch.url === m3uSelectedUrl) el.classList.add('playing');
    bindPress(el, () => {
      m3uSelectedUrl = ch.url;
      playChannel(ch.name, ch.url);
      m3uMarkPlaying(el);
    }, async () => {
      if (await addFav(m3uFavItemData(ch))) el.insertAdjacentHTML('beforeend', '<span class="fav-star">★</span>');
    });
    list.appendChild(el);
  });
}

// Başka listeye ait olduğu halde bu listeye yazılmış favorileri ayıkla, sahipsizleri yerine koy
async function fixM3uFavs(channels, listId) {
  if (!listId || listId !== appState.activeM3u || !channels.length) return;
  const urls = new Set(channels.map(c => c.url));
  const names = new Set(channels.map(c => c.name));
  const here = f => urls.has(f.url || f.id) || urls.has(f.id) || names.has(f.name);
  const known = new Set((appState.m3uLists || []).map(l => l.id));
  const favs = (appState.favorites || []).filter(f => f.kind === 'm3u');
  const release = favs.filter(f => f.acct === listId && !here(f)).map(f => f.id);
  const claim = favs.filter(f => (f.acct === '?' || !known.has(f.acct)) && here(f)).map(f => f.id);
  if (!release.length && !claim.length) return;
  const r = await postJson('/api/state/m3u-fav-fix', { list: listId, release, claim });
  if (!r.ok || listId !== appState.activeM3u) return;
  appState.favorites = r.favorites;
  dbg(`favoriler düzeltildi: ${release.length} başka listeye ait, ${claim.length} bu listeye alındı`);
  const first = document.querySelector('#m3u-channel-list .channel-item');
  if (first && first.textContent.startsWith('★ Favoriler')) showM3uGroups();
}

function renderChannels(channels, autoSelectUrl, listId) {
  m3uAllChannels = channels;
  m3uSelectedUrl = autoSelectUrl || null;
  m3uGroups = {};
  channels.forEach(ch => {
    if (!m3uGroups[ch.group]) m3uGroups[ch.group] = [];
    m3uGroups[ch.group].push(ch);
  });
  fixM3uFavs(channels, listId);
  const last = autoSelectUrl ? channels.find(c => c.url === autoSelectUrl) : null;
  if (last) {
    showM3uChannels(m3uGroups[last.group], true);
  } else {
    showM3uGroups();
  }
}

function loadM3UFromUrl(url, autoSelectUrl, listId) {
  fetch('/api/m3u-proxy?url=' + encodeURIComponent(url))
    .then(r => {
      return r.text();
    })
    .then(text => {
      const channels = parseM3U(text);
      if (channels.length === 0) {
        document.getElementById('m3u-channel-list').innerHTML = '<p style="color:#f66">Kanal bulunamadı, M3U formatı hatalı olabilir.</p>';
        return;
      }
      renderChannels(channels, autoSelectUrl, listId);
    })
    .catch(err => {
      document.getElementById('m3u-channel-list').innerHTML = '<p style="color:#f66">Hata: ' + err.message + '</p>';
    });
}

// ---- M3U listeleri (sunucuda kayıtlı, birden çok) ----
function renderM3uPicker() {
  const sel = document.getElementById('m3u-list-select');
  const lists = appState.m3uLists || [];
  sel.innerHTML = '';
  if (!lists.length) {
    const o = document.createElement('option');
    o.textContent = '(liste yok, aşağıdan ekleyin)';
    sel.appendChild(o);
    sel.disabled = true;
  } else {
    sel.disabled = false;
    lists.forEach(l => {
      const o = document.createElement('option');
      o.value = l.id;
      o.textContent = (l.type === 'file' ? '📄 ' : '🔗 ') + l.name;
      if (l.id === appState.activeM3u) o.selected = true;
      sel.appendChild(o);
    });
  }
  if (!lists.length) document.getElementById('m3u-add-form').style.display = 'block';
  document.getElementById('m3u-list-rename').disabled = !lists.length;
  document.getElementById('m3u-list-delete').disabled = !lists.length;
}

async function loadActiveM3u(autoSelectUrl) {
  const l = (appState.m3uLists || []).find(x => x.id === appState.activeM3u);
  const box = document.getElementById('m3u-channel-list');
  if (!l) { box.innerHTML = '<p style="color:#999">Henüz liste eklenmedi.</p>'; return; }
  box.innerHTML = '<p style="color:#999">Yükleniyor...</p>';
  if (l.type === 'file') {
    try {
      const r = await fetch('/api/m3u-file-content?id=' + encodeURIComponent(l.id));
      if (!r.ok) throw new Error('dosya bulunamadı');
      const channels = parseM3U(await r.text());
      if (!channels.length) { box.innerHTML = '<p style="color:#f66">Kanal bulunamadı, M3U formatı hatalı olabilir.</p>'; return; }
      renderChannels(channels, autoSelectUrl, l.id);
    } catch (e) { box.innerHTML = '<p style="color:#f66">Hata: ' + e.message + '</p>'; }
  } else {
    loadM3UFromUrl(l.value, autoSelectUrl, l.id);
  }
}

function applyM3uReply(r) {
  appState.m3uLists = r.m3uLists;
  appState.activeM3u = r.activeM3u;
  if (r.favorites) appState.favorites = r.favorites;
  if (r.favoritesManualOrder) appState.favoritesManualOrder = r.favoritesManualOrder;
  renderM3uPicker();
}

document.getElementById('m3u-list-select').addEventListener('change', async e => {
  const r = await postJson('/api/state/m3u-select', { id: e.target.value });
  if (!r.ok) return showToast(r.error || 'Liste açılamadı');
  applyM3uReply(r);
  loadActiveM3u();
});

document.getElementById('m3u-list-add').addEventListener('click', () => {
  const f = document.getElementById('m3u-add-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
  if (f.style.display === 'block') document.getElementById('m3u-url').focus();
});

document.getElementById('m3u-list-rename').addEventListener('click', async () => {
  const l = (appState.m3uLists || []).find(x => x.id === appState.activeM3u);
  if (!l) return;
  const name = prompt('Liste adı:', l.name);
  if (!name || !name.trim()) return;
  const r = await postJson('/api/state/m3u-rename', { id: l.id, name });
  if (r.ok) applyM3uReply(r); else showToast(r.error || 'Kaydedilemedi');
});

document.getElementById('m3u-list-delete').addEventListener('click', async () => {
  const l = (appState.m3uLists || []).find(x => x.id === appState.activeM3u);
  if (!l || !confirm('"' + l.name + '" listesi silinsin mi?')) return;
  const r = await postJson('/api/state/m3u-delete', { id: l.id });
  if (!r.ok) return showToast(r.error || 'Silinemedi');
  applyM3uReply(r);
  showToast('Liste silindi');
  loadActiveM3u();
});

document.getElementById('m3u-load-btn').addEventListener('click', async () => {
  const input = document.getElementById('m3u-url');
  const url = input.value.trim();
  if (!url) return;
  const r = await postJson('/api/state/m3u-url', { url });
  if (!r.ok) return showToast(r.error || 'Kaydedilemedi');
  input.value = '';
  applyM3uReply(r);
  showToast('Liste kaydedildi');
  document.getElementById('m3u-add-form').style.display = 'none';
  loadActiveM3u();
});

document.getElementById('m3u-file-load-btn').addEventListener('click', async () => {
  const fileInput = document.getElementById('m3u-file');
  const file = fileInput.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('m3ufile', file);
  let r;
  try { r = await fetch('/api/state/m3u-file', { method: 'POST', body: formData }).then(x => x.json()); }
  catch (e) { return showToast('Yüklenemedi'); }
  if (!r.ok) return showToast(r.error || 'Yüklenemedi');
  fileInput.value = '';
  applyM3uReply(r);
  showToast('Liste kaydedildi');
  document.getElementById('m3u-add-form').style.display = 'none';
  loadActiveM3u();
});

// ---- Xtream hesapları (sunucuda kayıtlı, birden çok) ----
function renderXtreamAccounts() {
  const sel = document.getElementById('xt-account-select');
  const accs = appState.xtreamAccounts || [];
  sel.innerHTML = '';
  if (!accs.length) {
    const o = document.createElement('option');
    o.textContent = '(hesap yok, ＋ ile ekleyin)';
    sel.appendChild(o);
    sel.disabled = true;
  } else {
    sel.disabled = false;
    accs.forEach(a => {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.name;
      if (a.id === appState.activeXtream) o.selected = true;
      sel.appendChild(o);
    });
  }
  document.getElementById('xt-acc-rename').disabled = !accs.length;
  document.getElementById('xt-acc-delete').disabled = !accs.length;
}

function applyXtreamReply(r) {
  appState.xtreamAccounts = r.xtreamAccounts;
  appState.activeXtream = r.activeXtream;
  appState.favorites = r.favorites;
  appState.xtreamCategory = null;
  xtreamEnabled = r.xtreamEnabled;
  renderXtreamAccounts();
  document.getElementById('xt-acc-form').style.display = xtreamEnabled ? 'none' : 'block';
  document.getElementById('xt-main').style.display = xtreamEnabled ? 'block' : 'none';
  if (xtreamEnabled) { setIptvMode.opened = true; loadXtreamCategories(currentXtSection === 'fav' ? 'live' : currentXtSection); }
}

document.getElementById('xt-account-select').addEventListener('change', async e => {
  const r = await postJson('/api/state/xtream-select', { id: e.target.value });
  if (!r.ok) return showToast(r.error || 'Hesap açılamadı');
  applyXtreamReply(r);
});

document.getElementById('xt-acc-add').addEventListener('click', () => {
  const f = document.getElementById('xt-acc-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('xt-acc-save').addEventListener('click', async () => {
  const btn = document.getElementById('xt-acc-save');
  const body = {
    name: document.getElementById('xt-acc-name').value,
    server: document.getElementById('xt-acc-server').value,
    username: document.getElementById('xt-acc-user').value,
    password: document.getElementById('xt-acc-pass').value
  };
  btn.disabled = true; btn.textContent = 'Bağlanılıyor...';
  const r = await postJson('/api/state/xtream-add', body);
  btn.disabled = false; btn.textContent = 'Kaydet ve Bağlan';
  if (!r.ok) return showToast(r.error || 'Hesap eklenemedi');
  ['xt-acc-name', 'xt-acc-server', 'xt-acc-user', 'xt-acc-pass'].forEach(id => { document.getElementById(id).value = ''; });
  applyXtreamReply(r);
  showToast('Hesap kaydedildi');
});

document.getElementById('xt-acc-rename').addEventListener('click', async () => {
  const a = (appState.xtreamAccounts || []).find(x => x.id === appState.activeXtream);
  if (!a) return;
  const name = prompt('Hesap adı:', a.name);
  if (!name || !name.trim()) return;
  const r = await postJson('/api/state/xtream-rename', { id: a.id, name });
  if (r.ok) { appState.xtreamAccounts = r.xtreamAccounts; renderXtreamAccounts(); } else showToast(r.error || 'Kaydedilemedi');
});

document.getElementById('xt-acc-delete').addEventListener('click', async () => {
  const a = (appState.xtreamAccounts || []).find(x => x.id === appState.activeXtream);
  if (!a || !confirm('"' + a.name + '" hesabı ve favorileri silinsin mi?')) return;
  const r = await postJson('/api/state/xtream-delete', { id: a.id });
  if (!r.ok) return showToast(r.error || 'Silinemedi');
  applyXtreamReply(r);
  showToast('Hesap silindi');
});


let currentXtSection = 'live';

document.querySelectorAll('.xt-sec-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.xt-sec-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (btn.dataset.sec === 'fav') return showXtreamFavorites();
    currentXtSection = btn.dataset.sec;
    saveStateField('/api/state/xtream-section', { section: currentXtSection });
    loadXtreamCategories(currentXtSection);
  });
});

function xtBreadcrumb(text, onClick) {
  const bc = document.getElementById('xt-breadcrumb');
  bc.textContent = text;
  bc.onclick = onClick || null;
}

function loadXtreamCategories(section) {
  xtView = { kind: 'cats', section };
  xtBreadcrumb('Kategoriler yükleniyor...');
  const type = section === 'vod' ? 'vod' : section === 'series' ? 'series' : 'live';
  fetch(`/api/xtream/categories?type=${type}`)
    .then(r => r.json())
    .then(cats => {
      xtBreadcrumb('Kategoriler');
      const list = document.getElementById('xt-list');
      list.innerHTML = '';
      if (!Array.isArray(cats)) {
        list.innerHTML = '<p style="color:#f66">Hata: ' + (cats.error || 'bilinmeyen') + '</p>';
        return;
      }
      cats.forEach(cat => {
        const el = document.createElement('div');
        el.className = 'xt-item';
        el.textContent = cat.category_name;
        el.onclick = () => loadXtreamItems(section, cat.category_id, cat.category_name);
        list.appendChild(el);
      });
    });
}

function backToXtreamCategories(section) {
  saveStateField('/api/state/xtream-category', {});
  appState.xtreamCategory = null;
  loadXtreamCategories(section);
}

function addXtreamLiveItem(list, item, onToggled, inFavTab) {
  const el = document.createElement('div');
  el.className = 'xt-item';
  el.innerHTML = itemHtml(item.icon, item.name, isFav('xtream', item.key));
  if (currentLiveItem && currentLiveItem.key && currentLiveItem.key === item.key) el.classList.add('playing');
  const fromView = xtView;
  const open = () => {
    xtPlayingFrom = fromView;
    playXtreamLive(item);
    document.querySelectorAll('.xt-item').forEach(x => x.classList.remove('playing'));
    el.classList.add('playing');
  };
  if (inFavTab) {
    bindFavItem(el, 'xtream', item.key, open, async () => {
      await toggleFav({ kind: 'xtream', id: item.key, name: item.name });
      onToggled(el);
    }, item.group);
    list.appendChild(el);
    return;
  }
  bindPress(el, open, async () => {
    const fav = { kind: 'xtream', id: item.key, name: item.name, url: item.url, tsUrl: item.tsUrl, icon: item.icon, num: item.num,
      group: item.group || (xtCurrentCategory && xtCurrentCategory.id) || '', groupName: (xtCurrentCategory && xtCurrentCategory.name) || '' };
    if (inFavTab) { await toggleFav(fav); onToggled(el); }
    else if (await addFav(fav)) onToggled(el);
  });
  list.appendChild(el);
}

// Ekrandaki liste ve izlenen kanalın geldiği liste (tam ekranda o grubun listesi gösterilir)
let xtView = null;
let xtPlayingFrom = null;
function sameView(a, b) { return !!a && !!b && a.kind === b.kind && a.section === b.section && String(a.id) === String(b.id); }
function restorePlayingList() {
  if (!xtPlayingFrom || sameView(xtView, xtPlayingFrom) || document.getElementById('xtream-mode').style.display === 'none') return false;
  const v = xtPlayingFrom;
  if (v.kind === 'fav') showXtreamFavorites();
  else loadXtreamItems(v.section, v.id, v.name);
  return true;
}
function scrollToPlaying() {
  const el = document.querySelector('#iptv-side-panel .xt-item.playing, #iptv-side-panel .channel-item.playing');
  if (el) el.scrollIntoView({ block: 'center' });
}

function showXtreamFavorites() {
  xtView = { kind: 'fav' };
  currentXtSection = 'fav';
  saveStateField('/api/state/xtream-section', { section: 'fav' });
  document.querySelectorAll('.xt-sec-btn').forEach(b => b.classList.toggle('active', b.dataset.sec === 'fav'));
  xtBreadcrumb('Basılı tutup sürükle: sırala · Basılı tutup bırak: çıkar');
  const list = document.getElementById('xt-list');
  list.innerHTML = '';
  const favs = favList('xtream');
  if (!favs.length) {
    list.innerHTML = '<p class="hint">Henüz favori yok. Canlı TV\'de bir kanalın üzerine basılı tutarak (Mac/PC\'de sağ tıkla) favorilere ekleyebilirsin.</p>';
    return;
  }
  favs.forEach(f => addXtreamLiveItem(list, { name: f.name, url: f.url, tsUrl: f.tsUrl, key: f.id, icon: f.icon, num: f.num, group: f.group || '' }, () => showXtreamFavorites(), true));
}

let xtCurrentCategory = null;
function loadXtreamItems(section, categoryId, categoryName) {
  if (categoryId !== '__fav__') xtCurrentCategory = { id: String(categoryId), name: categoryName };
  if (categoryId === '__fav__') return showXtreamFavorites();
  xtView = { kind: 'cat', section, id: String(categoryId), name: categoryName };
  // Son açılan kategoriyi hatırla: sayfa açılınca doğrudan buraya gelinsin
  saveStateField('/api/state/xtream-category', { section, id: categoryId, name: categoryName });
  appState.xtreamCategory = { section, id: String(categoryId), name: categoryName };
  xtBreadcrumb('⬅ ' + categoryName, () => backToXtreamCategories(section));
  const list = document.getElementById('xt-list');
  list.innerHTML = 'Yükleniyor...';

  if (section === 'series') {
    fetch(`/api/xtream/series?category_id=${categoryId}`)
      .then(r => r.json())
      .then(items => {
        list.innerHTML = '';
        items.forEach(s => {
          const el = document.createElement('div');
          el.className = 'xt-item';
          el.innerHTML = (s.icon ? `<img src="${s.icon}">` : '') + `<span>${s.name}</span>`;
          el.onclick = () => loadXtreamSeriesEpisodes(s.id, s.name, section, categoryId, categoryName);
          list.appendChild(el);
        });
      });
  } else {
    const type = section === 'vod' ? 'vod' : 'live';
    fetch(`/api/xtream/streams?type=${type}&category_id=${categoryId}`)
      .then(r => r.json())
      .then(items => {
        list.innerHTML = '';
        setTimeout(() => { if (document.body.classList.contains('fs-on')) scrollToPlaying(); }, 0);
        items.forEach(item => {
          if (type === 'live') {
            addXtreamLiveItem(list, item, el => {
              el.querySelector('.fav-star') ? el.querySelector('.fav-star').remove()
                : el.insertAdjacentHTML('beforeend', '<span class="fav-star">★</span>');
            });
            return;
          }
          const el = document.createElement('div');
          el.className = 'xt-item';
          el.innerHTML = (item.icon ? `<img src="${item.icon}">` : '') + `<span>${item.name}</span>`;
          el.onclick = () => {
            if (type === 'live') {
              playXtreamLive(item);
            } else {
              playVodOrEpisode(item.url, item.name, item.remux);
            }
            document.querySelectorAll('.xt-item').forEach(x => x.classList.remove('playing'));
            el.classList.add('playing');
          };
          list.appendChild(el);
        });
      });
  }
}

function loadXtreamSeriesEpisodes(seriesId, seriesName, section, categoryId, categoryName) {
  xtBreadcrumb('⬅ ' + seriesName, () => loadXtreamItems(section, categoryId, categoryName));
  const list = document.getElementById('xt-list');
  list.innerHTML = 'Bölümler yükleniyor...';
  fetch(`/api/xtream/series-info?series_id=${seriesId}`)
    .then(r => r.json())
    .then(data => {
      list.innerHTML = '';
      data.episodes.forEach(ep => {
        const el = document.createElement('div');
        el.className = 'xt-item';
        el.textContent = `S${ep.season} B${ep.episodeNum} — ${ep.title}`;
        el.onclick = () => {
          playVodOrEpisode(ep.url, `${seriesName} - S${ep.season}B${ep.episodeNum}`, ep.remux);
          document.querySelectorAll('.xt-item').forEach(x => x.classList.remove('playing'));
          el.classList.add('playing');
        };
        list.appendChild(el);
      });
    });
}

// Xtream filmleri ve dizi bölümleri de film oynatıcıda (sarma, ses dili, altyazı)
function playVodOrEpisode(url, label) {
  playMovie(url, label);
}

let currentPath = '';

function loadDir(p) {
  fetch('/api/files?path=' + encodeURIComponent(p)).then(r => r.json()).then(data => {
    currentPath = data.path;
    saveStateField('/api/state/mediaplayer-path', { path: currentPath });
    renderBreadcrumb(currentPath);
    renderList(data.items);
  });
}

function renderBreadcrumb(p) {
  document.getElementById('mp-breadcrumb').textContent = '/ ' + p;
}

function renderList(items) {
  const list = document.getElementById('mp-list');
  list.innerHTML = '';
  if (currentPath) {
    const up = document.createElement('div');
    up.className = 'mp-item';
    up.textContent = '⬅ .. (üst klasör)';
    up.onclick = () => {
      const parent = currentPath.split('/').slice(0, -1).join('/');
      loadDir(parent);
    };
    list.appendChild(up);
  }
  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'mp-item';
    const icon = item.type === 'folder' ? '📁' : item.type === 'video' ? '🎬' : item.type === 'audio' ? '🎵' : '📄';
    el.textContent = icon + ' ' + item.name;
    el.onclick = () => {
      if (item.type === 'folder') loadDir(item.path);
      else if (item.type === 'video') playVideo(item.path);
      else if (item.type === 'audio') playAudio(item.path);
    };
    list.appendChild(el);
  });
}

function attachResumeTracking(mediaEl, filePath) {
  if (appState.resumeMediaPlayer && appState.resumeMediaPlayer.path === filePath && appState.resumeMediaPlayer.position > 5) {
    mediaEl.currentTime = appState.resumeMediaPlayer.position;
  }
  let lastSaved = 0;
  mediaEl.ontimeupdate = () => {
    const now = Date.now();
    if (now - lastSaved > 5000) {
      lastSaved = now;
      saveStateField('/api/state/resume-mediaplayer', {
        path: filePath,
        position: mediaEl.currentTime,
        label: filePath
      });
    }
  };
}

let mpHls = null;
const MP_REMUX_EXT = ['mkv', 'avi', 'flv', 'wmv', 'ts', 'mpg', 'mpeg', 'm2ts', 'vob'];

// Videolar film oynatıcıyla: durdur/oynat, sarma, ses dili, altyazı, kaldığı yerden devam
function playVideo(p) {
  const audio = document.getElementById('mp-audio');
  audio.pause(); audio.style.display = 'none';
  mpVideoEl.style.display = 'block';
  playMovie('/stream?path=' + encodeURIComponent(p), String(p).split('/').pop(), { ctx: mpCtx, local: p });
}

function playAudio(p) {
  if (movie.active && movie.ctx === mpCtx) mpCtx.stop();
  const video = document.getElementById('mp-video');
  const audio = document.getElementById('mp-audio');
  video.pause(); video.style.display = 'none';
  audio.style.display = 'block';
  audio.src = '/stream?path=' + encodeURIComponent(p);
  attachResumeTracking(audio, p);
  audio.play().catch(() => {});
}

// ===== Kanal listesi: oynatma başlayınca gizle, ekrana dokununca/tıklayınca geri getir =====
const LIST_HIDE_DELAY = 4000;
function setupAutoHideList(panelId, playerId, videoId, tabId, onShow) {
  const panel = document.getElementById(panelId);
  const toggleBtn = document.querySelector(`.drawer-toggle[data-target="${tabId}"]`);
  // Çekmece açıkken "Liste" butonu kanalların üstüne binmesin
  const syncBtn = () => { if (toggleBtn) toggleBtn.classList.toggle('hidden-by-drawer', panel.classList.contains('open')); };
  new MutationObserver(syncBtn).observe(panel, { attributes: true, attributeFilter: ['class'] });
  const player = document.getElementById(playerId);
  const video = document.getElementById(videoId);
  let timer = null;
  let hovering = false;

  // iPhone/iPad (ve dar ekran) çekmece şeklinde; diğerlerinde panel daralır
  const isDrawer = () => getComputedStyle(panel).position === 'absolute';
  const isHidden = () => isDrawer() ? !panel.classList.contains('open') : panel.classList.contains('collapsed');

  const hide = () => {
    if (stackedLayout()) return; // iPhone dik: liste videonun altında, hep açık
    if (currentPlatform === 'tv') return; // TV: liste kumandayla yönetilir
    if (isDrawer()) panel.classList.remove('open');
    else panel.classList.add('collapsed');
  };
  const schedule = (delay = LIST_HIDE_DELAY) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!hovering && !video.paused && !panel.contains(document.activeElement)) hide();
    }, delay);
  };
  let openedAt = 0;
  const show = () => {
    const wasHidden = isHidden();
    if (isDrawer()) panel.classList.add('open');
    else panel.classList.remove('collapsed');
    if (wasHidden) { openedAt = Date.now(); if (onShow) onShow(); }
    schedule();
  };

  // Kanal oynamaya başlayınca birkaç saniye sonra gizle
  video.addEventListener('playing', () => schedule(3000));
  // Video durunca liste geri gelsin
  video.addEventListener('pause', () => { clearTimeout(timer); });

  // Videoya dokununca / tıklayınca listeyi geri getir (oynatıcı kontrolleri yine çalışır)
  player.addEventListener('pointerdown', e => {
    if (e.target.closest('.fullscreen-btn') || e.target.closest('.mv-controls')) return;
    if (player.classList.contains('movie-mode')) { if (isDrawer() && !isHidden()) hide(); return; }
    if (isHidden()) show();
    // Fare hareketiyle az önce açıldıysa aynı tıklama listeyi geri kapatmasın
    else if (isDrawer() && !(e.pointerType === 'mouse' && Date.now() - openedAt < 1500)) { clearTimeout(timer); hide(); }
    else schedule();
  });
  // Mac/PC: fare video üstünde hareket edince de liste gelsin (tıklayıp videoyu durdurmaya gerek yok)
  let lastMove = 0;
  player.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || player.classList.contains('movie-mode')) return;
    const now = Date.now();
    if (now - lastMove < 300) return;
    lastMove = now;
    if (isHidden()) show();
    else schedule();
  });
  // Liste kullanılırken açık kalsın
  ['pointerdown', 'scroll', 'keydown', 'wheel'].forEach(ev =>
    panel.addEventListener(ev, () => schedule(), { passive: true, capture: true }));
  // Sadece gerçek fare listenin üstündeyken açık tut (dokunmatik ekranda değil)
  panel.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { hovering = true; clearTimeout(timer); } });
  panel.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { hovering = false; schedule(); } });

  return { show, hide, schedule };
}

const listCtl = {
  iptv: setupAutoHideList('iptv-side-panel', 'iptv-player-panel', 'iptv-video', 'iptv', () => {
    // Tam ekranda: izlenen kanalın grubunun listesi, izlenen kanal ortada
    if (!document.body.classList.contains('fs-on')) return;
    dbg('tam ekranda liste açıldı');
    if (!restorePlayingList()) scrollToPlaying();
  }),
  mediaplayer: setupAutoHideList('mp-side-panel', 'mp-player-panel', 'mp-video', 'mediaplayer'),
  youtube: setupAutoHideList('yt-side-panel', 'yt-player-panel', 'yt-video', 'youtube')
};

// Çekmece butonuyla açılan liste de oynatma sırasında kendiliğinden kapansın
document.querySelectorAll('.drawer-toggle').forEach(btn => {
  btn.addEventListener('click', () => listCtl[btn.dataset.target].schedule());
});

// ===================== iPhone dik ekran: video üstte, liste altta =====================
const stackMq = window.matchMedia('(orientation: portrait) and (max-width: 600px)');
function stackedLayout() {
  return currentPlatform === 'mobile' && stackMq.matches && !document.body.classList.contains('fs-on');
}

// ===================== Film oynatıcı (M3U / Xtream filmleri ve dizi bölümleri) =====================
// Durdur/oynat, ileri-geri sarma (filmin tamamında), ses dili ve altyazı seçimi, kaldığı yerden devam.
// Tarayıcının açabildiği dosyalar (mp4/H.264) doğrudan oynar; mkv/avi vb. sunucuda ffmpeg ile
// (kopyalayarak, gerekirse dönüştürerek) akışa çevrilir. Sarma o anki konumdan yeni akış başlatır.
const MOVIE_EXT = /\.(mp4|m4v|mov|mkv|avi|webm|wmv|flv|mpg|mpeg|m2ts|vob|divx|3gp)(\?|#|$)/i;
function innerUrl(u) {
  u = String(u || '');
  if (u.startsWith('/api/xtream-stream')) { try { return new URL(u, location.href).searchParams.get('url') || u; } catch {} }
  return u;
}
function looksLikeMovie(url) {
  const inner = innerUrl(url);
  return MOVIE_EXT.test(inner) || /\/(movie|series)\/[^/]+\/[^/]+\/\d+/i.test(inner);
}
const LANG_TR = { tur: 'Türkçe', tr: 'Türkçe', eng: 'İngilizce', en: 'İngilizce', ara: 'Arapça', ar: 'Arapça', ger: 'Almanca', deu: 'Almanca', de: 'Almanca',
  fre: 'Fransızca', fra: 'Fransızca', fr: 'Fransızca', dut: 'Felemenkçe', nld: 'Felemenkçe', nl: 'Felemenkçe', spa: 'İspanyolca', es: 'İspanyolca',
  ita: 'İtalyanca', it: 'İtalyanca', rus: 'Rusça', ru: 'Rusça', jpn: 'Japonca', ja: 'Japonca', kor: 'Korece', ko: 'Korece', chi: 'Çince', zho: 'Çince',
  zh: 'Çince', por: 'Portekizce', pt: 'Portekizce', per: 'Farsça', fas: 'Farsça', fa: 'Farsça', hin: 'Hintçe', pol: 'Lehçe', swe: 'İsveççe',
  dan: 'Danca', nor: 'Norveççe', fin: 'Fince', gre: 'Yunanca', ell: 'Yunanca', heb: 'İbranice', kur: 'Kürtçe', aze: 'Azerice', bos: 'Boşnakça',
  alb: 'Arnavutça', sqi: 'Arnavutça', bul: 'Bulgarca', rum: 'Rumence', ron: 'Rumence', hun: 'Macarca', cze: 'Çekçe', ces: 'Çekçe', ukr: 'Ukraynaca' };
function langName(l) { l = String(l || '').toLowerCase(); return l && l !== 'und' ? (LANG_TR[l] || l.toUpperCase()) : ''; }
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), x = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}
function chLabel(c) { return c === 1 ? 'Mono' : c === 2 ? 'Stereo' : c === 6 ? '5.1' : c === 8 ? '7.1' : c ? c + ' kanal' : ''; }
function audioLabel(a) {
  const tech = [String(a.codec || '').toUpperCase(), chLabel(a.channels)].filter(Boolean).join(' ');
  return [langName(a.lang) || 'Ses ' + (a.n + 1), a.title, tech].filter(Boolean).join(' · ');
}
function subLabel(x) { return [langName(x.lang) || 'Altyazı ' + (x.n + 1), x.title].filter(Boolean).join(' · '); }

const movie = {
  active: false, url: '', label: '', info: null, mode: 'direct', offset: 0, pendingAt: null, audio: 0,
  sub: null, delay: 0, fileCues: null, streamCues: [], track: null, subTimer: null, sessionSubs: [], lastSave: 0, token: 0
};
// Film oynatıcı iki yerde çalışır: IPTV sekmesi ve Media Player sekmesi (aynı kontroller taşınır)
const mpVideoEl = document.getElementById('mp-video');
let mpSessionId = null, mpToken = 0;
const iptvCtx = {
  name: 'iptv', video: iptvVideo, panel: document.getElementById('iptv-player-panel'),
  token: () => playToken,
  stop: () => stopPlayback(),
  release() {
    if (hls) { hls.destroy(); hls = null; }
    if (liveSessionId) { saveStateField('/api/session/stop', { id: liveSessionId }); liveSessionId = null; }
    iptvVideo.removeAttribute('src'); iptvVideo.load();
  },
  setSession(id) { liveSessionId = id; },
  attach(url, opts) { attachHls(url, opts); }
};
const mpCtx = {
  name: 'mediaplayer', video: mpVideoEl, panel: document.getElementById('mp-player-panel'),
  token: () => mpToken,
  stop() { mpToken++; if (movie.active && movie.ctx === mpCtx) setMovieMode(false); mpCtx.release(); },
  release() {
    if (mpHls) { mpHls.destroy(); mpHls = null; }
    if (mpSessionId) { saveStateField('/api/session/stop', { id: mpSessionId }); mpSessionId = null; }
    mpVideoEl.removeAttribute('src'); mpVideoEl.load();
  },
  setSession(id) { mpSessionId = id; },
  attach(url) {
    if (supportsNativeHls() && isAppleNative()) mpVideoEl.src = url;
    else if (Hls.isSupported()) { mpHls = new Hls(); mpHls.loadSource(url); mpHls.attachMedia(mpVideoEl); }
    else mpVideoEl.src = url;
    mpVideoEl.play().catch(() => {});
  }
};
const ytVideoEl = document.getElementById('yt-video');
let ytHls = null, ytSessionId = null, ytToken = 0;
const ytCtx = {
  name: 'youtube', video: ytVideoEl, panel: document.getElementById('yt-player-panel'),
  token: () => ytToken,
  stop() { ytToken++; if (movie.active && movie.ctx === ytCtx) setMovieMode(false); ytCtx.release(); },
  release() {
    if (ytHls) { ytHls.destroy(); ytHls = null; }
    if (ytSessionId) { saveStateField('/api/session/stop', { id: ytSessionId }); ytSessionId = null; }
    ytVideoEl.removeAttribute('src'); ytVideoEl.load();
  },
  setSession(id) { ytSessionId = id; },
  attach(url, opts = {}) {
    if (supportsNativeHls() && isAppleNative()) ytVideoEl.src = url;
    else if (Hls.isSupported()) {
      ytHls = new Hls({ startPosition: opts.startAt || -1 });
      if (opts.onFatal) ytHls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) opts.onFatal(d); });
      ytHls.loadSource(url); ytHls.attachMedia(ytVideoEl);
    }
    else ytVideoEl.src = url;
    ytVideoEl.play().catch(() => {});
  }
};
function mvCtx() { return movie.ctx || iptvCtx; }
function MV() { return mvCtx().video; }
const mvControls = document.getElementById('mv-controls');
const mvSeek = document.getElementById('mv-seek');
const mvMenu = document.getElementById('mv-menu');
let mvDragging = false;
let mvHideTimer = null;

function setMovieMode(on) {
  movie.active = on;
  const c = mvCtx();
  c.panel.classList.toggle('movie-mode', on);
  c.video.controls = !on && currentPlatform !== 'tv';
  if (on && mvControls.parentElement !== c.panel) c.panel.appendChild(mvControls);
  if (!on) {
    hideMovieMenu();
    stopSubPolling();
    movie.info = null; movie.sub = null; movie.fileCues = null; movie.streamCues = []; movie.delay = 0; movie.pendingAt = null;
    renderCues();
    mvControls.classList.remove('show');
  }
}
// Akışın 0. saniyesi filmin kaçıncı saniyesi (tarayıcı akış saatini filmin gerçek saatiyle de verebiliyor)
function movieBase() { return movie.mode === 'session' && !movie.absClock ? movie.offset : 0; }
function movieNow() {
  if (movie.pendingAt != null) return movie.pendingAt;
  return movieBase() + (MV().currentTime || 0);
}
function movieDuration() {
  if (movie.info && movie.info.duration) return movie.info.duration;
  return isFinite(MV().duration) && MV().duration > 0 ? MV().duration + movieBase() : 0;
}
function sessionAvail() {
  const r = MV().seekable;
  return r && r.length ? r.end(r.length - 1) : 0;
}
// https sayfada http adresi (karışık içerik) tarayıcıda engellenmesin: sunucu üzerinden
function playableUrl(url) {
  return location.protocol === 'https:' && /^http:/i.test(url) ? '/api/xtream-stream?url=' + encodeURIComponent(url) : url;
}
function canDirectPlay(info, url) {
  const ext = ((innerUrl(url).match(/\.([a-z0-9]{2,4})(\?|#|$)/i) || [])[1] || '').toLowerCase();
  const mp4ish = ['mp4', 'm4v', 'mov'].includes(ext) || !!(info && /mp4|mov/.test(info.container || ''));
  if (!info) return mp4ish;
  if (!mp4ish) return false;
  const t = document.createElement('video');
  const vc = info.video && info.video.codec;
  if (vc && vc !== 'h264' && !(vc === 'hevc' && t.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'))) return false;
  const a = info.audio[0];
  if (a && !['aac', 'mp3'].includes(a.codec) && !(['ac3', 'eac3'].includes(a.codec) && t.canPlayType('audio/mp4; codecs="ac-3"'))) return false;
  return true;
}

// Tarayıcının açamayacağı türler doğrudan sunucuya; diğerleri önce olduğu gibi (doğrudan) oynar.
// Sağlayıcılar çoğu zaman tek bağlantıya izin verdiği için film açılırken sunucuya ayrıca
// bağlanılmaz; dosya bilgisi (ses dilleri, altyazılar) ancak menü açılınca alınır.
const SERVER_EXT = /^(mkv|avi|wmv|flv|mpg|mpeg|m2ts|vob|divx|ts)$/i;
function movieExt(url) { return ((innerUrl(url).match(/\.([a-z0-9]{2,4})(\?|#|$)/i) || [])[1] || '').toLowerCase(); }
function resumeAt(url) {
  const saved = (appState.resumeMovies || {})[url];
  let at = saved && saved.position > 10 ? saved.position : 0;
  if (!at && appState.resumeXtream && appState.resumeXtream.url === url && appState.resumeXtream.position > 10) at = appState.resumeXtream.position;
  return at;
}
// opts.adopt: zaten oynayan dosyayı film moduna al (yeniden başlatma)
// opts.server: tarayıcı açamadı, sunucu üzerinden oynat
async function playMovie(url, label, opts = {}) {
  const ctx = opts.ctx || iptvCtx;
  // Öteki sekmede film oynuyorsa onu kapat
  if (movie.active && movie.ctx && movie.ctx !== ctx) movie.ctx.stop();
  if (!opts.adopt) ctx.stop();
  movie.ctx = ctx;
  movie.local = opts.local || null;
  movie.yt = opts.yt || null;
  setMovieMode(true);
  Object.assign(movie, { url, label, audio: 0, offset: 0, mode: 'direct', pendingAt: null, info: null, infoLoaded: false,
    subAuto: false, sessionSubs: [], lastSave: Date.now() });
  MV().dataset.title = label;
  document.getElementById('mv-title').textContent = label;
  const at = resumeAt(url);
  if (opts.adopt) {
    if (at > 0 && MV().currentTime < 5) { try { MV().currentTime = at; showToast('Kaldığın yerden: ' + fmtTime(at)); } catch {} }
    updateMovieUi();
    showMovieControls();
    return;
  }
  if (at) showToast('Kaldığın yerden: ' + fmtTime(at));
  updateMovieUi();
  showMovieControls();
  if (opts.yt) {
    // YouTube: varsa kendi HLS parçalarıyla (ffmpeg'siz, anında başlar ve sarar); yoksa sunucu akışı
    const token = ctx.token();
    await ensureMovieInfo();
    if (token !== ctx.token() || movie.yt !== opts.yt) return;
    if (movie.info && movie.info.hls && !movie.info.live) return movieYtHls(at);
    return movieSession(at);
  }
  if (opts.server || SERVER_EXT.test(movieExt(url))) await movieSession(at);
  else movieDirect(at);
}

function movieYtHls(at) {
  const ctx = mvCtx();
  const my = ++movie.token;
  movie.mode = 'direct'; movie.offset = 0; movie.pendingAt = null;
  ctx.release();
  const url = movie.info.hls + (lowResDevice ? '?q=720' : '');
  const fallback = why => {
    if (my !== movie.token || !movie.active || movie.ctx !== ctx || movie.mode !== 'direct') return;
    dbg('YouTube HLS açılamadı (' + why + '), sunucu akışına geçiliyor');
    movieSession(movieNow());
  };
  if (at > 0) ctx.video.addEventListener('loadedmetadata', () => { try { if (ctx.video.currentTime < 5) ctx.video.currentTime = at; } catch {} }, { once: true });
  ctx.attach(url, { startAt: at > 0 ? at : -1, onFatal: d => fallback(d.details || 'hata') });
  if (!movie.subAuto) {
    movie.subAuto = true;
    const trSub = movie.info.subs.find(x => x.text && x.ext && !x.auto && /^(tur|tr)$/i.test(x.lang));
    if (trSub) selectSub({ kind: 'ext', n: trSub.n });
  }
  renderCues();
  updateMovieUi();
}
// Dosya bilgisi: süre, ses dilleri, altyazılar (bir kere)
async function ensureMovieInfo() {
  if (movie.infoLoaded) return movie.info;
  const url = movie.url;
  const q = movie.local ? 'local=1&src=' + encodeURIComponent(movie.local) : 'src=' + encodeURIComponent(url);
  const infoUrl = movie.yt ? '/api/yt/info?id=' + encodeURIComponent(movie.yt) : '/api/media/info?' + q;
  try { const r = await fetch(infoUrl); if (r.ok && url === movie.url) movie.info = await r.json(); } catch {}
  if (url === movie.url) movie.infoLoaded = true;
  return movie.info;
}

function movieDirect(at) {
  movie.mode = 'direct'; movie.offset = 0; movie.pendingAt = null;
  MV().src = movie.url;
  if (at > 0) MV().addEventListener('loadedmetadata', () => { try { MV().currentTime = at; } catch {} }, { once: true });
  MV().play().catch(() => {});
  setStatus('');
  renderCues();
  updateMovieUi();
}

function movieReleaseSource() { mvCtx().release(); }

async function movieSession(at, retried) {
  const ctx = mvCtx();
  const token = ctx.token();
  const my = ++movie.token;
  stopSubPolling();
  movieReleaseSource();
  movie.mode = 'session'; movie.offset = at; movie.pendingAt = at; movie.streamCues = []; movie.absClock = false;
  renderCues();
  setStatus(at ? fmtTime(at) + ' konumundan açılıyor…' : 'Film hazırlanıyor…');
  updateMovieUi();
  await ensureMovieInfo();
  if (token !== ctx.token() || my !== movie.token) return;
  let autoExt = null;
  if (!movie.subAuto) {
    movie.subAuto = true;
    const trSub = movie.info && !movie.sub && movie.info.subs.find(x => x.text && /^(tur|tr)$/i.test(x.lang) && !x.auto);
    if (trSub && trSub.ext) autoExt = trSub;
    else if (trSub) movie.sub = { kind: 'stream', n: trSub.n };
  }
  let textSubs = movie.info ? movie.info.subs.filter(x => x.text && !x.ext).map(x => x.n) : [];
  if (movie.sub && movie.sub.kind === 'stream') textSubs = [movie.sub.n, ...textSubs.filter(n => n !== movie.sub.n)];
  const q = new URLSearchParams({ src: movie.local || movie.url, local: movie.local ? '1' : '0', live: '0', mode: 'auto', start: String(Math.floor(at)),
    audio: String(movie.audio), subs: textSubs.slice(0, 12).join(',') });
  if (lowResDevice) q.set('q', '720');
  if (movie.yt) { q.delete('src'); q.set('yt', movie.yt); }
  let data = null;
  try { const r = await fetch('/api/session/start?' + q.toString()); data = await r.json(); } catch (e) { data = { error: e.message }; }
  if (token !== ctx.token() || my !== movie.token) { if (data && data.id) saveStateField('/api/session/stop', { id: data.id }); return; }
  if (!data || !data.playlist) {
    if (!retried) return movieSession(at, true);
    movie.pendingAt = null;
    showToast('Film açılamadı: ' + ((data && data.error) || 'bilinmeyen hata'));
    return;
  }
  ctx.setSession(data.id);
  if (autoExt) selectSub({ kind: 'ext', n: autoExt.n });
  movie.offset = data.start || 0;
  movie.pendingAt = null;
  movie.sessionSubs = data.subs || [];
  ctx.attach(data.playlist, { session: true, onFatal: () => { if (my === movie.token) showToast('Akış kesildi, tekrar deneyin'); } });
  setStatus('');
  startSubPolling();
  updateMovieUi();
}

function movieSeek(abs) {
  if (!movie.active) return;
  const dur = movieDuration();
  abs = Math.max(0, dur ? Math.min(abs, dur - 3) : abs);
  if (movie.mode === 'direct') { try { MV().currentTime = abs; } catch {} return; }
  if (movie.pendingAt != null) { movieSession(abs); return; }
  const rel = abs - movieBase();
  // Hazır olan kısımda ise anında; değilse o noktadan yeni akış
  if (abs >= movie.offset && rel >= 0 && rel <= sessionAvail() - 2) { MV().currentTime = rel; return; }
  movieSession(abs);
}
function movieSeekBy(d) { movieSeek(movieNow() + d); showMovieControls(); }

function selectAudio(n) {
  if (n === movie.audio) return;
  const at = movieNow();
  movie.audio = n;
  const info = movie.info;
  const name = info && info.audio[n] ? audioLabel(info.audio[n]) : '';
  showToast('Ses: ' + name);
  if (movie.mode === 'direct') {
    const tr = MV().audioTracks;
    if (tr && info && tr.length === info.audio.length) {
      for (let i = 0; i < tr.length; i++) tr[i].enabled = i === n;
      return;
    }
  }
  movieSession(at);
}

function selectSub(sel) {
  movie.sub = sel;
  movie.streamCues = [];
  stopSubPolling();
  renderCues();
  if (!sel || sel.kind === 'file') return;
  if (sel.kind === 'ext') {
    const x = movie.info && movie.info.subs.find(y => y.n === sel.n);
    if (!x) return;
    fetch(x.url).then(r => (r.ok ? r.text() : '')).then(t => {
      if (movie.sub !== sel) return;
      movie.fileCues = parseSubtitles(t);
      if (!movie.fileCues.length) showToast('Altyazı alınamadı');
      renderCues();
    }).catch(() => showToast('Altyazı alınamadı'));
    return;
  }
  // Doğrudan oynayan dosyada altyazı sunucuda çıkarılır: akışa geç
  if (movie.mode === 'direct' || !movie.sessionSubs.some(x => x.n === sel.n)) {
    showToast('Altyazı hazırlanıyor…');
    movieSession(movieNow());
    return;
  }
  startSubPolling();
}

function stopSubPolling() { clearTimeout(movie.subTimer); movie.subTimer = null; }
// Altyazı dosyası film akışıyla birlikte yazılır; arada bir yeniden okunur
function startSubPolling() {
  stopSubPolling();
  if (!movie.sub || movie.sub.kind !== 'stream' || movie.mode !== 'session') return;
  const entry = movie.sessionSubs.find(x => x.n === movie.sub.n);
  if (!entry) return;
  const my = movie.token, n = entry.n;
  let tries = 0, same = 0;
  const tick = async () => {
    try {
      const text = await fetch(entry.url, { cache: 'no-store' }).then(r => (r.ok ? r.text() : ''));
      if (my !== movie.token || !movie.sub || movie.sub.n !== n) return;
      // Sunucu altyazıyı filmin gerçek saatiyle yazar
      const cues = parseSubtitles(text).filter(c => c.end > movie.offset - 1);
      if (cues.length !== movie.streamCues.length) { movie.streamCues = cues; renderCues(); same = 0; } else same++;
    } catch {}
    tries++;
    if (my !== movie.token || same > 20) return;
    movie.subTimer = setTimeout(tick, tries < 5 ? 3000 : 15000);
  };
  tick();
}

function parseSubtitles(text) {
  const out = [];
  const t = String(text || '').replace(/\r/g, '').replace(/^﻿/, '');
  const ts = x => {
    const m = String(x).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
    return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000 : null;
  };
  for (const b of t.split(/\n\s*\n/)) {
    const lines = b.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const st = ts(a), en = ts(z);
    if (st == null || en == null) continue;
    const body = lines.slice(i + 1).join('\n').replace(/\{\\[^}]*\}/g, '').replace(/<\/?font[^>]*>/gi, '').trim();
    if (body) out.push({ start: st, end: en, text: body });
  }
  return out;
}

function renderCues() {
  const t = movie.track;
  if (t && t.cues) while (t.cues.length) t.removeCue(t.cues[0]);
  const src = !movie.sub ? [] : (movie.sub.kind === 'file' || movie.sub.kind === 'ext') ? (movie.fileCues || []) : movie.streamCues;
  if (!src.length) { if (t) t.mode = movie.sub ? 'showing' : 'hidden'; return; }
  if (!movie.track) movie.track = MV().addTextTrack('subtitles', 'Altyazı', 'tr');
  movie.track.mode = 'showing';
  const base = movieBase();
  src.forEach(c => {
    const st = c.start + movie.delay - base, en = c.end + movie.delay - base;
    if (en <= 0) return;
    try { movie.track.addCue(new VTTCue(Math.max(0, st), en, c.text)); } catch {}
  });
}

document.getElementById('mv-sub-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const buf = await f.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1254').decode(buf); }
  const cues = parseSubtitles(text);
  if (!cues.length) return showToast('Altyazı okunamadı (.srt veya .vtt olmalı)');
  movie.fileCues = cues;
  selectSub({ kind: 'file' });
  showToast('Altyazı yüklendi');
});

// ---- Kontroller ----
function updateMovieUi() {
  if (!movie.active) return;
  const dur = movieDuration();
  const now = movieNow();
  document.getElementById('mv-cur').textContent = fmtTime(now);
  document.getElementById('mv-dur').textContent = dur ? fmtTime(dur) : '--:--';
  mvSeek.disabled = !dur;
  if (!mvDragging && dur) mvSeek.value = String(Math.round(Math.min(1, now / dur) * 1000));
  document.getElementById('mv-play').textContent = MV().paused && movie.pendingAt == null ? '▶' : '⏸';
  const info = movie.info;
  document.getElementById('mv-sub-btn').classList.toggle('on', !!movie.sub);
}
function showMovieControls() {
  if (!movie.active) return;
  mvControls.classList.add('show');
  clearTimeout(mvHideTimer);
  mvHideTimer = setTimeout(() => {
    if (!MV().paused && !mvMenu.classList.contains('open') && !mvDragging) mvControls.classList.remove('show');
  }, 4000);
}
function hideMovieMenu() { mvMenu.classList.remove('open'); mvMenu.dataset.kind = ''; }
async function openMovieMenu(kind, keep) {
  if (!keep && mvMenu.dataset.kind === kind && mvMenu.classList.contains('open')) return hideMovieMenu();
  if (!movie.infoLoaded) {
    mvMenu.dataset.kind = kind;
    mvMenu.innerHTML = '<button class="mv-opt" disabled>Yükleniyor…</button>';
    mvMenu.classList.add('open');
    showMovieControls();
    await ensureMovieInfo();
    if (mvMenu.dataset.kind !== kind) return;
    updateMovieUi();
  }
  mvMenu.dataset.kind = kind;
  mvMenu.innerHTML = '';
  const add = (text, on, fn, parent) => {
    const b = document.createElement('button');
    b.className = 'mv-opt' + (on ? ' on' : '');
    b.textContent = (on ? '✓ ' : '') + text;
    if (fn) b.onclick = ev => { ev.stopPropagation(); fn(); }; else b.disabled = true;
    (parent || mvMenu).appendChild(b);
    return b;
  };
  const info = movie.info;
  if (kind === 'audio') {
    const nt = MV().audioTracks;
    if ((!info || !info.audio.length) && nt && nt.length > 1) {
      for (let i = 0; i < nt.length; i++) {
        const t = nt[i];
        add(langName(t.language) || t.label || 'Ses ' + (i + 1), t.enabled, () => {
          hideMovieMenu();
          for (let j = 0; j < nt.length; j++) nt[j].enabled = j === i;
        });
      }
    } else if (!info || !info.audio.length) add('Ses bilgisi alınamadı', false, null);
    else {
      info.audio.forEach(a => add(audioLabel(a), a.n === movie.audio, () => { hideMovieMenu(); selectAudio(a.n); }));
      if (info.audio.length === 1) add('Bu filmde tek ses dili var', false, null);
    }
  } else {
    add('Kapalı', !movie.sub, () => { hideMovieMenu(); selectSub(null); });
    (info ? info.subs : []).forEach(x => add(subLabel(x) + (x.text ? '' : ' (resim altyazı, desteklenmiyor)'),
      !!movie.sub && movie.sub.kind === (x.ext ? 'ext' : 'stream') && movie.sub.n === x.n,
      x.text ? () => { hideMovieMenu(); selectSub({ kind: x.ext ? 'ext' : 'stream', n: x.n }); } : null));
    if (info && !info.subs.length) add('Dosyada altyazı yok', false, null);
    add('📂 Dosyadan yükle (.srt / .vtt)…', !!movie.sub && movie.sub.kind === 'file',
      () => { hideMovieMenu(); document.getElementById('mv-sub-file').click(); });
    if (movie.sub) {
      const row = document.createElement('div');
      row.className = 'mv-delay';
      const lbl = document.createElement('span');
      lbl.textContent = 'Kaydır: ' + (movie.delay > 0 ? '+' : '') + movie.delay.toFixed(1) + ' sn';
      const shift = d => { movie.delay = Math.round((movie.delay + d) * 10) / 10; renderCues(); openMovieMenu('sub', true); };
      add('−0,5', false, () => shift(-0.5), row);
      row.appendChild(lbl);
      add('+0,5', false, () => shift(0.5), row);
      mvMenu.appendChild(row);
    }
  }
  mvMenu.classList.add('open');
  showMovieControls();
}

document.getElementById('mv-play').addEventListener('click', () => {
  if (MV().paused) MV().play().catch(() => {}); else MV().pause();
  showMovieControls();
});
document.getElementById('mv-back').addEventListener('click', () => movieSeekBy(-10));
document.getElementById('mv-fwd').addEventListener('click', () => movieSeekBy(30));
document.getElementById('mv-audio-btn').addEventListener('click', e => { e.stopPropagation(); openMovieMenu('audio'); });
document.getElementById('mv-sub-btn').addEventListener('click', e => { e.stopPropagation(); openMovieMenu('sub'); });
document.getElementById('mv-list').addEventListener('click', () => { hideMovieMenu(); listCtl[mvCtx().name].show(); });
const pipBtn = document.getElementById('mv-pip');
if (document.pictureInPictureEnabled || (iptvVideo.webkitSupportsPresentationMode && iptvVideo.webkitSupportsPresentationMode('picture-in-picture'))) {
  pipBtn.style.display = '';
  pipBtn.addEventListener('click', () => {
    if (MV().webkitSetPresentationMode) {
      MV().webkitSetPresentationMode(MV().webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    } else if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else MV().requestPictureInPicture().catch(() => {});
  });
}
mvSeek.addEventListener('input', () => {
  mvDragging = true;
  document.getElementById('mv-cur').textContent = fmtTime(mvSeek.value / 1000 * movieDuration());
  showMovieControls();
});
mvSeek.addEventListener('change', () => {
  mvDragging = false;
  movieSeek(mvSeek.value / 1000 * movieDuration());
});
mvControls.addEventListener('pointerdown', () => showMovieControls());
[iptvCtx, mpCtx, ytCtx].forEach(c => {
  c.panel.addEventListener('pointerdown', e => {
    if (!movie.active || movie.ctx !== c || e.target.closest('.mv-controls') || e.target.closest('.fullscreen-btn')) return;
    if (mvControls.classList.contains('show') && e.pointerType !== 'mouse') { mvControls.classList.remove('show'); hideMovieMenu(); }
    else showMovieControls();
  });
  c.panel.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' && movie.ctx === c) showMovieControls(); });
});
document.addEventListener('keydown', e => {
  if (!movie.active || /input|select|textarea/i.test((e.target && e.target.tagName) || '')) return;
  if (!document.getElementById(mvCtx().name).classList.contains('active')) return;
  if (e.key === ' ') { e.preventDefault(); document.getElementById('mv-play').click(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); movieSeekBy(-10); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); movieSeekBy(30); }
});

function saveMovieResume(done) {
  if (!movie.active || !movie.url || movie.pendingAt != null) return;
  const position = movieNow(), duration = movieDuration();
  appState.resumeMovies = appState.resumeMovies || {};
  if (done) delete appState.resumeMovies[movie.url];
  else appState.resumeMovies[movie.url] = { position, duration };
  saveStateField('/api/state/resume-movie', { url: movie.url, position, duration, label: movie.label, done: !!done });
}
let mvUiAt = 0;
[iptvCtx, mpCtx, ytCtx].forEach(c => {
  const v = c.video;
  const mine = () => movie.active && movie.ctx === c;
  v.addEventListener('timeupdate', () => {
    if (!mine()) return;
    const now = Date.now();
    if (now - mvUiAt > 250) { mvUiAt = now; updateMovieUi(); updatePositionState(); }
    if (!v.paused && now - movie.lastSave > 10000) { movie.lastSave = now; saveMovieResume(false); }
  });
  ['play', 'playing', 'pause', 'waiting'].forEach(ev => v.addEventListener(ev, () => {
    if (!mine()) return;
    updateMovieUi();
    if (ev === 'pause' && !v.dataset.bg) { showMovieControls(); saveMovieResume(false); }
  }));
  v.addEventListener('playing', () => {
    if (!mine() || movie.mode !== 'session' || movie.absClock || movie.offset < 20) return;
    if (v.currentTime > movie.offset - 10) { movie.absClock = true; dbg('akış saati filmin gerçek saati'); renderCues(); }
  });
  v.addEventListener('ended', () => { if (mine()) { saveMovieResume(true); updateMovieUi(); showMovieControls(); } });
  // Doğrudan açılamayan dosya: sunucu akışına geç
  v.addEventListener('error', () => {
    if (!mine() || movie.mode !== 'direct' || !v.getAttribute('src')) return;
    dbg('film doğrudan açılamadı, sunucu akışına geçiliyor');
    movieSession(movieNow());
  });
});
// ===================== Kilit ekranı / arka planda ses (iPhone) =====================
// iPhone ekran kilitlenince <video>'yu durduruyor ama <audio> çalmaya devam edebiliyor.
// Sayfa arka plana geçerken aynı yayın aynı saniyeden gizli bir <audio>'ya devredilir,
// geri gelince video kaldığı yerden devam eder. Kilit ekranında oynat/durdur ve sarma çalışır.
const bgAudio = document.getElementById('bg-audio');
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let bg = null;
let bgPrimed = false;
const lastPauseAt = new WeakMap();
function allVideos() { return [iptvVideo, document.getElementById('mp-video'), document.getElementById('yt-video')]; }
allVideos().forEach(v => v.addEventListener('pause', () => lastPauseAt.set(v, Date.now())));
function hlsFor(v) { return v === iptvVideo ? hls : v.id === 'yt-video' ? ytHls : (typeof mpHls !== 'undefined' ? mpHls : null); }
function activeVideo() {
  if (document.getElementById('youtube').classList.contains('active')) return document.getElementById('yt-video');
  return document.getElementById('mediaplayer').classList.contains('active') ? document.getElementById('mp-video') : iptvVideo;
}
function silentWavUrl() {
  const n = 1600, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
// iPhone sesi ancak dokunuşla başlatılmış bir öğede kendiliğinden çalar: ilk dokunuşta sessizce "aç"
function primeBgAudio() {
  if (bgPrimed || !isIOS || bg) return;
  bgPrimed = true;
  const playing = allVideos().filter(v => !v.paused);
  bgAudio.src = silentWavUrl();
  const p = bgAudio.play();
  if (p && p.then) p.then(() => {
    bgAudio.pause();
    playing.forEach(v => { if (v.paused) v.play().catch(() => {}); });
  }).catch(() => { bgPrimed = false; });
}
document.addEventListener('touchend', primeBgAudio, { capture: true, passive: true });
document.addEventListener('click', primeBgAudio, { capture: true });

function bgHandoff() {
  if (!isIOS || bg || !bgPrimed) return;
  const now = Date.now();
  const v = allVideos().find(x => x.offsetParent !== null && !x.dataset.bg &&
    (!x.paused || now - (lastPauseAt.get(x) || 0) < 1500) && (x.currentSrc || hlsFor(x)));
  if (!v) return;
  const h = hlsFor(v);
  const src = h && h.url ? new URL(h.url, location.href).href : v.currentSrc;
  if (!src || src.startsWith('blob:')) return;
  const live = v === iptvVideo && !(movie.active && movie.ctx === iptvCtx);
  const t = v.currentTime;
  bg = { video: v, src, live, h: h && h.url ? h : null };
  bgAudio.src = src;
  if (!live && t > 0) bgAudio.addEventListener('loadedmetadata', () => { try { bgAudio.currentTime = t; } catch {} }, { once: true });
  const p = bgAudio.play();
  if (p && p.catch) p.catch(e => dbg('arka plan sesi başlamadı: ' + (e && e.message)));
  // Videoyu bırak (sağlayıcı çoğu zaman tek bağlantıya izin veriyor)
  v.dataset.bg = '1';
  if (bg.h) { try { bg.h.stopLoad(); bg.h.detachMedia(); } catch {} }
  else { v.pause(); v.removeAttribute('src'); v.load(); }
  dbg('arka plan: ses devralındı');
}
function bgRestore() {
  if (!bg) return;
  const { video: v, src, live, h } = bg;
  bg = null;
  const wasPlaying = !bgAudio.paused;
  const t = bgAudio.currentTime;
  bgAudio.pause(); bgAudio.removeAttribute('src'); bgAudio.load();
  delete v.dataset.bg;
  if (h) { try { h.attachMedia(v); h.startLoad(-1); } catch {} }
  else {
    v.src = src;
    if (!live && t > 0) v.addEventListener('loadedmetadata', () => { try { v.currentTime = t; } catch {} }, { once: true });
  }
  if (wasPlaying) v.play().catch(() => {});
  else if (movie.active && v === MV()) showMovieControls();
  dbg('arka plan: görüntüye dönüldü');
}
function bgStop() {
  if (!bg) return;
  delete bg.video.dataset.bg;
  bg = null;
  bgAudio.pause(); bgAudio.removeAttribute('src'); bgAudio.load();
}
document.addEventListener('visibilitychange', () => { if (document.hidden) bgHandoff(); else bgRestore(); });

// Kilit ekranı / Denetim Merkezi: başlık, oynat/durdur, sarma
function nowTarget() { return bg ? bgAudio : activeVideo(); }
function updateMetadata(title) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: title || 'Tesla Player', artist: 'Tesla Player',
      artwork: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }] });
  } catch {}
}
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  try {
    const useMovie = movie.active && (bg ? bg.video === MV() : activeVideo() === MV());
    if (useMovie) {
      const dur = movieDuration();
      const pos = bg ? movieBase() + bgAudio.currentTime : movieNow();
      if (dur) navigator.mediaSession.setPositionState({ duration: dur, position: Math.max(0, Math.min(pos, dur)), playbackRate: 1 });
    } else {
      const v = nowTarget();
      if (isFinite(v.duration) && v.duration > 0) navigator.mediaSession.setPositionState({ duration: v.duration, position: Math.min(v.currentTime, v.duration), playbackRate: 1 });
      else navigator.mediaSession.setPositionState();
    }
  } catch {}
}
allVideos().forEach(v => v.addEventListener('playing', () => { updateMetadata(v.dataset.title); updatePositionState(); }));
bgAudio.addEventListener('playing', () => { if (bg) updateMetadata(bg.video.dataset.title); updatePositionState(); });
let bgPsAt = 0;
bgAudio.addEventListener('timeupdate', () => {
  if (!bg) return;
  const now = Date.now();
  if (now - bgPsAt > 5000) { bgPsAt = now; updatePositionState(); }
});
function seekAnyBy(d) {
  if (bg) { try { bgAudio.currentTime = Math.max(0, bgAudio.currentTime + d); } catch {} return; }
  if (movie.active && activeVideo() === MV()) return movieSeekBy(d);
  const v = activeVideo();
  if (isFinite(v.duration)) v.currentTime = Math.max(0, v.currentTime + d);
}
function seekAnyTo(t) {
  if (bg) {
    const rel = movie.active && bg.video === MV() ? t - movieBase() : t;
    try { bgAudio.currentTime = Math.max(0, rel); } catch {}
    return;
  }
  if (movie.active && activeVideo() === MV()) return movieSeek(t);
  const v = activeVideo();
  if (isFinite(v.duration)) v.currentTime = t;
}
if ('mediaSession' in navigator) {
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch {} };
  set('play', () => { nowTarget().play().catch(() => {}); });
  set('pause', () => nowTarget().pause());
  set('seekbackward', d => seekAnyBy(-((d && d.seekOffset) || 10)));
  set('seekforward', d => seekAnyBy((d && d.seekOffset) || 30));
  set('seekto', d => { if (d && d.seekTime != null) seekAnyTo(d.seekTime); });
}

// ===================== YouTube =====================
// Arama sunucuda yt-dlp ile yapılır; videolar film oynatıcıda açılır (sarma, altyazı, kilit ekranında ses)
const ytList = document.getElementById('yt-list');
const ytQ = document.getElementById('yt-q');
// Listede ilk görünen videoları sunucu arka planda hazırlasın (tıklayınca hemen açılsın)
const ytPrefetched = new Set();
function ytPrefetch(ids, now) {
  ids = ids.filter(id => id && !ytPrefetched.has(id));
  if (!ids.length) return;
  ids.forEach(id => ytPrefetched.add(id));
  saveStateField('/api/yt/prefetch', { ids, now: !!now });
}
function ytEsc(t) { return String(t || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function ytItem(v, progress) {
  const el = document.createElement('div');
  el.className = 'yt-item';
  if (movie.active && movie.yt === v.id) el.classList.add('playing');
  const badge = v.live ? '<span class="yt-badge live">CANLI</span>' : v.duration ? `<span class="yt-badge">${fmtTime(v.duration)}</span>` : '';
  const bar = progress ? `<span class="yt-progress" style="width:${Math.min(100, Math.round(progress * 100))}%"></span>` : '';
  el.innerHTML = `<div class="yt-thumb"><img loading="lazy" src="${ytEsc(v.thumb)}" alt="">${badge}${bar}</div>` +
    `<div class="yt-meta"><div class="yt-title">${ytEsc(v.title)}</div><div class="yt-ch">${ytEsc(v.channel)}</div></div>`;
  // Parmak değer değmez hazırlamaya başla
  el.addEventListener('pointerdown', () => ytPrefetch([v.id], true), { passive: true });
  el.onclick = () => {
    ytPlay(v);
    document.querySelectorAll('.yt-item').forEach(x => x.classList.remove('playing'));
    el.classList.add('playing');
  };
  return el;
}
async function ytPlay(v) {
  await playMovie('yt:' + v.id, v.link ? 'YouTube' : v.title, { ctx: ytCtx, yt: v.id });
  // Bağlantıdan açılan videonun başlığını bilgiden al
  if (movie.yt === v.id && movie.info && movie.info.title && v.link) {
    movie.label = movie.info.title;
    MV().dataset.title = movie.info.title;
    document.getElementById('mv-title').textContent = movie.info.title;
  }
}
// Ana görünüm: yarım kalan YouTube videoları (sunucuda saklanır, her cihazda aynı)
function showYtHome() {
  ytStack = [];
  ytMarkChip(null);
  ytList.innerHTML = '';
  const rm = appState.resumeMovies || {};
  const items = Object.keys(rm).filter(k => k.startsWith('yt:') && rm[k].label)
    .sort((a, b) => (rm[b].t || 0) - (rm[a].t || 0)).slice(0, 30);
  if (!items.length) {
    ytList.innerHTML = '<p class="hint">Aramak istediğini yukarıya yaz ya da bir YouTube bağlantısı yapıştır.</p>';
    return;
  }
  ytList.insertAdjacentHTML('beforeend', '<div class="list-heading">Kaldığın yerden</div>');
  items.forEach(k => {
    const id = k.slice(3), r = rm[k];
    ytList.appendChild(ytItem({ id, title: r.label, channel: fmtTime(r.position) + (r.duration ? ' / ' + fmtTime(r.duration) : ''),
      thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` }, r.duration ? r.position / r.duration : 0));
  });
  ytPrefetch(items.slice(0, 3).map(k => k.slice(3)));
}
async function ytSearch(q) {
  ytStack = [];
  ytMarkChip(null);
  ytList.innerHTML = '<p class="hint">Aranıyor…</p>';
  let r;
  try { r = await fetch('/api/yt/search?q=' + encodeURIComponent(q)).then(x => x.json()); } catch (e) { r = { error: e.message }; }
  if (!Array.isArray(r)) { ytList.innerHTML = `<p class="hint yt-err">${ytEsc((r && r.error) || 'Arama yapılamadı')}</p>`; return; }
  lsSet('tp-yt-q', q);
  ytList.innerHTML = '';
  const home = document.createElement('div');
  home.className = 'channel-item';
  home.textContent = '⬅ Kaldığın yerden';
  home.onclick = () => { ytQ.value = ''; lsSet('tp-yt-q', ''); showYtHome(); };
  ytList.appendChild(home);
  if (!r.length) { ytList.insertAdjacentHTML('beforeend', '<p class="hint">Sonuç bulunamadı.</p>'); return; }
  r.forEach(v => ytList.appendChild(ytItem(v)));
  ytPrefetch(r.filter(v => !v.live).slice(0, 6).map(v => v.id));
  if (r.length === 1 && r[0].link) ytList.querySelector('.yt-item').click();
}
document.getElementById('yt-search-form').addEventListener('submit', e => {
  e.preventDefault();
  const q = ytQ.value.trim();
  ytQ.blur();
  if (q) ytSearch(q); else showYtHome();
});
// ---- Kendi hesabı: abonelikler, sonra izle, beğenilenler, listeler ----
let ytStack = [];
let ytAccount = false;
const YT_FEED_CHIPS = [['subs', 'Abonelikler'], ['wl', 'Sonra izle'], ['liked', 'Beğenilenler'], ['playlists', 'Listelerim'],
  ['channels', 'Kanallarım'], ['history', 'Geçmiş'], ['rec', 'Önerilenler']];
function ytMarkChip(feed) {
  document.querySelectorAll('#yt-feeds .yt-chip').forEach(c => c.classList.toggle('active', !!feed && c.dataset.feed === feed));
}
function renderYtFeeds() {
  const box = document.getElementById('yt-feeds');
  box.innerHTML = '';
  const chip = (text, fn, feed, cls) => {
    const b = document.createElement('button');
    b.className = 'yt-chip' + (cls ? ' ' + cls : '');
    b.textContent = text;
    if (feed) b.dataset.feed = feed;
    b.onclick = fn;
    box.appendChild(b);
  };
  if (!ytAccount) { chip('👤 YouTube hesabımı bağla', ytShowAccount, null, 'connect'); return; }
  YT_FEED_CHIPS.forEach(([feed, title]) => chip(title, () => { ytStack = []; ytMarkChip(feed); ytOpen({ feed, title }); }, feed));
  chip('⚙', ytShowAccount, null, 'gear');
}
function ytShowAccount() {
  document.getElementById('yt-account-remove').style.display = ytAccount ? '' : 'none';
  document.getElementById('yt-account-box').style.display = 'block';
}
function ytListItem(it) {
  const el = document.createElement('div');
  el.className = 'yt-item';
  const thumb = it.thumb ? `<img loading="lazy" src="${ytEsc(it.thumb)}" alt="">` : '<span class="yt-listicon">☰</span>';
  el.innerHTML = `<div class="yt-thumb">${thumb}${it.count ? `<span class="yt-badge">${it.count} video</span>` : ''}</div>` +
    `<div class="yt-meta"><div class="yt-title">${ytEsc(it.title)}</div><div class="yt-ch">${ytEsc(it.channel)}</div></div>`;
  el.onclick = () => ytOpen({ url: it.url, title: it.title });
  return el;
}
function ytOpen(view) { ytStack.push(view); ytRender(view); }
function ytBack() {
  ytStack.pop();
  const v = ytStack[ytStack.length - 1];
  if (v) ytRender(v); else showYtHome();
}
async function ytRender(v) {
  ytList.innerHTML = '<p class="hint">Yükleniyor…</p>';
  const url = v.feed ? '/api/yt/list?feed=' + v.feed : '/api/yt/list?url=' + encodeURIComponent(v.url) + '&title=' + encodeURIComponent(v.title || '');
  let r;
  try { r = await fetch(url).then(x => x.json()); } catch (e) { r = { error: e.message }; }
  if (ytStack[ytStack.length - 1] !== v) return;
  ytList.innerHTML = '';
  const back = document.createElement('div');
  back.className = 'channel-item';
  back.textContent = '⬅ ' + (ytStack.length > 1 ? 'Geri' : 'Kaldığın yerden');
  back.onclick = ytBack;
  ytList.appendChild(back);
  ytList.insertAdjacentHTML('beforeend', `<div class="list-heading">${ytEsc(r.title || v.title || '')}</div>`);
  if (r.error) { ytList.insertAdjacentHTML('beforeend', `<p class="hint yt-err">${ytEsc(r.error)}</p>`); return; }
  if (!r.items.length) { ytList.insertAdjacentHTML('beforeend', '<p class="hint">Bu liste boş.</p>'); return; }
  r.items.forEach(it => ytList.appendChild(it.type === 'video' ? ytItem(it) : ytListItem(it)));
  ytPrefetch(r.items.filter(it => it.type === 'video' && !it.live).slice(0, 6).map(it => it.id));
}
document.getElementById('yt-cookie-pick').addEventListener('click', () => document.getElementById('yt-cookie-file').click());
document.getElementById('yt-cookie-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const text = await f.text();
  showToast('Hesap deneniyor…');
  const r = await postJson('/api/yt/account', { text });
  if (!r.ok) return showToast(r.error || 'Bağlanamadı');
  ytAccount = true;
  document.getElementById('yt-account-box').style.display = 'none';
  renderYtFeeds();
  showToast('YouTube hesabı bağlandı');
  ytStack = []; ytMarkChip('subs'); ytOpen({ feed: 'subs', title: 'Abonelikler' });
});
document.getElementById('yt-account-remove').addEventListener('click', async () => {
  if (!confirm('YouTube hesap bağlantısı kaldırılsın mı?')) return;
  await postJson('/api/yt/account', { remove: true });
  ytAccount = false;
  document.getElementById('yt-account-box').style.display = 'none';
  renderYtFeeds();
  showYtHome();
});
document.getElementById('yt-account-close').addEventListener('click', () => { document.getElementById('yt-account-box').style.display = 'none'; });

function initYoutube() {
  fetch('/api/yt/account').then(r => r.json()).then(a => { ytAccount = !!a.connected; renderYtFeeds(); }).catch(() => renderYtFeeds());
  const last = lsGet('tp-yt-q', '');
  if (last) { ytQ.value = last; ytSearch(last); } else showYtHome();
}

// ===================== TV (Mi Box / Google TV): kumanda ile kullanım =====================
// Yön tuşları: gezinme · OK: seç · Geri: geri / tam ekrandan çık
// Film: OK = durdur/oynat, ◀ ▶ = 10 sn geri / 30 sn ileri · Canlı TV (tam ekran): ▲ ▼ = önceki/sonraki kanal, OK/◀ = liste
const isTV = currentPlatform === 'tv';
// Android, boş videoda büyük bir "oynat" resmi gösteriyor: siyah kalsın
const BLANK_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
['iptv-video', 'mp-video', 'yt-video'].forEach(id => { const v = document.getElementById(id); if (v) v.setAttribute('poster', BLANK_POSTER); });
const TV_SEL = 'button, input, select, .channel-item, .xt-item, .yt-item, .mp-item, .player-panel, .mp-player';
let tvWantFs = 0;
function tvVisible(el) {
  if (el.disabled) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.right <= 0 || r.left >= window.innerWidth) return false;
  if (el.closest('.mv-controls') && !mvControls.classList.contains('show')) return false;
  if (el.closest('.mv-menu') && !mvMenu.classList.contains('open')) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && st.pointerEvents !== 'none';
}
function tvFocus(el) {
  if (!el) return;
  if (!/^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(el.tagName) && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
// Odak kaybolduysa (liste yeniden çizildi) listedeki mantıklı bir öğeye dön
function tvListTarget(panel) {
  if (!panel) return null;
  const items = [...panel.querySelectorAll('.channel-item, .xt-item, .yt-item, .mp-item')].filter(tvVisible);
  return items.find(i => i.classList.contains('playing')) || items.find(i => !/^⬅/.test(i.textContent.trim())) || items[0] || null;
}
let tvLastPanel = null;
function tvRecover() {
  const sp = tvLastPanel && document.body.contains(tvLastPanel) && tvVisible(tvLastPanel) ? tvLastPanel : tvSidePanel();
  const t = tvListTarget(sp);
  if (t) { tvFocus(t); return true; }
  return false;
}
function tvMove(dir) {
  const cur = document.activeElement && document.activeElement !== document.body && document.body.contains(document.activeElement) ? document.activeElement : null;
  const scope = tvPopup ? tvPopup.box : document;
  const all = [...scope.querySelectorAll(TV_SEL)].filter(el => el !== cur && tvVisible(el));
  if (!cur || !tvVisible(cur)) { if (!tvRecover()) tvFocus(document.querySelector('.tab-btn.active') || all[0]); return; }
  const a = cur.getBoundingClientRect();
  const acx = a.left + a.width / 2, acy = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of all) {
    if (el.contains(cur) || cur.contains(el)) continue;
    const b = el.getBoundingClientRect();
    const bcx = b.left + b.width / 2, bcy = b.top + b.height / 2;
    let main, cross, overlap;
    if (dir === 'down') { if (b.top < a.bottom - 4) continue; main = b.top - a.bottom; cross = Math.abs(bcx - acx); overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left); }
    else if (dir === 'up') { if (b.bottom > a.top + 4) continue; main = a.top - b.bottom; cross = Math.abs(bcx - acx); overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left); }
    else if (dir === 'right') { if (b.left < a.right - 4) continue; main = b.left - a.right; cross = Math.abs(bcy - acy); overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); }
    else { if (b.right > a.left + 4) continue; main = a.left - b.right; cross = Math.abs(bcy - acy); overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); }
    const score = Math.max(0, main) + cross * (overlap > 0 ? 0.2 : 2);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) tvFocus(best);
}
function tvActiveTab() { return document.querySelector('.tab-content.active'); }
function tvPanel() { const t = tvActiveTab(); return t && t.querySelector('.player-panel, .mp-player'); }
function tvSidePanel() { const t = tvActiveTab(); return t && t.querySelector('.side-panel, .mp-browser'); }
function tvMovieHere() { return movie.active && movie.ctx && movie.ctx.panel === tvPanel(); }
function tvTogglePlay() {
  const v = tvMovieHere() ? MV() : activeVideo();
  if (v.paused) v.play().catch(() => {}); else v.pause();
  if (tvMovieHere()) showMovieControls();
}
function tvEnterFs() {
  document.body.classList.add('pseudo-fs');
  const sp = tvSidePanel();
  if (sp) sp.classList.remove('open');
  tvFocus(tvPanel());
  if (tvMovieHere()) showMovieControls();
}
function tvOpenList() {
  const sp = tvSidePanel();
  if (!sp) return;
  sp.classList.add('open');
  const name = tvActiveTab().id;
  if (listCtl[name]) listCtl[name].show();
  setTimeout(() => tvFocus(sp.querySelector('.playing') || [...sp.querySelectorAll(TV_SEL)].find(tvVisible)), 50);
}
// Canlı TV'de kanal değiştir (listede çalan kanalın önceki/sonraki kardeşi)
function tvZap(step) {
  const sp = tvSidePanel();
  const playing = sp && sp.querySelector('.channel-item.playing, .xt-item.playing');
  if (!playing) return;
  const sibs = [...playing.parentElement.children].filter(c => c.matches('.channel-item, .xt-item') && !/^⬅|^📁|^★ Favoriler|^📺/.test(c.textContent.trim()));
  const next = sibs[sibs.indexOf(playing) + step];
  if (!next) return;
  tvWantFs = Date.now();
  next.click();
  showToast(next.textContent.replace('★', '').trim());
}
function tvActivate(el) {
  if (!el) return;
  if (el.matches('.player-panel, .mp-player')) { tvEnterFs(); return; }
  if (el.matches('.channel-item, .xt-item, .yt-item, .mp-item')) tvWantFs = Date.now();
  tvLastPanel = el.closest('.side-panel, .mp-browser');
  el.click();
  // Tıklanan öğe listeyle birlikte silindiyse (yeni liste açıldı) odağı yeni listeye taşı
  [80, 400, 1200, 2500].forEach(ms => setTimeout(() => {
    const a = document.activeElement;
    if (!a || a === document.body || !document.body.contains(a)) tvRecover();
  }, ms));
}
// Açılır kutular (M3U listesi, Xtream hesabı) kumandayla açılmıyor: yerine seçim penceresi
let tvPopup = null;
function tvSelectPopup(sel) {
  tvClosePopup();
  const box = document.createElement('div');
  box.className = 'tv-popup';
  const inner = document.createElement('div');
  inner.className = 'tv-popup-box';
  box.appendChild(inner);
  let current = null;
  [...sel.options].forEach(o => {
    const b = document.createElement('button');
    b.className = 'tv-popup-opt' + (o.selected ? ' on' : '');
    b.textContent = (o.selected ? '✓ ' : '') + o.textContent;
    b.disabled = o.disabled;
    b.onclick = () => {
      tvClosePopup();
      if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      tvFocus(sel);
    };
    if (o.selected) current = b;
    inner.appendChild(b);
  });
  document.body.appendChild(box);
  tvPopup = { box, sel };
  tvFocus(current || inner.querySelector('button'));
}
function tvClosePopup() { if (tvPopup) { tvPopup.box.remove(); tvPopup = null; } }

// Geri tuşu. true: uygulama içinde bir şey yapıldı; false: TV uygulaması kapanabilir
function tvBack() {
  if (tvPopup) { const s = tvPopup.sel; tvClosePopup(); tvFocus(s); return true; }
  if (mvMenu.classList.contains('open')) { hideMovieMenu(); tvFocus(document.getElementById('mv-sub-btn')); return true; }
  const acc = document.getElementById('yt-account-box');
  if (acc && acc.style.display !== 'none' && tvActiveTab().id === 'youtube') { acc.style.display = 'none'; return true; }
  const fs = document.body.classList.contains('fs-on');
  const sp = tvSidePanel();
  if (fs) {
    if (sp && sp.classList.contains('open')) { sp.classList.remove('open'); tvFocus(tvPanel()); return true; }
    if (tvMovieHere() && mvControls.classList.contains('show')) { mvControls.classList.remove('show'); tvFocus(tvPanel()); return true; }
    document.body.classList.remove('pseudo-fs');
    setTimeout(() => tvFocus((sp && sp.querySelector('.playing')) || tvPanel()), 50);
    return true;
  }
  const ae = document.activeElement;
  if (sp && ae && sp.contains(ae)) {
    const bc = sp.querySelector('#xt-breadcrumb');
    const backItem = [...sp.querySelectorAll('.channel-item')].find(c => /^⬅/.test(c.textContent.trim()) && tvVisible(c));
    if (bc && bc.textContent.trim().startsWith('⬅') && tvVisible(bc)) { bc.click(); setTimeout(() => tvMove('down'), 300); return true; }
    if (backItem) { backItem.click(); setTimeout(() => tvFocus([...sp.querySelectorAll('.channel-item, .yt-item, .mp-item, .xt-item')].find(tvVisible)), 300); return true; }
  }
  const tab = document.querySelector('.tab-btn.active');
  if (ae !== tab) { tvFocus(tab); return true; }
  return false;
}
window.tvBack = tvBack;
// TV uygulaması sesli aramanın sonucunu buraya verir: YouTube'da ara
window.tvVoiceResult = text => {
  text = String(text || '').trim();
  if (!text) return;
  const tabBtn = document.querySelector('.tab-btn[data-tab="youtube"]');
  if (tabBtn && !tabBtn.classList.contains('active')) tabBtn.click();
  document.body.classList.remove('pseudo-fs');
  ytQ.value = text;
  ytSearch(text).then(() => setTimeout(() => tvFocus(document.querySelector('#yt-list .yt-item')), 100));
};
function tvKey(e) {
  const k = e.key;
  const ae = document.activeElement;
  const typing = ae && ((ae.tagName === 'INPUT' && ae.type !== 'range' && ae.type !== 'file') || ae.tagName === 'TEXTAREA');
  if (k === 'MediaPlayPause' || k === 'MediaPlay' || k === 'MediaPause') { e.preventDefault(); tvTogglePlay(); return; }
  if (k === 'MediaFastForward' && tvMovieHere()) { e.preventDefault(); movieSeekBy(30); return; }
  if (k === 'MediaRewind' && tvMovieHere()) { e.preventDefault(); movieSeekBy(-10); return; }
  if (k === 'ChannelUp' || k === 'ChannelDown' || k === 'MediaTrackNext' || k === 'MediaTrackPrevious') {
    e.preventDefault(); tvZap(k === 'ChannelUp' || k === 'MediaTrackNext' ? 1 : -1); return;
  }
  if ((k === 'GoBack' || k === 'BrowserBack' || (k === 'Backspace' && !typing)) && !window.TPTV) { if (tvBack()) e.preventDefault(); return; }
  if (typing && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Enter')) return;
  const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[k];
  const isOk = k === 'Enter' || k === ' ';
  if (!dir && !isOk) return;
  // Tam ekran video (liste kapalı, odak kontrollerde değil)
  const fs = document.body.classList.contains('fs-on');
  const sp = tvSidePanel();
  const inControls = ae && ae.closest && ae.closest('.mv-controls') && mvControls.classList.contains('show');
  if (fs && !(sp && sp.classList.contains('open')) && !inControls) {
    e.preventDefault();
    if (tvMovieHere()) {
      if (isOk) { tvTogglePlay(); return; }
      if (dir === 'left') return movieSeekBy(-10);
      if (dir === 'right') return movieSeekBy(30);
      showMovieControls();
      tvFocus(document.getElementById('mv-play'));
      return;
    }
    // ▲ = sonraki kanal (listede aşağı), ▼ = önceki kanal
    if (dir === 'up') return tvZap(1);
    if (dir === 'down') return tvZap(-1);
    if (isOk || dir === 'left') return tvOpenList();
    return;
  }
  if (inControls) showMovieControls();
  if (dir) {
    e.preventDefault();
    if (ae && ae.type === 'range' && (dir === 'left' || dir === 'right')) { movieSeekBy(dir === 'left' ? -10 : 30); return; }
    tvMove(dir);
    return;
  }
  if (isOk && ae && ae.tagName === 'SELECT') { e.preventDefault(); tvSelectPopup(ae); return; }
  if (isOk && ae && ae !== document.body && !/^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(ae.tagName)) { e.preventDefault(); tvActivate(ae); }
  else if (isOk && ae && ae.tagName === 'BUTTON') { e.preventDefault(); ae.click(); }
}
if (isTV) {
  document.body.classList.add('platform-tv', 'platform-tesla');
  allVideos().forEach(v => { v.controls = false; v.addEventListener('playing', () => {
    // Listeden bir şey seçilip oynamaya başlayınca tam ekrana geç
    if (tvWantFs && Date.now() - tvWantFs < 20000 && v.closest('.tab-content.active')) { tvWantFs = 0; tvEnterFs(); }
  }); });
  document.addEventListener('keydown', tvKey, true);
  // TV uygulamasının kendi ayarları (sunucu adresi, güncelleme)
  if (window.TPTV && window.TPTV.openSettings) {
    const b = document.createElement('button');
    b.className = 'tab-btn tv-settings';
    b.textContent = '⚙';
    b.title = 'TV uygulaması ayarları';
    b.onclick = () => window.TPTV.openSettings();
    document.querySelector('.tab-bar').appendChild(b);
  }
  // Sesle arama: kumandanın mikrofonu (TV uygulaması 1.0.2+)
  if (window.TPTV && window.TPTV.voiceSearch && (!window.TPTV.canVoice || window.TPTV.canVoice())) {
    const mic = document.createElement('button');
    mic.type = 'button';
    mic.className = 'yt-mic';
    mic.textContent = '🎤';
    mic.title = 'Sesle ara';
    mic.onclick = () => window.TPTV.voiceSearch();
    document.getElementById('yt-search-form').appendChild(mic);
  }
  setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) tvFocus(document.querySelector('.tab-btn.active')); }, 800);
}

// ===================== Jellyfin =====================
// Jellyfin uygulamanın kendi adresinden açılır (/web/...): Jellyfin'in kendi girişi ("Beni Hatırla")
// böylece tarayıcıda kalıcı olur, her açılışta tekrar sorulmaz.
function setupJellyfin(cfg) {
  const frame = document.getElementById('jellyfin-frame');
  if (cfg.jellyfinProxy) frame.src = '/web/index.html';
  else if (cfg.jellyfinUrl) frame.src = cfg.jellyfinUrl;
}

async function init() {
  // Ayarları paralel çek
  const [cfg] = await Promise.all([fetch('/api/config').then(r => r.json()), fetchState()]);
  setupJellyfin(cfg);
  xtreamEnabled = cfg.xtreamEnabled;
  renderM3uPicker();
  renderXtreamAccounts();

  // Son kanalı hemen başlat (liste yüklenmesini bekleme)
  const lc = appState.lastChannel;
  if (lc && lc.url) {
    if (lc.xtream) playXtreamLive({ name: lc.name, url: lc.url, tsUrl: lc.tsUrl, key: lc.key });
    else playChannel(lc.name, lc.url);
  }

  currentXtSection = appState.xtreamSection || 'live';
  document.querySelectorAll('.xt-sec-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.sec === currentXtSection);
  });

  if (appState.iptvMode === 'xtream') {
    setIptvMode('xtream');
  } else {
    loadActiveM3u(appState.lastChannel ? appState.lastChannel.url : null);
  }

  loadDir(appState.mediaPlayerLastPath || '');
  initYoutube();
}

init();
