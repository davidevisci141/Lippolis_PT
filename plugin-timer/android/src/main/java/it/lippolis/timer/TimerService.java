package it.lippolis.timer;

import android.annotation.SuppressLint;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.content.res.AssetFileDescriptor;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Timer di recupero che vive fuori dalla WebView:
 *  - notifica fissa con conto alla rovescia (visibile anche a schermo bloccato);
 *  - bolla trascinabile sopra le altre app, solo quando LIPPOLIS PT non è in primo piano;
 *  - 3" prima della fine parte il suono sul volume Sveglia (tre rintocchi di preavviso, poi l'arpeggio
 *    ripetuto due volte), scalato dal cursore volume dell'app; allo scadere vibrazione e bolla rossa.
 * L'avvio del suono è garantito due volte: Handler con wake lock parziale e allarme esatto di riserva.
 */
public class TimerService extends Service {

    static final String AVVIA = "it.lippolis.timer.AVVIA";
    static final String SCADUTO = "it.lippolis.timer.SCADUTO";
    static final String FERMA_UTENTE = "it.lippolis.timer.FERMA_UTENTE";

    private static final String CH_CORSO = "timer_recupero_corso";
    private static final String CH_FINE = "timer_recupero_fine";
    private static final int NOTIF_ID = 4711;
    private static final long CHIUSURA_DOPO_FINE_MS = 8000;
    private static final long[] VIBRA = {0, 180, 80, 180, 80, 180, 550, 180, 80, 180, 80, 180};
    private static final String PREFS = "timer_recupero";

    private static TimerService istanza;
    private static volatile boolean appVisibile = true;

    private final Handler h = new Handler(Looper.getMainLooper());
    private long fine;
    private String titolo = "Recupero", testo = "";
    private int colore = Color.parseColor("#12C7A2"), coloreTesto = Color.parseColor("#04231B");
    private boolean attivo = false, scaduto = false, suonato = false;
    private float volume = 0.7f;
    private long preavviso = 3000;

    private MediaPlayer mp;
    private AudioManager am;
    private AudioFocusRequest afr;
    private PowerManager.WakeLock wl;
    private WindowManager wm;
    private LinearLayout bolla;
    private TextView bollaTempo;
    private WindowManager.LayoutParams lp;

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            aggiornaBolla();
            if (!attivo || scaduto) return;
            long ora = System.currentTimeMillis();
            if (!suonato && ora >= fine - preavviso) {
                suonato = true;
                suona((int) Math.min(preavviso, ora - (fine - preavviso)));
            }
            if (ora >= fine) scadenza();
            else h.postDelayed(this, 100);
        }
    };
    private final Runnable chiusuraAuto = new Runnable() { @Override public void run() { chiudi(); } };

    // ─────────────── chiamate dal plugin ───────────────
    static boolean puoBolla(Context c) {
        return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(c);
    }

    static void fermaDaFuori() {
        final TimerService s = istanza;
        if (s != null) s.h.post(new Runnable() { @Override public void run() { s.chiudi(); } });
    }

    static void impostaAppVisibile(boolean v) {
        appVisibile = v;
        final TimerService s = istanza;
        if (s != null) s.h.post(new Runnable() { @Override public void run() { s.aggiornaVisibilitaBolla(); } });
    }

    // ─────────────── ciclo di vita ───────────────
    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        istanza = this;
        creaCanali();
    }

    @Override public int onStartCommand(Intent i, int flags, int startId) {
        String a = (i != null && i.getAction() != null) ? i.getAction() : "";
        if (AVVIA.equals(a)) {
            fine = i.getLongExtra("fine", System.currentTimeMillis());
            titolo = testoOr(i.getStringExtra("titolo"), "Recupero");
            testo = testoOr(i.getStringExtra("testo"), "");
            colore = coloreOr(i.getStringExtra("colore"), colore);
            coloreTesto = coloreOr(i.getStringExtra("coloreTesto"), coloreTesto);
            volume = limita(i.getFloatExtra("volume", volume));
            preavviso = Math.max(0, i.getLongExtra("preavviso", preavviso));
            h.removeCallbacksAndMessages(null);
            fermaSuono();
            scaduto = false;
            suonato = false;
            attivo = true;
            primoPiano(notificaCorsa());
            salva();
            programmaAllarme();
            prendiWakeLock();
            aggiornaVisibilitaBolla();
            h.post(tick);
        } else if (SCADUTO.equals(a)) {
            if (!attivo) ripristina();        // processo ricreato dall'allarme di riserva
            primoPiano(attivo ? notificaCorsa() : notificaFine());
            if (attivo && !scaduto && System.currentTimeMillis() - fine < 60_000) {
                prendiWakeLock();
                h.removeCallbacks(tick);
                h.post(tick);
            } else if (!attivo) chiudi();
        } else if (FERMA_UTENTE.equals(a)) {
            primoPiano(notificaCorsa());
            TimerRecuperoPlugin.emetti("fermato");
            chiudi();
        } else {
            primoPiano(notificaCorsa());
            if (!attivo) chiudi();
        }
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        h.removeCallbacksAndMessages(null);
        fermaSuono();
        togliBolla();
        rilasciaWakeLock();
        if (istanza == this) istanza = null;
        super.onDestroy();
    }

    // ─────────────── scadenza e chiusura ───────────────
    private void scadenza() {
        if (scaduto) return;
        scaduto = true;
        annullaAllarme();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, notificaFine());
        if (!suonato) {                      // preavviso perso (telefono addormentato): almeno l'arpeggio
            suonato = true;
            suona((int) preavviso);
        }
        vibra();
        aggiornaBolla();
        h.postDelayed(chiusuraAuto, CHIUSURA_DOPO_FINE_MS);
    }

    private void chiudi() {
        attivo = false;
        scaduto = false;
        h.removeCallbacksAndMessages(null);
        annullaAllarme();
        fermaSuono();
        togliBolla();
        rilasciaWakeLock();
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    private void salva() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putLong("fine", fine).putString("titolo", titolo).putString("testo", testo)
            .putInt("colore", colore).putInt("coloreTesto", coloreTesto)
            .putFloat("volume", volume).putLong("preavviso", preavviso).apply();
    }

    private void ripristina() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!p.contains("fine")) return;
        fine = p.getLong("fine", 0);
        titolo = p.getString("titolo", titolo);
        testo = p.getString("testo", testo);
        colore = p.getInt("colore", colore);
        coloreTesto = p.getInt("coloreTesto", coloreTesto);
        volume = p.getFloat("volume", volume);
        preavviso = p.getLong("preavviso", preavviso);
        attivo = true;
        scaduto = false;
        suonato = false;
    }

    // ─────────────── notifiche ───────────────
    private void creaCanali() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel corso = new NotificationChannel(CH_CORSO, "Timer di recupero", NotificationManager.IMPORTANCE_LOW);
        corso.setDescription("Conto alla rovescia del recupero in corso");
        corso.setSound(null, null);
        corso.enableVibration(false);
        corso.setShowBadge(false);
        corso.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationChannel fineCh = new NotificationChannel(CH_FINE, "Fine recupero", NotificationManager.IMPORTANCE_HIGH);
        fineCh.setDescription("Avviso a recupero terminato (il suono lo gestisce l'app, sul volume Sveglia)");
        fineCh.setSound(null, null);
        fineCh.enableVibration(false);
        fineCh.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(corso);
        nm.createNotificationChannel(fineCh);
    }

    @SuppressWarnings("deprecation")
    private Notification.Builder base(String canale) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, canale)
            : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentIntent(piApri())
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_ALARM)
            .setColor(colore)
            .setOngoing(true);
        return b;
    }

    @SuppressWarnings("deprecation")
    private Notification notificaCorsa() {
        Notification.Builder b = base(CH_CORSO)
            .setContentTitle(titolo)
            .setContentText(testo)
            .setOnlyAlertOnce(true)
            .setWhen(fine)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .addAction(0, "Ferma", piFerma());
        if (Build.VERSION.SDK_INT >= 24) b.setChronometerCountDown(true);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_LOW);
        return b.build();
    }

    @SuppressWarnings("deprecation")
    private Notification notificaFine() {
        Notification.Builder b = base(CH_FINE)
            .setContentTitle("Recupero terminato")
            .setContentText(titolo + " · è ora della prossima serie")
            .setShowWhen(false)
            .addAction(0, "Chiudi", piFerma());
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(0);
        return b.build();
    }

    private void primoPiano(Notification n) {
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIF_ID, n);
    }

    private PendingIntent piApri() {
        Intent li = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (li == null) li = new Intent();
        li.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        return PendingIntent.getActivity(this, 10, li, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent piFerma() {
        Intent i = new Intent(this, TimerService.class).setAction(FERMA_UTENTE);
        return PendingIntent.getService(this, 11, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent piScaduto() {
        Intent i = new Intent(this, TimerService.class).setAction(SCADUTO);
        int f = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return Build.VERSION.SDK_INT >= 26
            ? PendingIntent.getForegroundService(this, 12, i, f)
            : PendingIntent.getService(this, 12, i, f);
    }

    // ─────────────── allarme di riserva e wake lock ───────────────
    private void programmaAllarme() {
        AlarmManager al = (AlarmManager) getSystemService(ALARM_SERVICE);
        if (al == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 31 && !al.canScheduleExactAlarms())
                al.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fine - preavviso, piScaduto());
            else
                al.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fine - preavviso, piScaduto());
        } catch (Exception ignored) { }
    }

    private void annullaAllarme() {
        AlarmManager al = (AlarmManager) getSystemService(ALARM_SERVICE);
        if (al != null) al.cancel(piScaduto());
    }

    @SuppressLint("WakelockTimeout")
    private void prendiWakeLock() {
        rilasciaWakeLock();
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm == null) return;
        wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lippolis:timer");
        long durata = Math.max(0, fine - System.currentTimeMillis()) + CHIUSURA_DOPO_FINE_MS + 5000;
        wl.acquire(durata);
    }

    private void rilasciaWakeLock() {
        try { if (wl != null && wl.isHeld()) wl.release(); } catch (Exception ignored) { }
        wl = null;
    }

    // ─────────────── suono e vibrazione ───────────────
    static AudioAttributes attributiSveglia() {
        return new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
    }

    static float limita(float v) {
        return Float.isNaN(v) ? 0.7f : Math.max(0f, Math.min(1f, v));
    }

    /** Crea e avvia il player dell'allarme: volume 0-1 con curva quadratica, partenza da offsetMs. */
    static MediaPlayer avviaPlayer(Context c, float vol, int offsetMs) throws Exception {
        MediaPlayer p = new MediaPlayer();
        try {
            p.setAudioAttributes(attributiSveglia());
            AssetFileDescriptor fd = c.getResources().openRawResourceFd(R.raw.allarme_recupero);
            p.setDataSource(fd.getFileDescriptor(), fd.getStartOffset(), fd.getLength());
            fd.close();
            float g = limita(vol) * limita(vol);
            p.setVolume(g, g);
            p.prepare();
            if (offsetMs > 0) p.seekTo(offsetMs);
            p.start();
            return p;
        } catch (Exception e) {
            try { p.release(); } catch (Exception ignored) { }
            throw e;
        }
    }

    private void suona(int offsetMs) {
        fermaSuono();
        try {
            am = (AudioManager) getSystemService(AUDIO_SERVICE);
            if (am != null) {
                if (Build.VERSION.SDK_INT >= 26) {
                    afr = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                        .setAudioAttributes(attributiSveglia()).build();
                    am.requestAudioFocus(afr);
                } else {
                    am.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
                }
            }
            mp = avviaPlayer(this, volume, offsetMs);
            mp.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override public void onCompletion(MediaPlayer m) { fermaSuono(); }
            });
        } catch (Exception e) {
            fermaSuono();
        }
    }

    @SuppressWarnings("deprecation")
    private void fermaSuono() {
        if (mp != null) {
            try { mp.stop(); } catch (Exception ignored) { }
            try { mp.release(); } catch (Exception ignored) { }
            mp = null;
        }
        if (am != null) {
            if (Build.VERSION.SDK_INT >= 26 && afr != null) am.abandonAudioFocusRequest(afr);
            else am.abandonAudioFocus(null);
        }
        afr = null;
    }

    @SuppressWarnings("deprecation")
    private void vibra() {
        try {
            Vibrator v;
            if (Build.VERSION.SDK_INT >= 31) {
                VibratorManager vm = (VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE);
                v = vm != null ? vm.getDefaultVibrator() : null;
            } else {
                v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            }
            if (v == null) return;
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(VIBRA, -1));
            else v.vibrate(VIBRA, -1);
        } catch (Exception ignored) { }
    }

    // ─────────────── bolla sopra le altre app ───────────────
    private void aggiornaVisibilitaBolla() {
        boolean serve = attivo && !appVisibile && puoBolla(this);
        if (serve && bolla == null) creaBolla();
        else if (!serve && bolla != null) togliBolla();
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    @SuppressWarnings("deprecation")
    @SuppressLint("ClickableViewAccessibility")
    private void creaBolla() {
        try {
            wm = (WindowManager) getSystemService(WINDOW_SERVICE);
            if (wm == null) return;

            bolla = new LinearLayout(this);
            bolla.setOrientation(LinearLayout.HORIZONTAL);
            bolla.setGravity(Gravity.CENTER_VERTICAL);
            bolla.setPadding(dp(16), dp(8), dp(8), dp(8));
            if (Build.VERSION.SDK_INT >= 21) bolla.setElevation(dp(8));

            bollaTempo = new TextView(this);
            bollaTempo.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
            bollaTempo.setTypeface(Typeface.DEFAULT_BOLD);
            bolla.addView(bollaTempo);

            TextView x = new TextView(this);
            x.setText("✕");
            x.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
            x.setTypeface(Typeface.DEFAULT_BOLD);
            x.setPadding(dp(12), dp(4), dp(8), dp(4));
            x.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    TimerRecuperoPlugin.emetti("fermato");
                    chiudi();
                }
            });
            bolla.addView(x);

            int tipo = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
            lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                tipo, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.START;
            lp.x = dp(16);
            lp.y = dp(140);

            final int slop = ViewConfiguration.get(this).getScaledTouchSlop();
            bollaTempo.setOnTouchListener(new View.OnTouchListener() {
                int x0, y0; float rx, ry; boolean trascina;
                @Override public boolean onTouch(View v, MotionEvent e) {
                    switch (e.getAction()) {
                        case MotionEvent.ACTION_DOWN:
                            x0 = lp.x; y0 = lp.y; rx = e.getRawX(); ry = e.getRawY(); trascina = false;
                            return true;
                        case MotionEvent.ACTION_MOVE:
                            float dx = e.getRawX() - rx, dy = e.getRawY() - ry;
                            if (!trascina && (Math.abs(dx) > slop || Math.abs(dy) > slop)) trascina = true;
                            if (trascina && bolla != null) {
                                lp.x = x0 + (int) dx; lp.y = y0 + (int) dy;
                                try { wm.updateViewLayout(bolla, lp); } catch (Exception ignored) { }
                            }
                            return true;
                        case MotionEvent.ACTION_UP:
                            if (!trascina) apriApp();
                            return true;
                    }
                    return false;
                }
            });

            wm.addView(bolla, lp);
            aggiornaBolla();
        } catch (Exception e) {
            bolla = null;
        }
    }

    private void aggiornaBolla() {
        if (bolla == null || bollaTempo == null) return;
        int sfondo = scaduto ? Color.parseColor("#D85046") : colore;
        int inchiostro = scaduto ? Color.WHITE : coloreTesto;
        GradientDrawable g = new GradientDrawable();
        g.setColor(sfondo);
        g.setCornerRadius(dp(28));
        bolla.setBackground(g);
        long rem = Math.max(0, (long) Math.ceil((fine - System.currentTimeMillis()) / 1000.0));
        bollaTempo.setText(scaduto ? "Fine!" : (rem / 60) + ":" + String.format(java.util.Locale.ROOT, "%02d", rem % 60));
        bollaTempo.setTextColor(inchiostro);
        View x = bolla.getChildAt(1);
        if (x instanceof TextView) ((TextView) x).setTextColor(inchiostro);
    }

    private void togliBolla() {
        if (bolla != null && wm != null) {
            try { wm.removeView(bolla); } catch (Exception ignored) { }
        }
        bolla = null;
        bollaTempo = null;
    }

    private void apriApp() {
        try {
            Intent li = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (li == null) return;
            li.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            startActivity(li);
        } catch (Exception ignored) { }
    }

    // ─────────────── utilità ───────────────
    private static String testoOr(String s, String d) {
        return (s == null || s.trim().isEmpty()) ? d : s;
    }

    private static int coloreOr(String s, int d) {
        try { return (s == null || s.isEmpty()) ? d : Color.parseColor(s.trim()); }
        catch (Exception e) { return d; }
    }
}
