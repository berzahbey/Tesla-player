package nl.dedplay.teslaplayer;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Güncelleme: GitHub'daki "Releases" bölümünden en yeni "tv-vNN" sürümünün APK'sını bulur,
 * indirir ve Android'in kendi kurulum ekranıyla kurar.
 */
final class Updater {
    static final String ACTION_STATUS = "nl.dedplay.teslaplayer.INSTALL_STATUS";

    static final class Release {
        int code;
        String name;
        String apkUrl;
        long size;
    }

    interface Progress {
        void onProgress(int percent);
    }

    private Updater() {}

    static String versionName(int code) {
        return "1.0." + code;
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "TeslaPlayerTV/" + BuildConfig.VERSION_NAME);
        return c;
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        in.close();
        return b.toString("UTF-8");
    }

    /** En yeni TV sürümü (yoksa null). Ağ işlemi: ana iş parçacığında çağırmayın. */
    static Release latest() throws Exception {
        HttpURLConnection c = open("https://api.github.com/repos/" + BuildConfig.UPDATE_REPO + "/releases?per_page=30");
        c.setRequestProperty("Accept", "application/vnd.github+json");
        int code = c.getResponseCode();
        if (code != 200) throw new IOException("GitHub yanıtı " + code);
        JSONArray arr = new JSONArray(readAll(c.getInputStream()));
        Release best = null;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject r = arr.getJSONObject(i);
            if (r.optBoolean("draft") || r.optBoolean("prerelease")) continue;
            String tag = r.optString("tag_name", "");
            if (!tag.startsWith("tv-v")) continue;
            int v;
            try {
                v = Integer.parseInt(tag.substring(4));
            } catch (NumberFormatException e) {
                continue;
            }
            JSONArray assets = r.optJSONArray("assets");
            if (assets == null) continue;
            for (int j = 0; j < assets.length(); j++) {
                JSONObject a = assets.getJSONObject(j);
                if (!a.optString("name", "").endsWith(".apk")) continue;
                if (best == null || v > best.code) {
                    best = new Release();
                    best.code = v;
                    best.name = r.optString("name", tag);
                    best.apkUrl = a.optString("browser_download_url", "");
                    best.size = a.optLong("size", 0);
                }
                break;
            }
        }
        return best;
    }

    /** APK'yı indirip kurulum oturumuna yazar; sonuç SettingsActivity'ye ACTION_STATUS ile gelir. */
    static void install(Activity a, Release r, Progress p) throws Exception {
        HttpURLConnection c = open(r.apkUrl);
        int code = c.getResponseCode();
        if (code != 200) throw new IOException("İndirme hatası " + code);
        long total = c.getContentLength() > 0 ? c.getContentLength() : r.size;

        PackageInstaller pi = a.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params =
                new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(a.getPackageName());
        if (total > 0) params.setSize(total);
        int sid = pi.createSession(params);
        PackageInstaller.Session s = pi.openSession(sid);
        boolean ok = false;
        try {
            OutputStream out = s.openWrite("update.apk", 0, total > 0 ? total : -1);
            InputStream in = c.getInputStream();
            byte[] buf = new byte[65536];
            long done = 0;
            int n;
            int last = -1;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                if (total > 0) {
                    int pc = (int) (done * 100 / total);
                    if (pc != last) {
                        last = pc;
                        p.onProgress(pc);
                    }
                }
            }
            in.close();
            s.fsync(out);
            out.close();

            Intent i = new Intent(a, SettingsActivity.class).setAction(ACTION_STATUS);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent pend = PendingIntent.getActivity(a, sid, i, flags);
            s.commit(pend.getIntentSender());
            ok = true;
        } finally {
            if (ok) s.close();
            else s.abandon();
        }
    }
}
