package nl.dedplay.teslaplayer;

import android.content.Context;
import android.content.SharedPreferences;

/** Uygulamanın kalıcı ayarları (sunucu adresi, son güncelleme denetimi). */
final class Prefs {
    private Prefs() {}

    static SharedPreferences sp(Context c) {
        return c.getSharedPreferences("tesla_player", Context.MODE_PRIVATE);
    }

    static String url(Context c) {
        return sp(c).getString("url", BuildConfig.DEFAULT_URL);
    }

    static void setUrl(Context c, String url) {
        sp(c).edit().putString("url", url).apply();
    }
}
