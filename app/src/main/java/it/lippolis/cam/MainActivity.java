package it.lippolis.cam;

import android.Manifest;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Range;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraInfo;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.DynamicRange;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.core.ZoomState;
import androidx.camera.core.resolutionselector.AspectRatioStrategy;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.video.FallbackStrategy;
import androidx.camera.video.MediaStoreOutputOptions;
import androidx.camera.video.PendingRecording;
import androidx.camera.video.Quality;
import androidx.camera.video.QualitySelector;
import androidx.camera.video.Recorder;
import androidx.camera.video.Recording;
import androidx.camera.video.VideoCapture;
import androidx.camera.video.VideoRecordEvent;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LiveData;

import com.google.common.util.concurrent.ListenableFuture;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lippolis Cam - registra video SENZA chiedere l'audio focus ad Android,
 * cosi' Spotify (o altra musica) continua a suonare durante la registrazione.
 */
public class MainActivity extends ComponentActivity {

    private static final String FOLDER = "Movies/Lippolis Cam";

    private PreviewView previewView;
    private ImageButton btnFlash, btnSwitch;
    private TextView txtRes, txtFps, txtTimer;
    private LinearLayout zoomBar, topRight;
    private View btnRecord;
    private ImageView thumb;

    private ProcessCameraProvider provider;
    private Camera camera;
    private LiveData<ZoomState> zoomLive;
    private VideoCapture<Recorder> videoCapture;
    private Recording recording;

    private int lensFacing = CameraSelector.LENS_FACING_BACK;
    private Quality quality = Quality.FHD;
    private int fps = 30;
    private boolean torch = false;
    private final List<Quality> qualities = new ArrayList<>();
    private final List<Integer> fpsOptions = new ArrayList<>();
    private final List<Float> zoomStops = new ArrayList<>();
    private Uri lastUri;
    private boolean pinching = false;

    private final ExecutorService bg = Executors.newSingleThreadExecutor();

    private final ActivityResultLauncher<String[]> permLauncher = registerForActivityResult(
            new ActivityResultContracts.RequestMultiplePermissions(), res -> {
                if (has(Manifest.permission.CAMERA)) startCamera();
                else toast("Senza il permesso della fotocamera l'app non puo' funzionare");
                if (!has(Manifest.permission.RECORD_AUDIO)) toast("Microfono negato: i video saranno muti");
            });

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        setContentView(R.layout.activity_main);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        previewView = findViewById(R.id.preview);
        btnFlash = findViewById(R.id.btnFlash);
        btnSwitch = findViewById(R.id.btnSwitch);
        txtRes = findViewById(R.id.txtRes);
        txtFps = findViewById(R.id.txtFps);
        txtTimer = findViewById(R.id.txtTimer);
        zoomBar = findViewById(R.id.zoomBar);
        topRight = findViewById(R.id.topRight);
        btnRecord = findViewById(R.id.btnRecord);
        thumb = findViewById(R.id.thumb);
        thumb.setClipToOutline(true);

        previewView.setScaleType(PreviewView.ScaleType.FIT_CENTER);

        btnRecord.setOnClickListener(v -> toggleRecord());
        btnSwitch.setOnClickListener(v -> {
            if (recording != null) return;
            lensFacing = lensFacing == CameraSelector.LENS_FACING_BACK
                    ? CameraSelector.LENS_FACING_FRONT : CameraSelector.LENS_FACING_BACK;
            bindCamera(1f);
        });
        btnFlash.setOnClickListener(v -> {
            if (camera == null) return;
            torch = !torch;
            camera.getCameraControl().enableTorch(torch);
            btnFlash.setImageResource(torch ? R.drawable.ic_flash_on : R.drawable.ic_flash_off);
        });
        txtRes.setOnClickListener(v -> {
            if (recording != null || qualities.size() < 2) return;
            quality = qualities.get((qualities.indexOf(quality) + 1) % qualities.size());
            bindCamera(currentZoom());
        });
        txtFps.setOnClickListener(v -> {
            if (recording != null || fpsOptions.size() < 2) return;
            fps = fpsOptions.get((fpsOptions.indexOf(fps) + 1) % fpsOptions.size());
            bindCamera(currentZoom());
        });
        thumb.setOnClickListener(v -> openLastVideo());

        ScaleGestureDetector scale = new ScaleGestureDetector(this,
                new ScaleGestureDetector.SimpleOnScaleGestureListener() {
                    @Override
                    public boolean onScaleBegin(ScaleGestureDetector d) {
                        pinching = true;
                        return true;
                    }

                    @Override
                    public boolean onScale(ScaleGestureDetector d) {
                        if (camera == null || zoomLive == null || zoomLive.getValue() == null) return true;
                        ZoomState z = zoomLive.getValue();
                        float r = z.getZoomRatio() * d.getScaleFactor();
                        r = Math.max(z.getMinZoomRatio(), Math.min(z.getMaxZoomRatio(), r));
                        camera.getCameraControl().setZoomRatio(r);
                        return true;
                    }
                });
        previewView.setOnTouchListener((v, e) -> {
            scale.onTouchEvent(e);
            if (e.getActionMasked() == MotionEvent.ACTION_DOWN) pinching = false;
            if (e.getActionMasked() == MotionEvent.ACTION_UP && !pinching) {
                focusAt(e.getX(), e.getY());
                v.performClick();
            }
            return true;
        });

        loadLastVideo();

        if (has(Manifest.permission.CAMERA)) startCamera();
        if (!has(Manifest.permission.CAMERA) || !has(Manifest.permission.RECORD_AUDIO)) {
            permLauncher.launch(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO});
        }
    }

    private boolean has(String p) {
        return ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED;
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }

    // ---------------------------------------------------------------- fotocamera

    private void startCamera() {
        if (provider != null) return;
        ListenableFuture<ProcessCameraProvider> f = ProcessCameraProvider.getInstance(this);
        f.addListener(() -> {
            try {
                provider = f.get();
                bindCamera(1f);
            } catch (Exception e) {
                toast("Errore fotocamera: " + e.getMessage());
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private float currentZoom() {
        return (zoomLive != null && zoomLive.getValue() != null) ? zoomLive.getValue().getZoomRatio() : 1f;
    }

    private void bindCamera(float keepZoom) {
        if (provider == null) return;
        provider.unbindAll();
        if (zoomLive != null) zoomLive.removeObservers(this);
        camera = null;

        CameraSelector selector = new CameraSelector.Builder().requireLensFacing(lensFacing).build();
        CameraInfo info;
        try {
            info = provider.getCameraInfo(selector);
        } catch (Exception e) {
            toast("Fotocamera non disponibile");
            return;
        }

        // Risoluzioni realmente supportate
        qualities.clear();
        List<Quality> sup = Recorder.getVideoCapabilities(info).getSupportedQualities(DynamicRange.SDR);
        for (Quality q : new Quality[]{Quality.HD, Quality.FHD, Quality.UHD}) {
            if (sup.contains(q)) qualities.add(q);
        }
        if (qualities.isEmpty()) qualities.add(Quality.FHD);
        if (!qualities.contains(quality)) {
            quality = qualities.contains(Quality.FHD) ? Quality.FHD : qualities.get(0);
        }

        // fps realmente supportati
        fpsOptions.clear();
        fpsOptions.add(30);
        for (Range<Integer> r : info.getSupportedFrameRateRanges()) {
            if (r.getUpper() >= 60) { fpsOptions.add(60); break; }
        }
        if (!fpsOptions.contains(fps)) fps = 30;

        if (!tryBind(selector) && fps != 30) {
            fps = 30;
            toast("60 fps non disponibili con questa risoluzione: uso 30");
            tryBind(selector);
        }
        if (camera == null) {
            toast("Impossibile avviare la fotocamera");
            return;
        }

        if (camera.getCameraInfo().hasFlashUnit()) {
            btnFlash.setVisibility(View.VISIBLE);
            camera.getCameraControl().enableTorch(torch);
        } else {
            torch = false;
            btnFlash.setVisibility(View.INVISIBLE);
        }
        btnFlash.setImageResource(torch ? R.drawable.ic_flash_on : R.drawable.ic_flash_off);

        zoomLive = camera.getCameraInfo().getZoomState();
        buildZoomBar();
        zoomLive.observe(this, this::onZoomChanged);
        if (keepZoom != 1f) camera.getCameraControl().setZoomRatio(keepZoom);

        updateTopBar();
    }

    private boolean tryBind(CameraSelector selector) {
        try {
            ResolutionSelector rs = new ResolutionSelector.Builder()
                    .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
                    .build();
            Preview preview = new Preview.Builder().setResolutionSelector(rs).build();
            preview.setSurfaceProvider(previewView.getSurfaceProvider());

            Recorder recorder = new Recorder.Builder()
                    .setQualitySelector(QualitySelector.from(quality,
                            FallbackStrategy.lowerQualityOrHigherThan(quality)))
                    .build();
            videoCapture = new VideoCapture.Builder<>(recorder)
                    .setTargetFrameRate(new Range<>(fps, fps))
                    .build();

            camera = provider.bindToLifecycle(this, selector, preview, videoCapture);
            return true;
        } catch (Exception e) {
            provider.unbindAll();
            camera = null;
            return false;
        }
    }

    private void focusAt(float x, float y) {
        if (camera == null) return;
        MeteringPoint p = previewView.getMeteringPointFactory().createPoint(x, y);
        camera.getCameraControl().startFocusAndMetering(new FocusMeteringAction.Builder(p).build());
    }

    // ---------------------------------------------------------------- barra in alto

    private static String qualityLabel(Quality q) {
        if (q == Quality.HD) return "720";
        if (q == Quality.UHD) return "4K";
        return "1080";
    }

    private void updateTopBar() {
        txtRes.setText(qualityLabel(quality));
        txtRes.setAlpha(qualities.size() > 1 ? 1f : 0.5f);
        txtFps.setText(String.valueOf(fps));
        txtFps.setAlpha(fpsOptions.size() > 1 ? 1f : 0.5f);
    }

    // ---------------------------------------------------------------- zoom

    private static String fmt(float v) {
        if (Math.abs(v - Math.round(v)) < 0.05f) return String.valueOf(Math.round(v));
        return String.format(Locale.US, "%.1f", v);
    }

    private void buildZoomBar() {
        zoomBar.removeAllViews();
        zoomStops.clear();
        ZoomState z = zoomLive.getValue();
        float min = z == null ? 1f : z.getMinZoomRatio();
        float max = z == null ? 1f : z.getMaxZoomRatio();

        if (min < 0.95f) zoomStops.add(min <= 0.6f ? 0.6f : min);
        zoomStops.add(1f);
        if (max >= 2f) zoomStops.add(2f);
        if (max >= 5f) zoomStops.add(5f);

        int size = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 48,
                getResources().getDisplayMetrics());
        for (float stop : zoomStops) {
            TextView t = new TextView(this);
            t.setLayoutParams(new LinearLayout.LayoutParams(size, size));
            t.setGravity(Gravity.CENTER);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            t.setTypeface(Typeface.DEFAULT_BOLD);
            t.setTextColor(0xFFFFFFFF);
            t.setText(fmt(stop));
            t.setOnClickListener(v -> {
                if (camera != null) camera.getCameraControl().setZoomRatio(stop);
            });
            zoomBar.addView(t);
        }
        zoomBar.setVisibility(zoomStops.size() > 1 ? View.VISIBLE : View.INVISIBLE);
    }

    private void onZoomChanged(ZoomState z) {
        if (z == null) return;
        float r = z.getZoomRatio();
        int sel = 0;
        for (int i = 0; i < zoomStops.size(); i++) {
            if (r >= zoomStops.get(i) - 0.05f) sel = i;
        }
        for (int i = 0; i < zoomBar.getChildCount(); i++) {
            TextView t = (TextView) zoomBar.getChildAt(i);
            if (i == sel) {
                t.setText(fmt(r) + "×");
                t.setTextColor(ContextCompat.getColor(this, R.color.accent));
                t.setBackgroundResource(R.drawable.bg_pill_sel);
            } else {
                t.setText(fmt(zoomStops.get(i)));
                t.setTextColor(0xFFFFFFFF);
                t.setBackground(null);
            }
        }
    }

    // ---------------------------------------------------------------- registrazione

    private void toggleRecord() {
        if (videoCapture == null) return;
        if (recording != null) {
            recording.stop();
            recording = null;
            return;
        }

        String name = "LPCAM_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        cv.put(MediaStore.MediaColumns.MIME_TYPE, "video/mp4");
        cv.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
        MediaStoreOutputOptions opts = new MediaStoreOutputOptions.Builder(
                getContentResolver(), MediaStore.Video.Media.EXTERNAL_CONTENT_URI)
                .setContentValues(cv)
                .build();

        PendingRecording pr = videoCapture.getOutput().prepareRecording(this, opts);
        // Il microfono si registra con AudioRecord: nessuna richiesta di audio focus,
        // quindi la musica degli altri player NON viene messa in pausa.
        if (has(Manifest.permission.RECORD_AUDIO)) pr = pr.withAudioEnabled();
        recording = pr.start(ContextCompat.getMainExecutor(this), this::onRecordEvent);
        setRecordingUi(true);
    }

    private void onRecordEvent(VideoRecordEvent e) {
        if (e instanceof VideoRecordEvent.Status) {
            long s = e.getRecordingStats().getRecordedDurationNanos() / 1_000_000_000L;
            txtTimer.setText(String.format(Locale.US, "%02d:%02d", s / 60, s % 60));
        } else if (e instanceof VideoRecordEvent.Finalize) {
            VideoRecordEvent.Finalize f = (VideoRecordEvent.Finalize) e;
            recording = null;
            setRecordingUi(false);
            Uri u = f.getOutputResults().getOutputUri();
            if (!Uri.EMPTY.equals(u)) {
                lastUri = u;
                loadThumb(u);
            } else if (f.hasError()) {
                toast("Video non salvato (errore " + f.getError() + ")");
            }
        }
    }

    private void setRecordingUi(boolean rec) {
        btnRecord.setBackgroundResource(rec ? R.drawable.rec_active : R.drawable.rec_idle);
        txtTimer.setText("00:00");
        txtTimer.setVisibility(rec ? View.VISIBLE : View.GONE);
        topRight.setVisibility(rec ? View.INVISIBLE : View.VISIBLE);
        btnSwitch.setAlpha(rec ? 0.3f : 1f);
        thumb.setAlpha(rec ? 0.3f : 1f);
    }

    @Override
    protected void onStop() {
        if (recording != null) {
            recording.stop();
            recording = null;
        }
        super.onStop();
    }

    // ---------------------------------------------------------------- galleria

    private void loadLastVideo() {
        bg.execute(() -> {
            String[] proj = {MediaStore.Video.Media._ID};
            String sel = MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?";
            String[] args = {FOLDER + "%"};
            try (Cursor c = getContentResolver().query(MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                    proj, sel, args, MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
                if (c != null && c.moveToFirst()) {
                    Uri u = ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, c.getLong(0));
                    runOnUiThread(() -> {
                        if (lastUri == null) lastUri = u;
                    });
                    loadThumbNow(u);
                }
            } catch (Exception ignored) {
            }
        });
    }

    private void loadThumb(Uri u) {
        bg.execute(() -> loadThumbNow(u));
    }

    private void loadThumbNow(Uri u) {
        try {
            Bitmap bmp = getContentResolver().loadThumbnail(u, new Size(256, 256), null);
            runOnUiThread(() -> thumb.setImageBitmap(bmp));
        } catch (Exception ignored) {
        }
    }

    private void openLastVideo() {
        if (lastUri == null || recording != null) return;
        try {
            Intent i = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(lastUri, "video/mp4")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(i);
        } catch (Exception e) {
            toast("Nessuna app per aprire il video");
        }
    }

    @Override
    protected void onDestroy() {
        bg.shutdown();
        super.onDestroy();
    }
}
