package it.lippolis.timer;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Ponte fra l'app (JS) e TimerService.
 *  avvia({fine, durata, titolo, testo, colore, coloreTesto, volume, preavviso}) → {bolla: true|false}
 *  prova({volume})                                          → fa sentire l'allarme (anteprima dal Profilo)
 *  ferma()                                                  → toglie notifica, bolla e suono
 *  permessoBolla()                                          → apre "Mostra sopra altre app"
 *  evento "fermato"                                         → l'utente ha chiuso dalla notifica o dalla bolla
 */
@CapacitorPlugin(
    name = "TimerRecupero",
    permissions = { @Permission(strings = { "android.permission.POST_NOTIFICATIONS" }, alias = "notifiche") }
)
public class TimerRecuperoPlugin extends Plugin {

    private static TimerRecuperoPlugin istanza;
    private static boolean notificheChieste = false;

    @Override
    public void load() {
        istanza = this;
    }

    static void emetti(String evento) {
        TimerRecuperoPlugin p = istanza;
        if (p != null) p.notifyListeners(evento, new JSObject());
    }

    @PluginMethod
    public void avvia(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && !notificheChieste
                && getPermissionState("notifiche") != PermissionState.GRANTED) {
            notificheChieste = true;
            requestPermissionForAlias("notifiche", call, "dopoNotifiche");
            return;
        }
        esegui(call);
    }

    @PermissionCallback
    private void dopoNotifiche(PluginCall call) {
        esegui(call);
    }

    private void esegui(PluginCall call) {
        Context ctx = getContext();
        JSObject d = call.getData();
        Intent i = new Intent(ctx, TimerService.class)
            .setAction(TimerService.AVVIA)
            .putExtra("fine", d.optLong("fine", System.currentTimeMillis()))
            .putExtra("durata", d.optLong("durata", 0))
            .putExtra("titolo", d.optString("titolo", "Recupero"))
            .putExtra("testo", d.optString("testo", ""))
            .putExtra("colore", d.optString("colore", "#12C7A2"))
            .putExtra("coloreTesto", d.optString("coloreTesto", "#04231B"))
            .putExtra("volume", (float) d.optDouble("volume", 0.7))
            .putExtra("preavviso", d.optLong("preavviso", 3000));
        try {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception e) {
            call.reject("Timer nativo non avviato: " + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("bolla", TimerService.puoBolla(ctx));
        call.resolve(r);
    }

    private static android.media.MediaPlayer anteprima;

    @PluginMethod
    public void prova(PluginCall call) {
        fermaAnteprima();
        try {
            anteprima = TimerService.avviaPlayer(getContext(), (float) call.getData().optDouble("volume", 0.7), 0);
            anteprima.setOnCompletionListener(new android.media.MediaPlayer.OnCompletionListener() {
                @Override public void onCompletion(android.media.MediaPlayer m) { fermaAnteprima(); }
            });
            call.resolve();
        } catch (Exception e) {
            call.reject("Anteprima non riprodotta: " + e.getMessage());
        }
    }

    private static void fermaAnteprima() {
        if (anteprima != null) {
            try { anteprima.stop(); } catch (Exception ignored) { }
            try { anteprima.release(); } catch (Exception ignored) { }
            anteprima = null;
        }
    }

    @PluginMethod
    public void ferma(PluginCall call) {
        fermaAnteprima();
        TimerService.fermaDaFuori();
        call.resolve();
    }

    @PluginMethod
    public void permessoBolla(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 23) {
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } catch (Exception ignored) { }
        }
        call.resolve();
    }

    @Override
    protected void handleOnResume() {
        TimerService.impostaAppVisibile(true);
    }

    @Override
    protected void handleOnPause() {
        TimerService.impostaAppVisibile(false);
    }
}
