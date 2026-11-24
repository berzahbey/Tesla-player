package nl.dedplay.teslaplayer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Güncelleme kurulunca uygulamayı yeniden aç (Android kurulum sırasında uygulamayı kapatıyor). */
public class UpdatedReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        try {
            Intent i = new Intent(context, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(i);
        } catch (Exception ignored) {
            // Bazı Android sürümleri arka plandan açmaya izin vermiyor: kullanıcı kendisi açar
        }
    }
}
