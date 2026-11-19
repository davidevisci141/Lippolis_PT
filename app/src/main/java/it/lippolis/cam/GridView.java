package it.lippolis.cam;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.util.AttributeSet;
import android.view.View;

/** Griglia 3x3 disegnata sopra l'area 9:16 che finisce nel video. */
public class GridView extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private static final float ASPECT = 9f / 16f;

    public GridView(Context c, AttributeSet a) {
        super(c, a);
        paint.setColor(0x80FFFFFF);
        paint.setStrokeWidth(getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDraw(Canvas c) {
        float w = getWidth(), h = getHeight();
        float rw = w, rh = w / ASPECT;
        if (rh > h) { rh = h; rw = h * ASPECT; }
        float l = (w - rw) / 2f, t = (h - rh) / 2f;
        for (int i = 1; i <= 2; i++) {
            float x = l + rw * i / 3f;
            float y = t + rh * i / 3f;
            c.drawLine(x, t, x, t + rh, paint);
            c.drawLine(l, y, l + rw, y, paint);
        }
    }
}
