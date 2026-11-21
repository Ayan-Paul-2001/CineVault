package com.cinevault.app.ui;

import android.graphics.Color;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.cinevault.app.CineVaultApp;
import com.cinevault.app.R;
import com.cinevault.app.data.Models;
import com.cinevault.app.data.ServerConfig;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Reusable poster card adapter for both horizontal Home carousels and adaptive Browse/Watchlist grids.
 */
public final class MediaCardAdapter extends RecyclerView.Adapter<MediaCardAdapter.VH> {
    public interface OnItemClick { void onClick(Models.MediaSummary item); }
    public interface OnItemRemove { void onRemove(Models.MediaSummary item); }

    private final List<Models.MediaSummary> items = new ArrayList<>();
    private final boolean gridMode;
    private final boolean continueWatchingMode;
    private final OnItemClick onClick;
    private final OnItemRemove onRemove;
    private final Map<Long, String> resolvedPosters = new ConcurrentHashMap<>();

    public MediaCardAdapter(boolean gridMode, boolean continueWatchingMode,
                            OnItemClick onClick, OnItemRemove onRemove) {
        this.gridMode = gridMode;
        this.continueWatchingMode = continueWatchingMode;
        this.onClick = onClick;
        this.onRemove = onRemove;
    }

    public void submitList(List<Models.MediaSummary> list) {
        items.clear();
        if (list != null) items.addAll(list);
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public VH onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View v = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_media_card, parent, false);
        boolean tv = UiHelper.isAndroidTv(parent.getContext());
        boolean tablet = UiHelper.isTablet(parent.getContext());
        View posterFrame = v.findViewById(R.id.poster_frame);
        if (gridMode) {
            v.setLayoutParams(new RecyclerView.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            if (posterFrame != null && (tv || tablet)) {
                ViewGroup.LayoutParams plp = posterFrame.getLayoutParams();
                plp.height = UiHelper.dp(parent.getContext(), tv ? 236 : 216);
                posterFrame.setLayoutParams(plp);
            }
        } else if (tv || tablet) {
            int cardW = UiHelper.dp(parent.getContext(), tv ? 172 : 156);
            int posterH = UiHelper.dp(parent.getContext(), tv ? 242 : 220);
            RecyclerView.LayoutParams rlp = new RecyclerView.LayoutParams(cardW, ViewGroup.LayoutParams.WRAP_CONTENT);
            rlp.setMarginEnd(UiHelper.dp(parent.getContext(), tv ? 10 : 6));
            v.setLayoutParams(rlp);
            if (posterFrame != null) {
                ViewGroup.LayoutParams plp = posterFrame.getLayoutParams();
                plp.height = posterH;
                posterFrame.setLayoutParams(plp);
            }
        }
        v.setOnFocusChangeListener((view, hasFocus) -> {
            float scale = hasFocus ? (tv ? 1.07f : 1.04f) : 1.0f;
            view.animate()
                    .scaleX(scale)
                    .scaleY(scale)
                    .translationZ(hasFocus ? UiHelper.dp(view.getContext(), 8) : 0f)
                    .setDuration(120)
                    .start();
        });
        return new VH(v);
    }

    @Override
    public void onBindViewHolder(@NonNull VH h, int position) {
        Models.MediaSummary item = items.get(position);
        h.boundId = item.id;

        h.title.setText(item.title);
        boolean tv = UiHelper.isAndroidTv(h.itemView.getContext());
        h.title.setTextSize(tv ? 14f : 12.5f);
        h.subtitle.setTextSize(tv ? 12f : 11f);
        ServerConfig.CategoryDef cat = ServerConfig.CATEGORY_BY_ID.get(item.category);
        String catLabel = cat != null ? cat.shortLabel : item.category;
        String sub = item.year != null ? item.year + " · " + catLabel : catLabel;
        h.subtitle.setText(sub);

        int[] palette = UiHelper.paletteForTitle(item.title);
        UiHelper.applyFallbackGradient(h.fallbackBox, palette);
        h.fallbackBar.setBackgroundColor(palette[2]);
        h.fallbackTitle.setText(item.title);
        h.fallbackYear.setText(item.year != null ? String.valueOf(item.year) : "");

        String poster = item.posterUrl != null && !item.posterUrl.isEmpty()
                ? item.posterUrl : resolvedPosters.get(item.id);
        if (poster != null && !poster.isEmpty()) {
            h.fallbackBox.setVisibility(View.GONE);
            h.poster.setVisibility(View.VISIBLE);
            UiHelper.loadPoster(h.poster, poster);
        } else {
            h.poster.setVisibility(View.GONE);
            h.fallbackBox.setVisibility(View.VISIBLE);
            UiHelper.loadPoster(h.poster, null);
            CineVaultApp app = CineVaultApp.get();
            app.ioExecutor.execute(() -> {
                String resolved = app.repository.metadata.resolvePosterUrl(item);
                if (resolved != null && !resolved.isEmpty()) {
                    resolvedPosters.put(item.id, resolved);
                    app.mainHandler.post(() -> {
                        if (h.boundId == item.id) {
                            h.fallbackBox.setVisibility(View.GONE);
                            h.poster.setVisibility(View.VISIBLE);
                            UiHelper.loadPoster(h.poster, resolved);
                        }
                    });
                }
            });
        }

        if (item.quality != null && !item.quality.isEmpty()) {
            h.qualityPill.setVisibility(View.VISIBLE);
            h.qualityPill.setText(item.quality);
            int bg = "4K".equalsIgnoreCase(item.quality) ? 0xFFF59E0B
                    : ("1080p".equalsIgnoreCase(item.quality) ? 0xFFE50914 : 0xCC000000);
            h.qualityPill.setBackground(UiHelper.pillDrawable(bg));
            h.qualityPill.setTextColor("4K".equalsIgnoreCase(item.quality) ? 0xFF111827 : Color.WHITE);
        } else {
            h.qualityPill.setVisibility(View.GONE);
        }

        String al = item.audioTags != null ? item.audioTags.toLowerCase(Locale.US) : "";
        if (al.contains("multi") || al.contains("dual")) {
            h.audioPill.setVisibility(View.VISIBLE);
            h.audioPill.setText(al.contains("multi") ? "MULTI" : "DUAL");
            h.audioPill.setBackground(UiHelper.pillDrawable(0xE638BDF8));
        } else {
            h.audioPill.setVisibility(View.GONE);
        }

        if (onRemove != null) {
            h.removeBtn.setVisibility(View.VISIBLE);
            h.removeBtn.setOnClickListener(v -> onRemove.onRemove(item));
        } else {
            h.removeBtn.setVisibility(View.GONE);
        }

        if (continueWatchingMode && item.historyPosition > 5) {
            h.cwFooter.setVisibility(View.VISIBLE);
            String epPrefix = (item.historyEpisodeLabel != null && !item.historyEpisodeLabel.isEmpty())
                    ? item.historyEpisodeLabel + " · " : "";
            h.cwLabel.setText(epPrefix + Models.formatDurationSec(item.historyPosition));
            h.cwProgress.setProgress(item.watchPercentInt());
        } else {
            h.cwFooter.setVisibility(View.GONE);
        }

        h.itemView.setOnClickListener(v -> {
            if (onClick != null) onClick.onClick(item);
        });
    }

    @Override
    public int getItemCount() { return items.size(); }

    static final class VH extends RecyclerView.ViewHolder {
        long boundId = -1;
        final ImageView poster;
        final LinearLayout fallbackBox;
        final View fallbackBar;
        final TextView fallbackTitle;
        final TextView fallbackYear;
        final TextView qualityPill;
        final TextView audioPill;
        final ImageButton removeBtn;
        final LinearLayout cwFooter;
        final TextView cwLabel;
        final ProgressBar cwProgress;
        final TextView title;
        final TextView subtitle;

        VH(@NonNull View v) {
            super(v);
            poster = v.findViewById(R.id.card_poster);
            fallbackBox = v.findViewById(R.id.card_fallback_box);
            fallbackBar = v.findViewById(R.id.card_fallback_bar);
            fallbackTitle = v.findViewById(R.id.card_fallback_title);
            fallbackYear = v.findViewById(R.id.card_fallback_year);
            qualityPill = v.findViewById(R.id.card_quality_pill);
            audioPill = v.findViewById(R.id.card_audio_pill);
            removeBtn = v.findViewById(R.id.card_remove_btn);
            cwFooter = v.findViewById(R.id.card_cw_footer);
            cwLabel = v.findViewById(R.id.card_cw_label);
            cwProgress = v.findViewById(R.id.card_cw_progress);
            title = v.findViewById(R.id.card_title);
            subtitle = v.findViewById(R.id.card_subtitle);
        }
    }
}
