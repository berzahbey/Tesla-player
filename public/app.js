function supportsNativeHls() {
  const testVideo = document.createElement('video');
  return testVideo.canPlayType('application/vnd.apple.mpegurl') !== '';
}

function detectPlatform() {
  const ua = navigator.userAgent || "";
  let platform;
  if (/Tesla|QtCarBrowser/i.test(ua)) {
    platform = "tesla";
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
    const panel = target === 'iptv'
      ? document.getElementById('iptv-side-panel')
      : document.getElementById('mp-side-panel');
    panel.classList.toggle('open');
  });
});

document.querySelectorAll('.fullscreen-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = document.getElementById(btn.dataset.target);
    if (!document.fullscreenElement) {
      panel.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  });
});

document.getElementById('mode-m3u-btn').addEventListener('click', () => setIptvMode('m3u'));
document.getElementById('mode-xtream-btn').addEventListener('click', () => setIptvMode('xtream'));

function setIptvMode(mode) {
  document.getElementById('mode-m3u-btn').classList.toggle('active', mode === 'm3u');
  document.getElementById('mode-xtream-btn').classList.toggle('active', mode === 'xtream');
  document.getElementById('m3u-mode').style.display = mode === 'm3u' ? 'block' : 'none';
  document.getElementById('xtream-mode').style.display = mode === 'xtream' ? 'block' : 'none';
  saveStateField('/api/state/m3u-mode', { mode });

  if (mode === 'xtream') {
    if (!xtreamEnabled) {
      document.getElementById('xt-list').innerHTML = '<p style="color:#f66">Xtream ayarları tanımlı değil.</p>';
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
  const lines = text.split('\n');
  const channels = [];
  const groupOrder = [];
  let name = '', group = '';
  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      const parts = line.split(',');
      name = parts[parts.length - 1].trim();
      const g = /group-title="([^"]*)"/i.exec(line);
      group = g ? g[1].trim() : '';
    } else if (line.trim() && !line.startsWith('#')) {
      if (!groupOrder.includes(group)) groupOrder.push(group);
      // num = listedeki sıra, groupPos = grubun listedeki sırası (favorileri gruplamak için)
      channels.push({ name: name || line.trim(), url: line.trim(), group, groupPos: groupOrder.indexOf(group), num: channels.length });
      name = ''; group = '';
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
  stopPlayback();
  if (url.includes('.m3u8') && supportsNativeHls()) {
    iptvVideo.src = url;
  } else if (url.includes('.m3u8') && Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(iptvVideo);
  } else {
    iptvVideo.src = url;
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
let lowResDevice = lsGet('tp-lowres', false);
let lowResKeys = lsGet('tp-lowres-keys', []);
function markLowRes(key) {
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
  if (url.includes('.m3u8') && supportsNativeHls() && isAppleNative()) {
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
    hls = new Hls();
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
  (appState.favorites || []).filter(f => f.kind === kind).forEach((f, i) => {
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
function favList(kind) {
  return favGroups(kind).flatMap(G => G.items);
}

async function saveFavOrder(kind, group, ids) {
  const r = await fetch('/api/state/favorites-order', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, group, ids })
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
  return (appState.favorites || []).some(f => f.kind === kind && f.id === String(id));
}
// Normal listede basılı tutmak sadece EKLER (kazara silinmesin); çıkarmak Favoriler sekmesinden.
async function addFav(item) {
  if (isFav(item.kind, item.id)) { showToast('★ Zaten favorilerde'); return false; }
  return toggleFav(item);
}
async function toggleFav(item) {
  const r = await fetch('/api/state/favorite-toggle', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item })
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
function renderChannels(channels, autoSelectUrl) {
  lastM3UChannels = channels;
  const list = document.getElementById('m3u-channel-list');
  list.innerHTML = '';
  const playingUrl = autoSelectUrl || (appState.lastChannel && appState.lastChannel.url);

  const addItem = (ch, container, inFavBlock) => {
    const el = document.createElement('div');
    el.className = 'channel-item';
    el.innerHTML = itemHtml('', ch.name, isFav('m3u', ch.url));
    if (playingUrl && ch.url === playingUrl) el.classList.add('playing');
    const open = () => {
      playChannel(ch.name, ch.url);
      document.querySelectorAll('.channel-item').forEach(x => x.classList.remove('playing'));
      el.classList.add('playing');
    };
    if (inFavBlock) {
      bindFavItem(el, 'm3u', ch.url, open, async () => {
        await toggleFav({ kind: 'm3u', id: ch.url, name: ch.name });
        renderChannels(lastM3UChannels);
      }, ch.group);
      container.appendChild(el);
      return;
    }
    bindPress(el, open, async () => {
      // M3U grubu boşsa da '' yerine '(grupsuz)' gibi sabit bir değer: listedeki sırası korunsun
      const fav = { kind: 'm3u', id: ch.url, name: ch.name, url: ch.url, num: ch.num, group: ch.group || '_', groupName: ch.group || '', groupPos: ch.groupPos };
      if (inFavBlock) await toggleFav(fav); else await addFav(fav);
      renderChannels(lastM3UChannels);
    });
    container.appendChild(el);
  };

  const favs = favList('m3u');
  if (favs.length) {
    const h = document.createElement('div');
    h.className = 'list-heading';
    h.textContent = '★ Favoriler';
    list.appendChild(h);
    favs.forEach(f => addItem({ name: f.name, url: f.url, group: f.group || '' }, list, true));
    const h2 = document.createElement('div');
    h2.className = 'list-heading';
    h2.textContent = 'Tüm kanallar';
    list.appendChild(h2);
  }
  channels.forEach(ch => addItem(ch, list));
}

function loadM3UFromUrl(url, autoSelectUrl) {
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
      renderChannels(channels, autoSelectUrl);
    })
    .catch(err => {
      document.getElementById('m3u-channel-list').innerHTML = '<p style="color:#f66">Hata: ' + err.message + '</p>';
    });
}

document.getElementById('m3u-load-btn').addEventListener('click', () => {
  const url = document.getElementById('m3u-url').value.trim();
  if (!url) return;
  saveStateField('/api/state/m3u-url', { url });
  loadM3UFromUrl(url);
});

document.getElementById('m3u-file-load-btn').addEventListener('click', () => {
  const fileInput = document.getElementById('m3u-file');
  const file = fileInput.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('m3ufile', file);
  fetch('/api/state/m3u-file', { method: 'POST', body: formData })
    .then(() => fetch('/api/m3u-file-content'))
    .then(r => r.text())
    .then(text => renderChannels(parseM3U(text)));
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
  const open = () => {
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

function showXtreamFavorites() {
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

async function playVodOrEpisode(url, label, needsRemux) {
  stopPlayback();
  const token = playToken;

  if (needsRemux) {
    await playViaSession(url, { live: false, mode: 'auto', label });
    return;
  }

  if (url.includes('.m3u8')) attachHls(url, {});
  else { iptvVideo.src = url; iptvVideo.play().catch(() => {}); }

  if (appState.resumeXtream && appState.resumeXtream.url === url && appState.resumeXtream.position > 5) {
    iptvVideo.currentTime = appState.resumeXtream.position;
  }

  let lastSaved = 0;
  iptvVideo.ontimeupdate = () => {
    const now = Date.now();
    if (now - lastSaved > 5000) {
      lastSaved = now;
      saveStateField('/api/state/resume-xtream', {
        url,
        position: iptvVideo.currentTime,
        label
      });
    }
  };
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

async function playVideo(p) {
  const video = document.getElementById('mp-video');
  const audio = document.getElementById('mp-audio');
  audio.pause(); audio.style.display = 'none';
  video.style.display = 'block';

  if (mpHls) { mpHls.destroy(); mpHls = null; }

  const ext = p.split('.').pop().toLowerCase();

  if (MP_REMUX_EXT.includes(ext)) {
    document.getElementById('mp-list').style.opacity = '0.5';
    try {
      const r = await fetch('/api/session/start?local=1&live=0&mode=auto&src=' + encodeURIComponent(p));
      const data = await r.json();
      document.getElementById('mp-list').style.opacity = '1';
      if (!data.playlist) {
        alert('Video dönüştürülemedi: ' + (data.error || 'bilinmeyen hata'));
        return;
      }
      if (supportsNativeHls()) {
        video.src = data.playlist;
      } else if (Hls.isSupported()) {
        mpHls = new Hls();
        mpHls.loadSource(data.playlist);
        mpHls.attachMedia(video);
      } else {
        video.src = data.playlist;
      }
      video.play().catch(() => {});
    } catch (e) {
      document.getElementById('mp-list').style.opacity = '1';
      alert('Video dönüştürülemedi: ' + e.message);
    }
    return;
  }

  video.src = '/stream?path=' + encodeURIComponent(p);
  attachResumeTracking(video, p);
  video.play().catch(() => {});
}

function playAudio(p) {
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
function setupAutoHideList(panelId, playerId, videoId, tabId) {
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
    if (isDrawer()) panel.classList.remove('open');
    else panel.classList.add('collapsed');
  };
  const schedule = (delay = LIST_HIDE_DELAY) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!hovering && !video.paused && !panel.contains(document.activeElement)) hide();
    }, delay);
  };
  const show = () => {
    if (isDrawer()) panel.classList.add('open');
    else panel.classList.remove('collapsed');
    schedule();
  };

  // Kanal oynamaya başlayınca birkaç saniye sonra gizle
  video.addEventListener('playing', () => schedule(3000));
  // Video durunca liste geri gelsin
  video.addEventListener('pause', () => { clearTimeout(timer); });

  // Videoya dokununca / tıklayınca listeyi geri getir (oynatıcı kontrolleri yine çalışır)
  player.addEventListener('pointerdown', e => {
    if (e.target.closest('.fullscreen-btn')) return;
    if (isHidden()) show();
    else if (isDrawer()) { clearTimeout(timer); hide(); }
    else schedule();
  });
  // Mac/PC: fare video üstünde hareket edince de liste gelsin (tıklayıp videoyu durdurmaya gerek yok)
  let lastMove = 0;
  player.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
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
  iptv: setupAutoHideList('iptv-side-panel', 'iptv-player-panel', 'iptv-video', 'iptv'),
  mediaplayer: setupAutoHideList('mp-side-panel', 'mp-player-panel', 'mp-video', 'mediaplayer')
};

// Çekmece butonuyla açılan liste de oynatma sırasında kendiliğinden kapansın
document.querySelectorAll('.drawer-toggle').forEach(btn => {
  btn.addEventListener('click', () => listCtl[btn.dataset.target].schedule());
});

async function init() {
  // Ayarları paralel çek
  const [cfg] = await Promise.all([fetch('/api/config').then(r => r.json()), fetchState()]);
  if (cfg.jellyfinUrl) document.getElementById('jellyfin-frame').src = cfg.jellyfinUrl;
  xtreamEnabled = cfg.xtreamEnabled;

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
    document.getElementById('m3u-url').value =
      appState.m3uSource && appState.m3uSource.type === 'url' ? appState.m3uSource.value : '';

    if (appState.m3uSource && appState.m3uSource.type === 'file') {
      const r = await fetch('/api/m3u-file-content');
      const text = await r.text();
      renderChannels(parseM3U(text), appState.lastChannel ? appState.lastChannel.url : null);
    } else if (appState.m3uSource && appState.m3uSource.value) {
      loadM3UFromUrl(appState.m3uSource.value, appState.lastChannel ? appState.lastChannel.url : null);
    }
  }

  loadDir(appState.mediaPlayerLastPath || '');
}

init();
