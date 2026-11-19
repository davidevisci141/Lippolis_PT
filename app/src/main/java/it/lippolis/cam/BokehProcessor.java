package it.lippolis.cam;

import android.content.Context;
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

import com.google.mediapipe.framework.image.BitmapImageBuilder;
import com.google.mediapipe.framework.image.ByteBufferExtractor;
import com.google.mediapipe.framework.image.MPImage;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.core.Delegate;
import com.google.mediapipe.tasks.vision.core.RunningMode;
import com.google.mediapipe.tasks.vision.imagesegmenter.ImageSegmenter;
import com.google.mediapipe.tasks.vision.imagesegmenter.ImageSegmenterResult;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Effetto bokeh in tempo reale per anteprima e video.
 * 1) il fotogramma viene ridotto (lato lungo 320 px) e raddrizzato;
 * 2) MediaPipe (selfie multiclass) stima dove c'e' la persona;
 * 3) l'immagine ridotta viene sfocata;
 * 4) in uscita: persona nitida + sfondo sfocato, in proporzione all'intensita'.
 */
public class BokehProcessor implements SurfaceProcessor {

    private static final String TAG = "LippolisBokeh";
    private static final String MODEL = "selfie_multiclass_256x256.tflite";
    private static final int UP_LONG = 320;

    private final Context ctx;
    private final HandlerThread thread;
    private final Handler handler;
    final Executor executor;
    private final ExecutorService segExec = Executors.newSingleThreadExecutor();
    private final AtomicBoolean segBusy = new AtomicBoolean(false);
    private volatile ImageSegmenter segmenter;
    private volatile boolean segmenterFailed = false;

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
    private final int[] fbo = new int[2];
    private final int[] fboTex = new int[2];
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
            "uniform mat4 uOut; uniform mat4 uA; uniform mat3 uR; uniform float uAmt;\n" +
            "void main(){\n" +
            "  vec4 sharp = texture2D(uTex,(uOut*vec4(vUv,0.0,1.0)).xy);\n" +
            "  vec2 t = (uA*vec4(vUv,0.0,1.0)).xy;\n" +
            "  vec2 m = (uR*vec3(t,1.0)).xy;\n" +
            "  float p = texture2D(uMask,m).r;\n" +
            "  float bg = (1.0 - smoothstep(0.3,0.7,p))*uAmt;\n" +
            "  vec3 b = texture2D(uBlur,m).rgb;\n" +
            "  gl_FragColor = vec4(mix(sharp.rgb,b,bg),1.0); }";

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
            if (segmenter != null) segmenter.close();
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

        // 2) segmentazione (quando il modello e' libero)
        if (segmenter != null && !segBusy.get()) {
            ByteBuffer buf = ByteBuffer.allocateDirect(upW * upH * 4).order(ByteOrder.nativeOrder());
            GLES20.glReadPixels(0, 0, upW, upH, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, buf);
            segBusy.set(true);
            final int w = upW, h = upH;
            segExec.execute(() -> segment(buf, w, h));
        }

        // 3) sfocatura
        float a = amount;
        int passes = 1 + Math.round(a * 3f);
        float scale = 1f + a * 2f;
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
            GLES20.glUniform1f(GLES20.glGetUniformLocation(progFinal, "uAmt"), Math.min(1f, a * 1.5f));
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

    // ------------------------------------------------------------ segmentazione

    private void initSegmenter() {
        ImageSegmenter s = createSegmenter(Delegate.GPU);
        if (s == null) s = createSegmenter(Delegate.CPU);
        if (s == null) segmenterFailed = true;
        segmenter = s;
    }

    private ImageSegmenter createSegmenter(Delegate d) {
        try {
            BaseOptions bo = BaseOptions.builder().setModelAssetPath(MODEL).setDelegate(d).build();
            ImageSegmenter.ImageSegmenterOptions o = ImageSegmenter.ImageSegmenterOptions.builder()
                    .setBaseOptions(bo)
                    .setRunningMode(RunningMode.IMAGE)
                    .setOutputConfidenceMasks(true)
                    .setOutputCategoryMask(false)
                    .build();
            return ImageSegmenter.createFromOptions(ctx, o);
        } catch (Throwable t) {
            Log.e(TAG, "segmenter " + d, t);
            return null;
        }
    }

    private void segment(ByteBuffer buf, int w, int h) {
        try {
            ImageSegmenter s = segmenter;
            if (s == null) return;
            Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            buf.rewind();
            bmp.copyPixelsFromBuffer(buf);
            MPImage img = new BitmapImageBuilder(bmp).build();
            ImageSegmenterResult r = s.segment(img);
            if (!r.confidenceMasks().isPresent()) return;
            List<MPImage> masks = r.confidenceMasks().get();
            if (masks.isEmpty()) return;
            // categoria 0 = sfondo: persona = 1 - sfondo
            MPImage m = masks.get(0);
            int mw = m.getWidth(), mh = m.getHeight();
            FloatBuffer f = ByteBufferExtractor.extract(m).duplicate()
                    .order(ByteOrder.nativeOrder()).asFloatBuffer();
            ByteBuffer out = ByteBuffer.allocateDirect(mw * mh);
            int n = Math.min(mw * mh, f.remaining());
            for (int i = 0; i < n; i++) {
                float p = 1f - f.get(i);
                int v = (int) (p * 255f);
                out.put((byte) Math.max(0, Math.min(255, v)));
            }
            out.rewind();
            handler.post(() -> uploadMask(out, mw, mh));
        } catch (Throwable t) {
            Log.e(TAG, "segment", t);
        } finally {
            segBusy.set(false);
        }
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
