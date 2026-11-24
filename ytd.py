# Tesla Player: sürekli açık yt-dlp yardımcısı (her video için Python/yt-dlp'yi baştan yüklememek için)
# stdin'den JSON satırı alır: {"rid": 1, "url": "...", "client": "visionos"}  ->  stdout'a JSON satırı
import sys, json
import yt_dlp

KEYS = ('title', 'channel', 'uploader', 'duration', 'is_live', 'live_status', 'language', 'formats',
        'subtitles', 'automatic_captions', 'http_headers')
ydls = {}

def ydl_for(client):
    if client not in ydls:
        opts = {'quiet': True, 'no_warnings': True, 'noplaylist': True, 'skip_download': True,
                'ignore_no_formats_error': True, 'noprogress': True}
        if client:
            opts['extractor_args'] = {'youtube': {'player_client': [client]}}
        ydls[client] = yt_dlp.YoutubeDL(opts)
    return ydls[client]

sys.stdout.write(json.dumps({'ready': True, 'version': yt_dlp.version.__version__}) + '\n')
sys.stdout.flush()
for line in sys.stdin:
    req = {}
    try:
        req = json.loads(line)
        ydl = ydl_for(req.get('client') or '')
        info = ydl.sanitize_info(ydl.extract_info(req['url'], download=False))
        out = {'rid': req.get('rid'), 'ok': True, 'info': {k: info.get(k) for k in KEYS}}
    except BaseException as e:  # noqa
        out = {'rid': req.get('rid'), 'ok': False, 'error': str(e)[:300]}
    sys.stdout.write(json.dumps(out) + '\n')
    sys.stdout.flush()
