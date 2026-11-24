package nl.dedplay.teslaplayer;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.speech.RecognizerIntent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.ArrayList;

/**
 * Tesla Player'ı tam ekran açan pencere. Bütün özellikler sunucudaki web uygulamasından gelir;
 * kumanda tuşları web uygulamasına iletilir (TV modu), Geri tuşu önce uygulamanın içinde geri gider.
 */
public class MainActivity extends Activity {
    private FrameLayout root;
    private WebView web;
    private WebChromeClient chrome;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private String loadedUrl;
    private boolean errorShown;
    private long lastBack;
    private static final int REQ_VOICE = 77;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        // Web uygulaması bu işaretten TV olduğunu anlar (kumanda modu)
        s.setUserAgentString(s.getUserAgentString() + " TeslaPlayerTV/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "TPTV");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError(String.valueOf(error.getDescription()));
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                showError(description);
            }
        });
        chrome = new WebChromeClient() {
            // Android'in boş videoda gösterdiği büyük "oynat" resmi yerine siyah
            @Override
            public Bitmap getDefaultVideoPoster() {
                Bitmap b = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
                b.eraseColor(Color.BLACK);
                return b;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                web.setVisibility(View.VISIBLE);
                if (customCallback != null) customCallback.onCustomViewHidden();
                customCallback = null;
            }
        };
        web.setWebChromeClient(chrome);

        loadedUrl = Prefs.url(this);
        web.loadUrl(loadedUrl);
        autoCheckUpdate();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        String url = Prefs.url(this);
        if (!url.equals(loadedUrl)) {
            loadedUrl = url;
            errorShown = false;
            web.loadUrl(url);
        } else if (errorShown) {
            errorShown = false;
            web.loadUrl(url);
        }
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    private void showError(String desc) {
        if (errorShown) return;
        errorShown = true;
        startActivity(new Intent(this, SettingsActivity.class).putExtra("error", desc));
    }

    void openSettings() {
        startActivity(new Intent(this, SettingsActivity.class));
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if (k == KeyEvent.KEYCODE_BACK || k == KeyEvent.KEYCODE_ESCAPE) {
            if (e.getAction() == KeyEvent.ACTION_UP) onBackKey();
            return true;
        }
        if (k == KeyEvent.KEYCODE_MENU || k == KeyEvent.KEYCODE_SETTINGS) {
            if (e.getAction() == KeyEvent.ACTION_UP) openSettings();
            return true;
        }
        // Kumandanın mikrofon / arama tuşu: sesle YouTube araması
        if (k == KeyEvent.KEYCODE_SEARCH || k == KeyEvent.KEYCODE_VOICE_ASSIST) {
            if (e.getAction() == KeyEvent.ACTION_UP) startVoice();
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    private void onBackKey() {
        if (customView != null) {
            chrome.onHideCustomView();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return (window.tvBack&&window.tvBack())?'y':'n'}catch(e){return 'n'}})()",
                value -> {
                    if (value != null && value.contains("y")) return;
                    long now = SystemClock.uptimeMillis();
                    if (now - lastBack < 2500) {
                        finish();
                    } else {
                        lastBack = now;
                        Toast.makeText(this, "Çıkmak için Geri'ye tekrar basın", Toast.LENGTH_SHORT).show();
                    }
                });
    }

    /** Android'in ses tanıması (Türkçe). Sonuç web uygulamasına gider: window.tvVoiceResult(metin) */
    void startVoice() {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "tr-TR");
        i.putExtra(RecognizerIntent.EXTRA_PROMPT, "Ne aramak istersin?");
        try {
            startActivityForResult(i, REQ_VOICE);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Bu cihazda sesle arama yok", Toast.LENGTH_LONG).show();
        }
    }

    boolean canVoice() {
        return !getPackageManager().queryIntentActivities(
                new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH), 0).isEmpty();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_VOICE || resultCode != RESULT_OK || data == null) return;
        ArrayList<String> r = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (r == null || r.isEmpty()) return;
        web.evaluateJavascript("window.tvVoiceResult && window.tvVoiceResult(" + JSONObject.quote(r.get(0)) + ")", null);
    }

    /** Açılışta (en fazla 6 saatte bir) yeni sürüm var mı bak, varsa sor. */
    private void autoCheckUpdate() {
        final SharedPreferences sp = Prefs.sp(this);
        long last = sp.getLong("lastUpdateCheck", 0);
        if (System.currentTimeMillis() - last < 6L * 3600 * 1000) return;
        sp.edit().putLong("lastUpdateCheck", System.currentTimeMillis()).apply();
        new Thread(() -> {
            try {
                final Updater.Release r = Updater.latest();
                if (r == null || r.code <= BuildConfig.VERSION_CODE) return;
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    new AlertDialog.Builder(this)
                            .setTitle("Yeni sürüm: " + Updater.versionName(r.code))
                            .setMessage("Tesla Player TV için güncelleme var. Şimdi kurulsun mu?")
                            .setPositiveButton("Güncelle", (d, w) -> startActivity(
                                    new Intent(this, SettingsActivity.class).putExtra("autoUpdate", true)))
                            .setNegativeButton("Sonra", null)
                            .show();
                });
            } catch (Exception ignored) {
                // Ağ yoksa sessizce geç
            }
        }).start();
    }

    /** Web uygulamasının çağırabildiği işlevler (window.TPTV). */
    private final class Bridge {
        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(MainActivity.this::openSettings);
        }

        @JavascriptInterface
        public void voiceSearch() {
            runOnUiThread(MainActivity.this::startVoice);
        }

        @JavascriptInterface
        public boolean canVoice() {
            return MainActivity.this.canVoice();
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }
    }
}
