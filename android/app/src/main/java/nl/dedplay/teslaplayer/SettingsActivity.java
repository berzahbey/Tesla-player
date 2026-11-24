package nl.dedplay.teslaplayer;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** TV uygulamasının ayarları: sunucu adresi ve GitHub'dan güncelleme. Kumandayla kullanılabilir. */
public class SettingsActivity extends Activity {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private EditText urlEdit;
    private TextView status;
    private Button updateBtn;
    private Updater.Release latest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(0xFF121212);
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(dp(64), dp(32), dp(64), dp(32));
        sv.addView(l);

        l.addView(text("Tesla Player — TV ayarları", 26, true, Color.WHITE));
        String err = getIntent().getStringExtra("error");
        if (err != null) l.addView(text("Sunucuya ulaşılamadı: " + err, 16, false, 0xFFFF6B6B));

        l.addView(space(16));
        l.addView(text("Sunucu adresi", 18, true, Color.WHITE));
        urlEdit = new EditText(this);
        urlEdit.setSingleLine(true);
        urlEdit.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlEdit.setImeOptions(EditorInfo.IME_ACTION_DONE);
        urlEdit.setTextColor(Color.WHITE);
        urlEdit.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        urlEdit.setText(Prefs.url(this));
        l.addView(urlEdit);
        l.addView(text("Örnek: https://player.dedplay.nl  ya da evde daha hızlı: http://192.168.1.2:8098", 14, false, 0xFFAAAAAA));
        Button save = button("Kaydet ve aç", v -> {
            saveUrl();
            finish();
        });
        l.addView(save);

        l.addView(space(24));
        l.addView(text("Uygulama sürümü: " + BuildConfig.VERSION_NAME, 18, true, Color.WHITE));
        status = text("", 16, false, 0xFFCCCCCC);
        l.addView(status);
        l.addView(button("Güncellemeleri denetle", v -> check(false)));
        updateBtn = button("Güncelle", v -> install());
        updateBtn.setVisibility(View.GONE);
        l.addView(updateBtn);

        l.addView(space(24));
        l.addView(button("Geri", v -> finish()));

        setContentView(sv);
        save.requestFocus();

        if (getIntent().getBooleanExtra("autoUpdate", false)) check(true);
        handleStatus(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleStatus(intent);
    }

    /** Android kurulum oturumundan gelen sonuç. */
    @SuppressWarnings("deprecation")
    private void handleStatus(Intent i) {
        if (i == null || !Updater.ACTION_STATUS.equals(i.getAction())) return;
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                try {
                    startActivity(confirm);
                    setStatus("Onay ekranında 'Yükle'yi seçin. Uygulama kapanıp yeni sürümle açılacak.");
                } catch (Exception e) {
                    setStatus("Kurulum ekranı açılamadı: " + e.getMessage());
                }
            }
        } else if (st == PackageInstaller.STATUS_SUCCESS) {
            setStatus("Güncelleme kuruldu.");
        } else {
            String msg = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            setStatus("Kurulum yapılamadı" + (msg != null ? ": " + msg : ""));
            updateBtn.setEnabled(true);
        }
    }

    private void saveUrl() {
        String u = urlEdit.getText().toString().trim();
        if (u.isEmpty()) u = BuildConfig.DEFAULT_URL;
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        Prefs.setUrl(this, u);
    }

    private void check(final boolean thenInstall) {
        setStatus("Denetleniyor…");
        updateBtn.setVisibility(View.GONE);
        new Thread(() -> {
            try {
                final Updater.Release r = Updater.latest();
                ui.post(() -> {
                    latest = r;
                    if (r == null) {
                        setStatus("GitHub'da henüz TV sürümü yok.");
                    } else if (r.code <= BuildConfig.VERSION_CODE) {
                        setStatus("Uygulama güncel (en yeni: " + Updater.versionName(r.code) + ").");
                    } else {
                        setStatus("Yeni sürüm var: " + Updater.versionName(r.code));
                        updateBtn.setText("Güncelle → " + Updater.versionName(r.code));
                        updateBtn.setEnabled(true);
                        updateBtn.setVisibility(View.VISIBLE);
                        updateBtn.requestFocus();
                        if (thenInstall) install();
                    }
                });
            } catch (final Exception e) {
                ui.post(() -> setStatus("Denetlenemedi: " + e.getMessage()));
            }
        }).start();
    }

    private void install() {
        if (latest == null) return;
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            setStatus("Önce Tesla Player'ın uygulama kurmasına izin verin (açılan ekranda), sonra tekrar 'Güncelle'ye basın.");
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())));
            } catch (Exception e) {
                setStatus("TV Ayarları > Cihaz Tercihleri > Güvenlik ve kısıtlamalar > Bilinmeyen kaynaklar bölümünde "
                        + "Tesla Player'a izin verin, sonra tekrar 'Güncelle'ye basın.");
            }
            return;
        }
        updateBtn.setEnabled(false);
        setStatus("İndiriliyor… %0");
        final Updater.Release r = latest;
        new Thread(() -> {
            try {
                Updater.install(this, r, pc -> ui.post(() -> setStatus("İndiriliyor… %" + pc)));
                ui.post(() -> setStatus("Kuruluyor… Uygulama birkaç saniye kapanıp yeni sürümle kendiliğinden açılacak."));
            } catch (final Exception e) {
                ui.post(() -> {
                    setStatus("Güncelleme yapılamadı: " + e.getMessage());
                    updateBtn.setEnabled(true);
                });
            }
        }).start();
    }

    private void setStatus(String s) {
        status.setText(s);
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private View space(int h) {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, dp(h)));
        return v;
    }

    private TextView text(String s, int sp, boolean bold, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(6), 0, dp(6));
        return t;
    }

    private Button button(String s, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        b.setLayoutParams(lp);
        b.setMinWidth(dp(280));
        return b;
    }
}
