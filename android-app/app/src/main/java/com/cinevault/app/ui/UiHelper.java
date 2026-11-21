package com.cinevault.app.ui;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.util.TypedValue;
import android.view.View;
import android.widget.ImageView;
import android.widget.Toast;

import com.bumptech.glide.Glide;
import com.bumptech.glide.load.model.GlideUrl;
import com.bumptech.glide.load.model.LazyHeaders;
import com.cinevault.app.data.ServerConfig;

import java.util.Locale;
import java.util.Map;

/**
 * Shared UI utilities: Glide poster loader with ICC Referer headers, badge colors, safe external links.
 */
public final class UiHelper {
    private UiHelper() {}

    private static final int[][] FALLBACK_PALETTES = {
            {0xFF1A1F36, 0xFF3B1D38, 0xFFE50914},
            {0xFF0F2027, 0xFF203A43, 0xFFF59E0B},
            {0xFF1B1429, 0xFF372152, 0xFFA855F7},
            {0xFF102026, 0xFF1B3B4B, 0xFF38BDF8},
            {0xFF12221A, 0xFF1F3D2E, 0xFF22C55E},
    };

    public static int dp(Context ctx, int dp) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, dp, ctx.getResources().getDisplayMetrics()));
    }

    public static int qualityColor(String quality) {
        String u = quality == null ? "" : quality.toUpperCase(Locale.US);
        if ("4K".equals(u) || "2160P".equals(u)) return 0xFFF59E0B;
        if ("1080P".equals(u)) return 0xFFE50914;
        if ("3D".equals(u)) return 0xFFA855F7;
        if ("720P".equals(u)) return 0xFF38BDF8;
        return 0xFF64748B;
    }

    public static int serverColor(String source) {
        if ("icc".equals(source)) return 0xFFA855F7;
        if ("circleftp".equals(source)) return 0xFF14B8A6;
        if ("discoveryftp".equals(source)) return 0xFF5B8FFF;
        return 0xFF22C55E;
    }

    public static int[] paletteForTitle(String title) {
        int hash = 0;
        if (title != null) {
            for (int i = 0; i < title.length(); i++) {
                hash = (hash * 31 + title.charAt(i)) & 0x7FFFFFFF;
            }
        }
        return FALLBACK_PALETTES[hash % FALLBACK_PALETTES.length];
    }

    public static void applyFallbackGradient(View view, int[] palette) {
        GradientDrawable gd = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{palette[0], palette[1]}
        );
        view.setBackground(gd);
    }

    public static void loadPoster(ImageView target, String url) {
        if (url == null || url.isEmpty()) {
            Glide.with(target).clear(target);
            target.setImageDrawable(null);
            return;
        }
        String safeUrl = ServerConfig.sanitizeMediaUrl(url);
        Map<String, String> headers = ServerConfig.mediaHeadersFor(safeUrl);
        Object model;
        if (!headers.isEmpty()) {
            LazyHeaders.Builder lb = new LazyHeaders.Builder();
            for (Map.Entry<String, String> e : headers.entrySet()) {
                lb.addHeader(e.getKey(), e.getValue());
            }
            model = new GlideUrl(safeUrl, lb.build());
        } else {
            model = safeUrl;
        }
        Glide.with(target.getContext())
                .load(model)
                .centerCrop()
                .into(target);
    }

    public static void openExternalBrowser(Context ctx, String url, boolean updateOnly) {
        if (url == null || url.isEmpty()) return;
        boolean ok = updateOnly ? ServerConfig.isTrustedUpdateUrl(url) : ServerConfig.isAllowedUrl(url);
        if (!ok) {
            Toast.makeText(ctx, "Blocked untrusted URL.", Toast.LENGTH_SHORT).show();
            return;
        }
        String finalUrl = updateOnly ? url.trim() : ServerConfig.sanitizeMediaUrl(url);
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(finalUrl));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(ctx, "No browser app found to open link.", Toast.LENGTH_SHORT).show();
        }
    }

    public static void openInExternalPlayer(Context ctx, String videoUrl, String title) {
        if (!ServerConfig.isAllowedUrl(videoUrl)) {
            Toast.makeText(ctx, "Blocked untrusted stream URL.", Toast.LENGTH_SHORT).show();
            return;
        }
        String safeUrl = ServerConfig.sanitizeMediaUrl(videoUrl);
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(Uri.parse(safeUrl), "video/*");
            intent.putExtra("title", title != null ? title : "CineVault");
            if (ServerConfig.isIccUrl(safeUrl)) {
                intent.putExtra("headers", new String[]{"Referer", ServerConfig.ICC_ORIGIN + "/"});
            }
            ctx.startActivity(Intent.createChooser(intent, "Play with external player"));
        } catch (Exception e) {
            Toast.makeText(ctx, "No external video player installed.", Toast.LENGTH_SHORT).show();
        }
    }

    public static GradientDrawable pillDrawable(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(10f);
        return d;
    }

    public static GradientDrawable outlineBoxDrawable(int strokeColor, int fillColor) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fillColor);
        d.setCornerRadius(24f);
        d.setStroke(2, strokeColor);
        return d;
    }

    public static int alphaColor(int color, int alpha) {
        return Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color));
    }
}
