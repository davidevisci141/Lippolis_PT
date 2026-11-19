package it.lippolis.cam;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.graphics.Bitmap;
import android.graphics.SurfaceTexture;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLExt;
import android.opengl.EGLSurface;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.opengl.Matrix;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.util.Size;
import android.view.Surface;

import androidx.camera.core.CameraEffect;
import androidx.camera.core.SurfaceOutput;
import androidx.camera.core.SurfaceProcessor;
import androidx.camera.core.SurfaceRequest;


import org.tensorflow.lite.Interpreter;
import org.tensorflow.lite.gpu.GpuDelegate;

import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Effetto bokeh in tempo reale per anteprima e video.
 * 1) il fotogramma viene ridotto (lato lungo 320 px) e raddrizzato;
 * 2) MiDaS stima la profondita' di ogni punto (vale per persone e oggetti);
 * 3) l'immagine ridotta viene sfocata;
 * 4) in uscita: nitido cio' che sta alla distanza del punto di fuoco, sfocato il resto.
 */
public class BokehProcessor implements SurfaceProcessor {

    private static final String TAG = "LippolisBokeh";
    private static final String MODEL = "depth.tflite";
    private static final int UP_LONG = 320;

    private final Context ctx;
    private final HandlerThread thread;
    private final Handler handler;
    final Executor executor;
    private final ExecutorService segExec = Executors.newSingleThreadExecutor();
    private final AtomicBoolean segBusy = new AtomicBoolean(false);
    private volatile Interpreter interp;
    private GpuDelegate gpu;
    private volatile boolean segmenterFailed = false;
    private volatile int modelW = 0, modelH = 0;
    private boolean nchw = false;
    private ByteBuffer modelIn, modelOut;
    private float[] depth;                       // profondita' normalizzata 0..1 (1 = vicino), smussata
    private volatile float focusX = 0.5f, focusY = 0.5f;
    private volatile float focusD = -1f;          // profondita' del punto a fuoco
    private volatile boolean locked = false;
    private volatile boolean debug = false;
    private float normMin = Float.NaN, normMax = Float.NaN;

    private volatile float amount = 0.5f;
    private int rotation = 90;
    private Size inSize = new Size(1920, 1080);

    private EGLDisplay dpy = EGL14.EGL_NO_DISPLAY;
    private EGLContext eglCtx = EGL14.EGL_NO_CONTEXT;
    private EGLConfig cfg;
    private EGLSurface pbuf = EGL14.EGL_NO_SURFACE;

    private int oesTex, maskTex;
    private SurfaceTexture surfaceTexture;
    private Surface inSurface;
    private final Map<SurfaceOutput, EGLSurface> outputs = new HashMap<>();

    private int progUp, progBlur, progFinal;
    private final int[] fbo = new int[3];      // 0,1 = sfocatura; 2 = ingresso del modello
    private final int[] fboTex = new int[3];
    private int upW = 0, upH = 0;

    private final float[] stM = new float[16];
    private final float[] outM = new float[16];
    private final float[] invSt = new float[16];
    private final float[] aM = new float[16];
    private float[] rM = new float[9];

    private FloatBuffer quad;
    private boolean released = false;

    private static final String VS =
            "attribute vec2 aPos; varying vec2 vUv;\n" +
            "void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }";

    private static final String FS_UP =
            "#extension GL_OES_EGL_image_external : require\n" +
            "precision mediump float; varying vec2 vUv;\n" +
            "uniform samplerExternalOES uTex; uniform mat4 uST; uniform mat3 uR;\n" +
            "void main(){ vec3 t = uR*vec3(vUv,1.0);\n" +
            "  gl_FragColor = texture2D(uTex,(uST*vec4(t.xy,0.0,1.0)).xy); }";

    private static final String FS_BLUR =
            "precision mediump float; varying vec2 vUv;\n" +
            "uniform sampler2D uTex; uniform vec2 uStep;\n" +
            "void main(){\n" +
            "  vec4 c = texture2D(uTex,vUv)*0.227027;\n" +
            "  c += texture2D(uTex,vUv+uStep*1.3846154)*0.3162162;\n" +
            "  c += texture2D(uTex,vUv-uStep*1.3846154)*0.3162162;\n" +
            "  c += texture2D(uTex,vUv+uStep*3.2307692)*0.0702703;\n" +
            "  c += texture2D(uTex,vUv-uStep*3.2307692)*0.0702703;\n" +
            "  gl_FragColor = c; }";

    private static final String FS_FINAL =
            "#extension GL_OES_EGL_image_external : require\n" +
            "precision highp float; varying vec2 vUv;\n" +
            "uniform samplerExternalOES uTex; uniform sampler2D uBlur; uniform sampler2D uMask;\n" +
            "uniform mat4 uOut; uniform mat4 uA; uniform mat3 uR; uniform float uAmt; uniform float uFocus; uniform float uDebug;\n" +
            "void main(){\n" +
            "  vec4 sharp = texture2D(uTex,(uOut*vec4(vUv,0.0,1.0)).xy);\n" +
            "  vec2 t = (uA*vec4(vUv,0.0,1.0)).xy;\n" +
            "  vec2 m = (uR*vec3(t,1.0)).xy;\n" +
            "  float d = texture2D(uMask,m).r;\n" +
            "  float k = smoothstep(0.10,0.30,abs(d-uFocus));\n" +
            "  float bg = k*uAmt;\n" +
            "  vec3 b = texture2D(uBlur,m).rgb;\n" +
            "  vec3 c = mix(sharp.rgb,b,bg);\n" +
            "  if (uDebug > 0.5) { c = vec3(d); if (k < 0.5) c = mix(c, vec3(1.0,0.2,0.2), 0.6); }\n" +
            "  gl_FragColor = vec4(c,1.0); }";

    public BokehProcessor(Context c) {
        ctx = c.getApplicationContext();
        thread = new HandlerThread("bokeh-gl");
        thread.start();
        handler = new Handler(thread.getLooper());
        executor = handler::post;
        handler.post(this::initGl);
        segExec.execute(this::initSegmenter);
    }

    // ------------------------------------------------------------ API

    public void setAmount(float a) {
        amount = Math.max(0f, Math.min(1f, a));
    }

    public void setRotation(int deg) {
        handler.post(() -> {
            rotation = ((deg % 360) + 360) % 360;
            rM = rotMatrix(rotation);
            resizeUp();
        });
    }

    /** Punto di fuoco in coordinate dell'immagine diritta (0..1, y=0 in alto). */
    public void setFocusPoint(float x, float y) {
        focusX = Math.max(0f, Math.min(1f, x));
        focusY = Math.max(0f, Math.min(1f, y));
        float[] d = depth;
        if (d != null) focusD = sampleDepth(d, focusX, focusY);
    }

    public void setDebug(boolean d) {
        debug = d;
    }

    public boolean isDebug() {
        return debug;
    }

    public void setLocked(boolean l) {
        locked = l;
    }

    public boolean segmenterFailed() {
        return segmenterFailed;
    }

    public CameraEffect createEffect() {
        return new CameraEffect(CameraEffect.PREVIEW | CameraEffect.VIDEO_CAPTURE, executor, this,
                t -> Log.e(TAG, "errore effetto", t)) {
        };
    }

    public void release() {
        handler.post(() -> {
            released = true;
            for (EGLSurface s : outputs.values()) EGL14.eglDestroySurface(dpy, s);
            outputs.clear();
            if (surfaceTexture != null) surfaceTexture.release();
            if (inSurface != null) inSurface.release();
            if (dpy != EGL14.EGL_NO_DISPLAY) {
                EGL14.eglMakeCurrent(dpy, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
                EGL14.eglDestroySurface(dpy, pbuf);
                EGL14.eglDestroyContext(dpy, eglCtx);
                EGL14.eglTerminate(dpy);
            }
            thread.quitSafely();
        });
        segExec.execute(() -> {
            if (interp != null) interp.close();
            if (gpu != null) gpu.close();
        });
        segExec.shutdown();
    }

    // ------------------------------------------------------------ SurfaceProcessor

    @Override
    public void onInputSurface(SurfaceRequest request) {
        if (released) {
            request.willNotProvideSurface();
            return;
        }
        inSize = request.getResolution();
        SurfaceTexture st = new SurfaceTexture(oesTex);
        st.setDefaultBufferSize(inSize.getWidth(), inSize.getHeight());
        Surface s = new Surface(st);
        st.setOnFrameAvailableListener(t -> drawFrame(), handler);
        surfaceTexture = st;
        inSurface = s;
        resizeUp();
        request.provideSurface(s, executor, result -> {
            st.setOnFrameAvailableListener(null);
            st.release();
            s.release();
            if (surfaceTexture == st) {
                surfaceTexture = null;
                inSurface = null;
            }
        });
    }

    @Override
    public void onOutputSurface(SurfaceOutput out) {
        if (released) {
            out.close();
            return;
        }
        Surface s = out.getSurface(executor, event -> {
            EGLSurface es = outputs.remove(out);
            if (es != null) EGL14.eglDestroySurface(dpy, es);
            out.close();
        });
        EGLSurface es = EGL14.eglCreateWindowSurface(dpy, cfg, s, new int[]{EGL14.EGL_NONE}, 0);
        outputs.put(out, es);
    }

    // ------------------------------------------------------------ rendering

    private void drawFrame() {
        if (released || surfaceTexture == null) return;
        makeCurrent(pbuf);
        try {
            surfaceTexture.updateTexImage();
        } catch (Exception e) {
            return;
        }
        surfaceTexture.getTransformMatrix(stM);
        if (outputs.isEmpty() || upW == 0) return;

        // 1) immagine ridotta e raddrizzata
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo[0]);
        GLES20.glViewport(0, 0, upW, upH);
        GLES20.glUseProgram(progUp);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex);
        GLES20.glUniform1i(GLES20.glGetUniformLocation(progUp, "uTex"), 0);
        GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(progUp, "uST"), 1, false, stM, 0);
        GLES20.glUniformMatrix3fv(GLES20.glGetUniformLocation(progUp, "uR"), 1, false, rM, 0);
        drawQuad(progUp);

        // 2) profondita' (quando il modello e' libero): immagine diritta alla misura del modello
        if (interp != null && modelW > 0 && !segBusy.get()) {
            ensureModelFbo();
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo[2]);
            GLES20.glViewport(0, 0, modelW, modelH);
            drawQuad(progUp);
            ByteBuffer buf = ByteBuffer.allocateDirect(modelW * modelH * 4).order(ByteOrder.nativeOrder());
            GLES20.glReadPixels(0, 0, modelW, modelH, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, buf);
            segBusy.set(true);
            segExec.execute(() -> estimateDepth(buf));
        }

        // 3) sfocatura
        float a = amount;
        int passes = 1 + Math.round(a * 2f);
        float scale = 1f + a * 1.5f;
        GLES20.glUseProgram(progBlur);
        int uStep = GLES20.glGetUniformLocation(progBlur, "uStep");
        GLES20.glUniform1i(GLES20.glGetUniformLocation(progBlur, "uTex"), 0);
        for (int i = 0; i < passes; i++) {
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo[1]);
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fboTex[0]);
            GLES20.glUniform2f(uStep, scale / upW, 0f);
            drawQuad(progBlur);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo[0]);
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fboTex[1]);
            GLES20.glUniform2f(uStep, 0f, scale / upH);
            drawQuad(progBlur);
        }
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);

        // 4) composizione per ogni uscita (anteprima e video)
        Matrix.invertM(invSt, 0, stM, 0);
        long ts = surfaceTexture.getTimestamp();
        for (Map.Entry<SurfaceOutput, EGLSurface> e : outputs.entrySet()) {
            SurfaceOutput out = e.getKey();
            EGLSurface es = e.getValue();
            if (!EGL14.eglMakeCurrent(dpy, es, es, eglCtx)) continue;
            Size sz = out.getSize();
            GLES20.glViewport(0, 0, sz.getWidth(), sz.getHeight());
            out.updateTransformMatrix(outM, stM);
            Matrix.multiplyMM(aM, 0, invSt, 0, outM, 0);

            GLES20.glUseProgram(progFinal);
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex);
            GLES20.glActiveTexture(GLES20.GL_TEXTURE1);
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fboTex[0]);
            GLES20.glActiveTexture(GLES20.GL_TEXTURE2);
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, maskTex);
            GLES20.glUniform1i(GLES20.glGetUniformLocation(progFinal, "uTex"), 0);
            GLES20.glUniform1i(GLES20.glGetUniformLocation(progFinal, "uBlur"), 1);
            GLES20.glUniform1i(GLES20.glGetUniformLocation(progFinal, "uMask"), 2);
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(progFinal, "uOut"), 1, false, outM, 0);
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(progFinal, "uA"), 1, false, aM, 0);
            GLES20.glUniformMatrix3fv(GLES20.glGetUniformLocation(progFinal, "uR"), 1, false, rM, 0);
            float fd = focusD;
            GLES20.glUniform1f(GLES20.glGetUniformLocation(progFinal, "uAmt"), fd < 0f ? 0f : Math.min(1f, a * 1.5f));
            GLES20.glUniform1f(GLES20.glGetUniformLocation(progFinal, "uFocus"), Math.max(0f, fd));
            GLES20.glUniform1f(GLES20.glGetUniformLocation(progFinal, "uDebug"), debug ? 1f : 0f);
            drawQuad(progFinal);
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0);

            EGLExt.eglPresentationTimeANDROID(dpy, es, ts);
            EGL14.eglSwapBuffers(dpy, es);
        }
        makeCurrent(pbuf);
    }

    private void drawQuad(int prog) {
        int aPos = GLES20.glGetAttribLocation(prog, "aPos");
        GLES20.glEnableVertexAttribArray(aPos);
        quad.position(0);
        GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 0, quad);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(aPos);
    }

    /** Matrice (involutiva) fra coordinate dell'immagine raddrizzata (y=0 in alto) e della texture. */
    private static float[] rotMatrix(int r) {
        float a, b, c, d, e, f;
        switch (r) {
            case 90:  a = 0;  b = 1;  c = 0; d = 1;  e = 0;  f = 0; break;
            case 180: a = -1; b = 0;  c = 1; d = 0;  e = 1;  f = 0; break;
            case 270: a = 0;  b = -1; c = 1; d = -1; e = 0;  f = 1; break;
            default:  a = 1;  b = 0;  c = 0; d = 0;  e = -1; f = 1; break;
        }
        // righe [a b c] e [d e f], in colonne per OpenGL
        return new float[]{a, d, 0, b, e, 0, c, f, 1};
    }

    private void resizeUp() {
        if (dpy == EGL14.EGL_NO_DISPLAY) return;
        int w = inSize.getWidth(), h = inSize.getHeight();
        if (rotation == 90 || rotation == 270) { int t = w; w = h; h = t; }
        float k = (float) UP_LONG / Math.max(w, h);
        int nw = Math.max(16, Math.round(w * k)), nh = Math.max(16, Math.round(h * k));
        if (nw == upW && nh == upH) return;
        upW = nw;
        upH = nh;
        makeCurrent(pbuf);
        if (fboTex[0] != 0) {
            GLES20.glDeleteFramebuffers(2, fbo, 0);
            GLES20.glDeleteTextures(2, fboTex, 0);
            fbo[0] = fbo[1] = fboTex[0] = fboTex[1] = 0;
        }
        GLES20.glGenFramebuffers(2, fbo, 0);
        GLES20.glGenTextures(2, fboTex, 0);
        for (int i = 0; i < 2; i++) {
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fboTex[i]);
            setTexParams(GLES20.GL_TEXTURE_2D);
            GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, upW, upH, 0,
                    GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo[i]);
            GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0,
                    GLES20.GL_TEXTURE_2D, fboTex[i], 0);
        }
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
    }

    // ------------------------------------------------------------ profondita'

    private void ensureModelFbo() {
        if (fbo[2] != 0) return;
        int[] f = new int[1], t = new int[1];
        GLES20.glGenFramebuffers(1, f, 0);
        GLES20.glGenTextures(1, t, 0);
        fbo[2] = f[0];
        fboTex[2] = t[0];
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fboTex[2]);
        setTexParams(GLES20.GL_TEXTURE_2D);
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, modelW, modelH, 0,
                GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null);
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo[2]);
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0,
                GLES20.GL_TEXTURE_2D, fboTex[2], 0);
    }

    private MappedByteBuffer loadModel() throws Exception {
        AssetFileDescriptor fd = ctx.getAssets().openFd(MODEL);
        try (FileInputStream in = new FileInputStream(fd.getFileDescriptor())) {
            return in.getChannel().map(FileChannel.MapMode.READ_ONLY, fd.getStartOffset(), fd.getDeclaredLength());
        }
    }

    private void initSegmenter() {
        try {
            MappedByteBuffer model = loadModel();
            Interpreter it = null;
            try {
                gpu = new GpuDelegate();
                it = new Interpreter(model, new Interpreter.Options().addDelegate(gpu));
            } catch (Throwable t) {
                Log.w(TAG, "GPU non disponibile, uso la CPU", t);
                if (gpu != null) { gpu.close(); gpu = null; }
                it = new Interpreter(model, new Interpreter.Options().setNumThreads(4));
            }
            int[] in = it.getInputTensor(0).shape();     // [1,H,W,3] oppure [1,3,H,W]
            nchw = in.length == 4 && in[1] == 3 && in[3] != 3;
            int h = nchw ? in[2] : in[1];
            int w = nchw ? in[3] : in[2];
            modelIn = ByteBuffer.allocateDirect(w * h * 3 * 4).order(ByteOrder.nativeOrder());
            modelOut = ByteBuffer.allocateDirect(it.getOutputTensor(0).numBytes()).order(ByteOrder.nativeOrder());
            modelH = h;
            modelW = w;
            interp = it;
        } catch (Throwable t) {
            Log.e(TAG, "modello profondita'", t);
            segmenterFailed = true;
        }
    }

    private void estimateDepth(ByteBuffer rgba) {
        try {
            Interpreter it = interp;
            if (it == null) return;
            int w = modelW, h = modelH, n = w * h;
            final float[] mean = {0.485f, 0.456f, 0.406f}, std = {0.229f, 0.224f, 0.225f};
            modelIn.rewind();
            rgba.rewind();
            if (!nchw) {
                for (int i = 0; i < n; i++) {
                    for (int c = 0; c < 3; c++) {
                        float v = (rgba.get(i * 4 + c) & 0xFF) / 255f;
                        modelIn.putFloat((v - mean[c]) / std[c]);
                    }
                }
            } else {
                for (int c = 0; c < 3; c++) {
                    for (int i = 0; i < n; i++) {
                        float v = (rgba.get(i * 4 + c) & 0xFF) / 255f;
                        modelIn.putFloat((v - mean[c]) / std[c]);
                    }
                }
            }
            modelIn.rewind();
            modelOut.rewind();
            it.run(modelIn, modelOut);
            modelOut.rewind();
            FloatBuffer o = modelOut.asFloatBuffer();
            int m = Math.min(n, o.remaining());

            // normalizzo 0..1 (1 = vicino) con i percentili 2-98, stabilizzati nel tempo
            float[] raw = new float[n];
            for (int i = 0; i < m; i++) raw[i] = o.get(i);
            float[] sample = new float[Math.min(n, 2048)];
            int stepS = Math.max(1, n / sample.length);
            for (int i = 0; i < sample.length; i++) sample[i] = raw[Math.min(n - 1, i * stepS)];
            java.util.Arrays.sort(sample);
            float lo = sample[(int) (sample.length * 0.02f)];
            float hi = sample[(int) (sample.length * 0.98f)];
            if (Float.isNaN(normMin)) { normMin = lo; normMax = hi; }
            else { normMin = normMin * 0.85f + lo * 0.15f; normMax = normMax * 0.85f + hi * 0.15f; }
            float mn = normMin;
            // scena quasi piatta (es. una parete): non esagero differenze minime
            float range = Math.max(Math.max(1e-6f, normMax - normMin), Math.abs(normMax) * 0.35f);
            float[] prev = depth;
            boolean blend = prev != null && prev.length == n;
            float[] d = new float[n];
            ByteBuffer out = ByteBuffer.allocateDirect(n);
            for (int i = 0; i < n; i++) {
                float v = (raw[i] - mn) / range;
                v = Math.max(0f, Math.min(1f, v));
                if (blend) v = v * 0.5f + prev[i] * 0.5f;   // meno sfarfallio
                d[i] = v;
                out.put((byte) Math.max(0, Math.min(255, (int) (v * 255f))));
            }
            out.rewind();
            depth = d;
            if (!locked || focusD < 0f) focusD = sampleDepth(d, focusX, focusY);
            handler.post(() -> uploadMask(out, w, h));
        } catch (Throwable t) {
            Log.e(TAG, "profondita'", t);
        } finally {
            segBusy.set(false);
        }
    }

    /** Media della profondita' in una finestra 7x7 attorno al punto. */
    private float sampleDepth(float[] d, float x, float y) {
        int w = modelW, h = modelH;
        if (w == 0 || d.length < w * h) return -1f;
        int cx = Math.round(x * (w - 1)), cy = Math.round(y * (h - 1));
        float sum = 0f;
        int cnt = 0;
        for (int j = -3; j <= 3; j++) {
            for (int i = -3; i <= 3; i++) {
                int px = Math.max(0, Math.min(w - 1, cx + i));
                int py = Math.max(0, Math.min(h - 1, cy + j));
                sum += d[py * w + px];
                cnt++;
            }
        }
        return sum / cnt;
    }

    private void uploadMask(ByteBuffer b, int w, int h) {
        if (released) return;
        makeCurrent(pbuf);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, maskTex);
        GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1);
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_LUMINANCE, w, h, 0,
                GLES20.GL_LUMINANCE, GLES20.GL_UNSIGNED_BYTE, b);
    }

    // ------------------------------------------------------------ EGL / GL

    private void initGl() {
        dpy = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        int[] ver = new int[2];
        EGL14.eglInitialize(dpy, ver, 0, ver, 1);
        int[] attr = {
                EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
                EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                0x3142 /* EGL_RECORDABLE_ANDROID */, 1,
                EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT | EGL14.EGL_PBUFFER_BIT,
                EGL14.EGL_NONE};
        EGLConfig[] cs = new EGLConfig[1];
        int[] n = new int[1];
        EGL14.eglChooseConfig(dpy, attr, 0, cs, 0, 1, n, 0);
        cfg = cs[0];
        eglCtx = EGL14.eglCreateContext(dpy, cfg, EGL14.EGL_NO_CONTEXT,
                new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE}, 0);
        pbuf = EGL14.eglCreatePbufferSurface(dpy, cfg,
                new int[]{EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE}, 0);
        makeCurrent(pbuf);

        quad = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        quad.put(new float[]{-1, -1, 1, -1, -1, 1, 1, 1}).position(0);

        progUp = program(VS, FS_UP);
        progBlur = program(VS, FS_BLUR);
        progFinal = program(VS, FS_FINAL);

        int[] t = new int[2];
        GLES20.glGenTextures(2, t, 0);
        oesTex = t[0];
        maskTex = t[1];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex);
        setTexParams(GLES11Ext.GL_TEXTURE_EXTERNAL_OES);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, maskTex);
        setTexParams(GLES20.GL_TEXTURE_2D);
        ByteBuffer white = ByteBuffer.allocateDirect(1);
        white.put((byte) 255).rewind();
        GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1);
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_LUMINANCE, 1, 1, 0,
                GLES20.GL_LUMINANCE, GLES20.GL_UNSIGNED_BYTE, white);

        rM = rotMatrix(rotation);
    }

    private static void setTexParams(int target) {
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
    }

    private void makeCurrent(EGLSurface s) {
        EGL14.eglMakeCurrent(dpy, s, s, eglCtx);
    }

    private static int shader(int type, String src) {
        int s = GLES20.glCreateShader(type);
        GLES20.glShaderSource(s, src);
        GLES20.glCompileShader(s);
        int[] ok = new int[1];
        GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0);
        if (ok[0] == 0) Log.e(TAG, "shader: " + GLES20.glGetShaderInfoLog(s));
        return s;
    }

    private static int program(String vs, String fs) {
        int p = GLES20.glCreateProgram();
        GLES20.glAttachShader(p, shader(GLES20.GL_VERTEX_SHADER, vs));
        GLES20.glAttachShader(p, shader(GLES20.GL_FRAGMENT_SHADER, fs));
        GLES20.glLinkProgram(p);
        int[] ok = new int[1];
        GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0);
        if (ok[0] == 0) Log.e(TAG, "link: " + GLES20.glGetProgramInfoLog(p));
        return p;
    }
}
