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

## Film oynatıcı (M3U ve Xtream filmleri / dizileri)

- Filmler için kendi kontrolleri: durdur/oynat, 10 sn geri / 30 sn ileri, filmin tamamında sarma çubuğu, kaldığı yerden devam (her film ayrı, sunucuda saklanır).
- **Ses dili** ve **altyazı** seçimi (dosyanın içindeki diller). Türkçe altyazı varsa kendiliğinden açılır. Bilgisayardan/telefondan `.srt`/`.vtt` altyazı yüklenebilir, altyazı ±0,5 sn kaydırılabilir.
- mp4/H.264 dosyalar doğrudan oynar; mkv/avi vb. sunucuda ffmpeg ile akışa çevrilir (çoğunlukla kopyalayarak, işlemciyi yormadan).
- iPhone: ekran kilitlenince / uygulamadan çıkınca ses devam eder (kilit ekranından oynat/durdur ve sarma). Safari'den açıldığında en iyi çalışır; ana ekrana eklenmiş uygulamada iOS arka plan sesini kısıtlayabiliyor.

## Jellyfin: bir kere giriş

- Jellyfin artık uygulamanın kendi adresi üzerinden açılır (`/web/...`), böylece tarayıcı girişi unutmaz.
- Jellyfin sekmesinde kullanıcı adı/şifre bir kere kaydedilir (sunucuda saklanır, tarayıcıya gönderilmez); Tesla, iPhone ve Mac'te otomatik giriş yapılır. Sol alttaki ⚙ ile değiştirilir/silinir.
- Not: Uygulama adresine erişen herkes bu Jellyfin hesabıyla girmiş olur; yönetici olmayan bir Jellyfin kullanıcısı kullanmanız önerilir.
- Eski davranış (Jellyfin'i doğrudan kendi adresinden iframe ile açmak) için `JELLYFIN_PROXY=0`.
