# Tesla Player

IPTV/M3U, Xtream Codes, Jellyfin ve kişisel medya klasörü oynatıcısını tek sayfada birleştiren, Tesla/mobil/masaüstü arayüzüne otomatik uyum sağlayan web uygulaması.

## Hızlı kurulum (Docker Hub image ile)

1. `docker-compose.example.yml` dosyasını sunucunuza `docker-compose.yml` adıyla kopyalayın.
2. İçindeki `JELLYFIN_URL`, `XTREAM_SERVER`, `XTREAM_USERNAME`, `XTREAM_PASSWORD` değerlerini kendinize göre düzenleyin.
3. `/YOUR/HOST/MEDIA/PATH` kısmını video/müzik klasörünüzün gerçek yoluyla değiştirin.
4. Çalıştırın:

```bash
docker compose up -d
```

Uygulama `http://SUNUCU_IP:8098` adresinde açılır.

## Kaynak koddan build etmek isterseniz

```bash
git clone https://github.com/berzahbey/Tesla-player.git
cd Tesla-player
docker compose up -d --build
```

## 4K / HEVC kanallar ve hızlı açılış (Xtream)

- Xtream canlı kanallar artık doğrudan `.ts` akışıyla açılır (mpegts.js); `.m3u8` yalnızca yedek olarak ve iPhone/iPad/Safari'de kullanılır. Bu, çoğu sağlayıcıda kanal açılışını belirgin şekilde hızlandırır.
- Tarayıcının çözemediği 4K/HEVC kanallarda (ses var, görüntü siyah) uygulama bunu otomatik algılar ve kanalı sunucuda ffmpeg ile **H.264 1080p**'ye dönüştürür ("Uyumluluk modu"). Böyle bir kanal hatırlanır, sonraki açılışta doğrudan dönüştürülür.
- Intel GPU'lu sunucularda (`/dev/dri`) dönüştürme donanımla (VAAPI) yapılır; yoksa yazılımla (libx264) yapılır. Kapatmak için `DISABLE_VAAPI=1`.
- İsteğe bağlı: `TRANSCODE_MAX_HEIGHT` (varsayılan `1080`).
