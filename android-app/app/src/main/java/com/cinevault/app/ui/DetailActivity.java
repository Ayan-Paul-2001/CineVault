package com.cinevault.app.ui;

import android.content.Intent;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CheckBox;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.TooltipCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.cinevault.app.CineVaultApp;
import com.cinevault.app.R;
import com.cinevault.app.data.MediaDownloadManager;
import com.cinevault.app.data.Models;
import com.cinevault.app.data.ServerConfig;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.chip.Chip;
import com.google.android.material.chip.ChipGroup;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Title Detail screen displaying ALL merged server qualities, quality filter chips,
 * multi-season episodes, plot/cast enrichment, Play, VLC external play, Download, and Watchlist.
 */
public final class DetailActivity extends AppCompatActivity {
    public static final String EXTRA_ITEM_ID = "item_id";
    public static final String EXTRA_AUTO_PLAY = "auto_play";

    private CineVaultApp app;
    private long itemId;
    private boolean autoPlay;
    private boolean didAutoPlay = false;
    private Models.MediaDetailBundle bundle;
    private String qualityFilter = "ALL";
    private String selectedSeriesEdition = "unified";
    private int selectedSeasonIdx = 0;

    private TextView toolbarTitle, detailTitle, detailPills, detailGenres, detailOverview, detailCredits, qualitiesHeading;
    private ImageView detailPoster;
    private View loadingBox, scrollView, qualitiesSection, seasonsSection;
    private View detailHeaderContainer, detailActionsRow;
    private MaterialButton btnPlayBest, btnWatchlist;
    private ChipGroup qualityFilterChips, seriesEditionChips, seasonChips;
    private LinearLayout qualitiesList, episodesList;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_detail);
        WindowInsetsControllerCompat ic = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        ic.setAppearanceLightStatusBars(false);
        View rootView = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(rootView, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return windowInsets;
        });
        app = CineVaultApp.get();
        itemId = getIntent().getLongExtra(EXTRA_ITEM_ID, -1);
        autoPlay = getIntent().getBooleanExtra(EXTRA_AUTO_PLAY, false);
        if (itemId <= 0) { finish(); return; }

        toolbarTitle = findViewById(R.id.detail_toolbar_title);
        detailPoster = findViewById(R.id.detail_poster);
        detailTitle = findViewById(R.id.detail_title);
        detailPills = findViewById(R.id.detail_pills);
        detailGenres = findViewById(R.id.detail_genres);
        detailOverview = findViewById(R.id.detail_overview);
        detailCredits = findViewById(R.id.detail_credits);
        loadingBox = findViewById(R.id.detail_loading_box);
        scrollView = findViewById(R.id.detail_scroll);
        detailHeaderContainer = findViewById(R.id.detail_header_container);
        detailActionsRow = findViewById(R.id.detail_actions_row);
        btnPlayBest = findViewById(R.id.btn_detail_play_best);
        btnWatchlist = findViewById(R.id.btn_detail_watchlist);
        qualitiesSection = findViewById(R.id.detail_qualities_section);
        qualitiesHeading = findViewById(R.id.detail_qualities_heading);
        qualityFilterChips = findViewById(R.id.detail_quality_filter_chips);
        qualitiesList = findViewById(R.id.detail_qualities_list);
        seasonsSection = findViewById(R.id.detail_seasons_section);
        seriesEditionChips = findViewById(R.id.detail_series_edition_chips);
        seasonChips = findViewById(R.id.detail_season_chips);
        episodesList = findViewById(R.id.detail_episodes_list);

        UiHelper.applyTvFocusEffect(btnPlayBest, 1.04f);
        UiHelper.applyTvFocusEffect(btnWatchlist, 1.04f);

        findViewById(R.id.btn_detail_back).setOnClickListener(v -> finish());
        findViewById(R.id.btn_detail_refresh).setOnClickListener(v -> loadDetail(true));

        applyResponsiveFormFactorUi();
        loadDetail(false);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Refresh watch progress whenever returning from PlayerActivity so Resume timestamps stay live
        if (bundle != null && itemId > 0) {
            app.ioExecutor.execute(() -> {
                List<Models.WatchHistoryRecord> freshHistory = app.repository.db.getItemWatchHistory(itemId);
                app.mainHandler.post(() -> {
                    if (isFinishing() || bundle == null) return;
                    Models.MediaDetailBundle cur = bundle;
                    bundle = new Models.MediaDetailBundle(
                            cur.item, cur.files, cur.seasons, cur.editions, freshHistory, cur.meta);
                    renderBundle();
                });
            });
        }
    }

    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyResponsiveFormFactorUi();
    }

    private void applyResponsiveFormFactorUi() {
        boolean tv = UiHelper.isAndroidTv(this);
        boolean tablet = UiHelper.isTablet(this);
        float widthDp = UiHelper.screenWidthDp(this);

        if (detailPoster != null) {
            ViewGroup.LayoutParams plp = detailPoster.getLayoutParams();
            plp.width = UiHelper.dp(this, tv ? 176 : (tablet ? 148 : 110));
            plp.height = UiHelper.dp(this, tv ? 264 : (tablet ? 222 : 165));
            detailPoster.setLayoutParams(plp);
        }
        if (detailTitle != null) detailTitle.setTextSize(tv ? 28f : (tablet ? 24f : 20f));
        if (detailPills != null) detailPills.setTextSize(tv ? 14f : (tablet ? 13.5f : 12.5f));
        if (detailOverview != null) detailOverview.setTextSize(tv ? 15.5f : (tablet ? 14.5f : 13.5f));
        if (detailCredits != null) detailCredits.setTextSize(tv ? 13.5f : 12f);

        if (detailActionsRow != null) {
            ViewGroup.LayoutParams alp = detailActionsRow.getLayoutParams();
            alp.width = (tv || widthDp >= 600f) ? UiHelper.dp(this, 440) : ViewGroup.LayoutParams.MATCH_PARENT;
            detailActionsRow.setLayoutParams(alp);
        }

        int basePad = UiHelper.dp(this, tv ? 36 : (tablet ? 24 : 16));
        int hPad = widthDp >= 960f ? Math.max(basePad, UiHelper.dp(this, (int) ((widthDp - 900f) / 2f))) : basePad;
        if (detailHeaderContainer != null) {
            int vPad = UiHelper.dp(this, tv ? 24 : 16);
            detailHeaderContainer.setPadding(hPad, vPad, hPad, vPad);
        }
        if (qualitiesSection != null) {
            qualitiesSection.setPadding(hPad, UiHelper.dp(this, 18), hPad, 0);
        }
        if (seasonsSection != null) {
            seasonsSection.setPadding(hPad, UiHelper.dp(this, 20), hPad, 0);
        }
    }

    private void loadDetail(boolean force) {
        loadingBox.setVisibility(View.VISIBLE);
        scrollView.setVisibility(View.GONE);
        app.ioExecutor.execute(() -> {
            Models.MediaDetailBundle res = app.repository.metadata.loadDetailBundle(itemId, force);
            app.mainHandler.post(() -> {
                if (isFinishing()) return;
                if (res == null) {
                    Toast.makeText(this, "Title not found in local database", Toast.LENGTH_SHORT).show();
                    finish();
                    return;
                }
                bundle = res;
                qualityFilter = "ALL";
                selectedSeriesEdition = "unified";
                selectedSeasonIdx = 0;
                // Auto-select the season (and server edition if needed) containing the last-watched episode
                if (!res.history.isEmpty() && res.history.get(0).fileUrl != null) {
                    String lastUrl = res.history.get(0).fileUrl;
                    boolean matched = false;
                    for (int si = 0; si < res.seasons.size(); si++) {
                        for (Models.MediaFileEntry ep : res.seasons.get(si).episodes) {
                            if (lastUrl.equals(ep.url)) {
                                selectedSeriesEdition = "unified";
                                selectedSeasonIdx = si;
                                matched = true;
                                break;
                            }
                        }
                        if (matched) break;
                    }
                    if (!matched) {
                        for (Models.MediaEdition ed : res.editions) {
                            for (int si = 0; si < ed.seasons.size(); si++) {
                                for (Models.MediaFileEntry ep : ed.seasons.get(si).episodes) {
                                    if (lastUrl.equals(ep.url)) {
                                        selectedSeriesEdition = String.valueOf(ed.id);
                                        selectedSeasonIdx = si;
                                        matched = true;
                                        break;
                                    }
                                }
                                if (matched) break;
                            }
                            if (matched) break;
                        }
                    }
                }
                loadingBox.setVisibility(View.GONE);
                scrollView.setVisibility(View.VISIBLE);
                renderBundle();

                if (autoPlay && !didAutoPlay) {
                    didAutoPlay = true;
                    Models.PlaybackSession best = findPrimaryPlayable(res);
                    if (best != null) launchPlayer(best);
                }
            });
        });
    }

    private List<Models.QualityOption> buildQualityOptions(List<Models.MediaEdition> editions) {
        List<Models.QualityOption> opts = new ArrayList<>();
        for (Models.MediaEdition ed : editions) {
            if (!ed.hasPlayable || ed.files.isEmpty()) continue;
            for (Models.MediaFileEntry f : ed.files) {
                String fq = f.quality != null ? f.quality : ed.quality;
                String sizePart = f.size > 0 ? " (" + Models.formatBytes(f.size) + ")" : "";
                String lbl = fq + " · " + ed.serverLabel + (ed.audioTags != null ? " · " + ed.audioTags : "") + sizePart;
                opts.add(new Models.QualityOption(ed.id, fq, ed.serverLabel, ed.audioTags, f, ed.subtitles, lbl));
            }
        }
        return opts;
    }

    private Models.PlaybackSession findPrimaryPlayable(Models.MediaDetailBundle d) {
        Models.WatchHistoryRecord hist = d.history.isEmpty() ? null : d.history.get(0);
        List<Models.QualityOption> opts = buildQualityOptions(d.editions);

        if (hist != null) {
            for (Models.SeasonEntry s : d.seasons) {
                for (int i = 0; i < s.episodes.size(); i++) {
                    if (s.episodes.get(i).url.equals(hist.fileUrl)) {
                        return new Models.PlaybackSession(d.item.id, d.item.title, s.episodes.get(i),
                                s.subtitles, s.name, s.episodes, i,
                                d.item.quality != null ? d.item.quality : "HD",
                                ServerConfig.serverDisplayName(s.source, s.url),
                                Collections.emptyList(), hist.completed ? 0 : hist.position);
                    }
                }
            }
            for (Models.MediaEdition ed : d.editions) {
                for (Models.SeasonEntry s : ed.seasons) {
                    for (int i = 0; i < s.episodes.size(); i++) {
                        if (s.episodes.get(i).url.equals(hist.fileUrl)) {
                            return new Models.PlaybackSession(d.item.id, d.item.title, s.episodes.get(i),
                                    s.subtitles, s.name, s.episodes, i,
                                    ed.quality != null ? ed.quality : (d.item.quality != null ? d.item.quality : "HD"),
                                    ed.serverLabel != null ? ed.serverLabel : ServerConfig.serverDisplayName(s.source, s.url),
                                    Collections.emptyList(), hist.completed ? 0 : hist.position);
                        }
                    }
                }
            }
            for (Models.QualityOption o : opts) {
                if (o.file.url.equals(hist.fileUrl)) {
                    return new Models.PlaybackSession(d.item.id, d.item.title, o.file, o.subtitles, null,
                            Collections.emptyList(), 0, o.quality, o.serverLabel, opts,
                            hist.completed ? 0 : hist.position);
                }
            }
        }
        if (!opts.isEmpty()) {
            Models.QualityOption best = opts.get(0);
            return new Models.PlaybackSession(d.item.id, d.item.title, best.file, best.subtitles, null,
                    Collections.emptyList(), 0, best.quality, best.serverLabel, opts, 0);
        }
        Models.SeasonEntry firstSeason = null;
        for (Models.SeasonEntry s : d.seasons) {
            if (!s.episodes.isEmpty()) { firstSeason = s; break; }
        }
        if (firstSeason == null) {
            for (Models.MediaEdition ed : d.editions) {
                for (Models.SeasonEntry s : ed.seasons) {
                    if (!s.episodes.isEmpty()) { firstSeason = s; break; }
                }
                if (firstSeason != null) break;
            }
        }
        if (firstSeason != null) {
            return new Models.PlaybackSession(d.item.id, d.item.title, firstSeason.episodes.get(0),
                    firstSeason.subtitles, firstSeason.name, firstSeason.episodes, 0,
                    d.item.quality != null ? d.item.quality : "HD",
                    ServerConfig.serverDisplayName(firstSeason.source, firstSeason.url),
                    Collections.emptyList(), 0);
        }
        return null;
    }

    private void renderBundle() {
        Models.MediaDetailBundle d = bundle;
        Models.MediaSummary item = d.item;
        toolbarTitle.setText(item.title);
        detailTitle.setText(item.title);
        UiHelper.loadPoster(detailPoster, item.posterUrl);

        List<Models.MediaEdition> movieEditions = new ArrayList<>();
        Set<String> availQualities = new LinkedHashSet<>();
        for (Models.MediaEdition ed : d.editions) {
            if (!ed.files.isEmpty()) {
                movieEditions.add(ed);
                for (Models.MediaFileEntry f : ed.files) {
                    availQualities.add(f.quality != null ? f.quality : ed.quality);
                }
            }
        }

        List<String> pills = new ArrayList<>();
        if (item.year != null) pills.add(String.valueOf(item.year));
        if (d.meta.has("rating") && !d.meta.isNull("rating")) pills.add("IMDb " + d.meta.optString("rating"));
        if (d.meta.has("runtime") && !d.meta.isNull("runtime")) pills.add(d.meta.optString("runtime") + "m");
        pills.addAll(availQualities);
        if (d.editions.size() > 1) pills.add(d.editions.size() + " Servers");
        detailPills.setText(String.join(" · ", pills));

        JSONArray ga = d.meta.optJSONArray("genres");
        List<String> genres = new ArrayList<>();
        if (ga != null) {
            for (int i = 0; i < ga.length(); i++) genres.add(ga.optString(i));
        }
        detailGenres.setText(String.join(" · ", genres));

        String overview = d.meta.optString("overview", "");
        if (!overview.isEmpty()) {
            detailOverview.setVisibility(View.VISIBLE);
            detailOverview.setText(overview);
        } else {
            detailOverview.setVisibility(View.GONE);
        }

        String dir = d.meta.optString("director", "");
        String cast = d.meta.optString("cast", "");
        StringBuilder cred = new StringBuilder();
        if (!dir.isEmpty()) cred.append("Director: ").append(dir);
        if (!cast.isEmpty()) {
            if (cred.length() > 0) cred.append('\n');
            cred.append("Starring: ").append(cast);
        }
        if (cred.length() > 0) {
            detailCredits.setVisibility(View.VISIBLE);
            detailCredits.setText(cred.toString());
        } else {
            detailCredits.setVisibility(View.GONE);
        }

        Models.PlaybackSession primaryPlay = findPrimaryPlayable(d);
        if (primaryPlay != null) {
            btnPlayBest.setVisibility(View.VISIBLE);
            btnPlayBest.setText(primaryPlay.startTime > 10
                    ? "Resume (" + Models.formatDurationSec(primaryPlay.startTime) + ")"
                    : "Play Best (" + (primaryPlay.qualityLabel != null ? primaryPlay.qualityLabel : "HD") + ")");
            btnPlayBest.setOnClickListener(v -> launchPlayer(primaryPlay));
        } else {
            btnPlayBest.setVisibility(View.GONE);
        }

        btnWatchlist.setText(item.inWatchlist ? "In List" : "+ My List");
        btnWatchlist.setOnClickListener(v -> app.ioExecutor.execute(() -> {
            boolean inList = app.repository.db.toggleWatchlist(item.id);
            app.mainHandler.post(() -> {
                bundle = new Models.MediaDetailBundle(item.withWatchlist(inList), d.files, d.seasons, d.editions, d.history, d.meta);
                btnWatchlist.setText(inList ? "In List" : "+ My List");
            });
        }));

        renderMovieQualities(movieEditions, availQualities);
        renderSeasonsAndEpisodes();

        if (UiHelper.isAndroidTv(this) && btnPlayBest.getVisibility() == View.VISIBLE) {
            btnPlayBest.post(() -> btnPlayBest.requestFocus());
        }
    }

    private void renderMovieQualities(List<Models.MediaEdition> movieEditions, Set<String> availQualities) {
        if (movieEditions.isEmpty()) {
            qualitiesSection.setVisibility(View.GONE);
            return;
        }
        qualitiesSection.setVisibility(View.VISIBLE);
        qualitiesHeading.setText("Available Qualities Across Servers (" + movieEditions.size() + ")");

        qualityFilterChips.removeAllViews();
        if (availQualities.size() > 1) {
            addSimpleChip(qualityFilterChips, "All", "ALL".equals(qualityFilter), () -> {
                qualityFilter = "ALL";
                renderMovieQualities(movieEditions, availQualities);
            });
            for (String q : availQualities) {
                addSimpleChip(qualityFilterChips, q, q.equals(qualityFilter), () -> {
                    qualityFilter = q;
                    renderMovieQualities(movieEditions, availQualities);
                });
            }
        }

        Map<String, Models.WatchHistoryRecord> histMap = new HashMap<>();
        for (Models.WatchHistoryRecord h : bundle.history) histMap.put(h.fileUrl, h);
        List<Models.QualityOption> allOpts = buildQualityOptions(bundle.editions);

        qualitiesList.removeAllViews();
        for (Models.MediaEdition ed : movieEditions) {
            for (int i = 0; i < ed.files.size(); i++) {
                Models.MediaFileEntry f = ed.files.get(i);
                String fq = f.quality != null ? f.quality : ed.quality;
                if (!"ALL".equals(qualityFilter) && !qualityFilter.equals(fq)) continue;

                boolean isBest = ed.isPrimary && i == 0;
                Models.WatchHistoryRecord hist = histMap.get(f.url);
                qualitiesList.addView(buildQualityTile(ed, f, fq, isBest, hist, allOpts));
            }
        }
    }

    private View buildQualityTile(Models.MediaEdition ed, Models.MediaFileEntry file, String fq,
                                  boolean isBest, Models.WatchHistoryRecord hist,
                                  List<Models.QualityOption> allOpts) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(UiHelper.dp(this, 12), UiHelper.dp(this, 12), UiHelper.dp(this, 12), UiHelper.dp(this, 12));
        boolean hasResume = hist != null && !hist.completed && hist.position > 5;
        card.setBackground(UiHelper.outlineBoxDrawable(hasResume ? 0x9938BDF8 : (isBest ? 0x88F59E0B : 0x22FFFFFF), 0xFF131826));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = UiHelper.dp(this, 10);
        card.setLayoutParams(lp);

        TextView badges = new TextView(this);
        StringBuilder b = new StringBuilder(fq).append(" · ").append(ed.serverLabel);
        if (ed.audioTags != null) b.append(" · ").append(ed.audioTags);
        if (isBest) b.append(" · HIGHEST QUALITY");
        if (!file.online) b.append(" · MIRROR OFFLINE");
        badges.setText(b.toString());
        badges.setTextColor(UiHelper.qualityColor(fq));
        badges.setTextSize(12f);
        badges.setTypeface(null, android.graphics.Typeface.BOLD);
        card.addView(badges);

        TextView name = new TextView(this);
        name.setText(file.name);
        name.setTextColor(0xFFF3F6FC);
        name.setTextSize(13f);
        name.setPadding(0, UiHelper.dp(this, 4), 0, UiHelper.dp(this, 2));
        card.addView(name);

        TextView info = new TextView(this);
        String sizeTxt = file.size > 0 ? Models.formatBytes(file.size) : "Stream ready";
        if (hist != null && hist.position > 5) {
            sizeTxt += " · " + (hist.completed ? "Watched" : "Resume at " + Models.formatDurationSec(hist.position));
        }
        info.setText(sizeTxt);
        info.setTextColor(0xFF94A3B8);
        info.setTextSize(11.5f);
        card.addView(info);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, UiHelper.dp(this, 10), 0, 0);

        MaterialButton playBtn = new MaterialButton(this);
        playBtn.setText(hasResume ? "Resume (" + Models.formatDurationSec(hist.position) + ")" : "Play");
        playBtn.setAllCaps(false);
        playBtn.setBackgroundColor(0xFFE50914);
        playBtn.setTextColor(Color.WHITE);
        playBtn.setLayoutParams(new LinearLayout.LayoutParams(0, UiHelper.dp(this, 40), 1f));
        playBtn.setOnClickListener(v -> launchPlayer(new Models.PlaybackSession(
                bundle.item.id, bundle.item.title, file, ed.subtitles, null,
                Collections.emptyList(), 0, fq, ed.serverLabel, allOpts,
                hist != null && !hist.completed ? hist.position : 0)));
        UiHelper.applyTvFocusEffect(playBtn, 1.04f);
        actions.addView(playBtn);

        MaterialButton vlcBtn = new MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
        vlcBtn.setText("VLC");
        vlcBtn.setAllCaps(false);
        LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, UiHelper.dp(this, 40));
        vp.leftMargin = UiHelper.dp(this, 6);
        vlcBtn.setLayoutParams(vp);
        vlcBtn.setOnClickListener(v -> UiHelper.openInExternalPlayer(this, file.url, bundle.item.title));
        UiHelper.applyTvFocusEffect(vlcBtn, 1.05f);
        actions.addView(vlcBtn);

        MaterialButton dlBtn = createDownloadIconButton(UiHelper.dp(this, 6), 0);
        dlBtn.setOnClickListener(v -> showDownloadOptionsDialog(file, fq, ed.serverLabel, null, ed.subtitles));
        UiHelper.applyTvFocusEffect(dlBtn, 1.05f);
        actions.addView(dlBtn);

        card.addView(actions);
        return card;
    }

    private void renderSeasonsAndEpisodes() {
        List<Models.MediaEdition> seriesEditions = new ArrayList<>();
        for (Models.MediaEdition ed : bundle.editions) {
            if (!ed.seasons.isEmpty()) seriesEditions.add(ed);
        }

        List<Models.SeasonEntry> displayedSeasons;
        if ("unified".equals(selectedSeriesEdition)) {
            displayedSeasons = !bundle.seasons.isEmpty() ? bundle.seasons
                    : (!seriesEditions.isEmpty() ? seriesEditions.get(0).seasons : Collections.emptyList());
        } else {
            displayedSeasons = bundle.seasons;
            for (Models.MediaEdition ed : seriesEditions) {
                if (String.valueOf(ed.id).equals(selectedSeriesEdition)) {
                    displayedSeasons = ed.seasons;
                    break;
                }
            }
        }

        if (displayedSeasons.isEmpty()) {
            seasonsSection.setVisibility(View.GONE);
            return;
        }
        seasonsSection.setVisibility(View.VISIBLE);

        seriesEditionChips.removeAllViews();
        if (seriesEditions.size() > 1) {
            addSimpleChip(seriesEditionChips, "Unified", "unified".equals(selectedSeriesEdition), () -> {
                selectedSeriesEdition = "unified";
                selectedSeasonIdx = 0;
                renderSeasonsAndEpisodes();
            });
            for (Models.MediaEdition sed : seriesEditions) {
                String key = String.valueOf(sed.id);
                addSimpleChip(seriesEditionChips, sed.serverLabel + " (" + sed.quality + ")", key.equals(selectedSeriesEdition), () -> {
                    selectedSeriesEdition = key;
                    selectedSeasonIdx = 0;
                    renderSeasonsAndEpisodes();
                });
            }
        }

        if (selectedSeasonIdx >= displayedSeasons.size()) selectedSeasonIdx = 0;
        seasonChips.removeAllViews();
        for (int i = 0; i < displayedSeasons.size(); i++) {
            final int idx = i;
            Models.SeasonEntry s = displayedSeasons.get(i);
            addSimpleChip(seasonChips, s.name + " (" + s.episodes.size() + ")", i == selectedSeasonIdx, () -> {
                selectedSeasonIdx = idx;
                renderSeasonsAndEpisodes();
            });
        }

        Map<String, Models.WatchHistoryRecord> histMap = new HashMap<>();
        for (Models.WatchHistoryRecord h : bundle.history) histMap.put(h.fileUrl, h);

        Models.SeasonEntry active = displayedSeasons.get(selectedSeasonIdx);
        episodesList.removeAllViews();
        String srv = ServerConfig.serverDisplayName(active.source, active.url);
        for (int i = 0; i < active.episodes.size(); i++) {
            final int epIdx = i;
            Models.MediaFileEntry ep = active.episodes.get(i);
            Models.WatchHistoryRecord hist = histMap.get(ep.url);
            boolean hasResume = hist != null && !hist.completed && hist.position > 5;

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(UiHelper.dp(this, 12), UiHelper.dp(this, 10), UiHelper.dp(this, 10), UiHelper.dp(this, 10));
            row.setBackground(UiHelper.outlineBoxDrawable(hasResume ? 0x9938BDF8 : 0x1FFFFFFF, 0xFF131826));
            LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            rlp.bottomMargin = UiHelper.dp(this, 8);
            row.setLayoutParams(rlp);

            TextView badge = new TextView(this);
            badge.setText(ep.label);
            badge.setTextColor(0xFFFCA5A5);
            badge.setTextSize(11.5f);
            badge.setTypeface(null, android.graphics.Typeface.BOLD);
            badge.setPadding(UiHelper.dp(this, 8), UiHelper.dp(this, 5), UiHelper.dp(this, 8), UiHelper.dp(this, 5));
            badge.setBackground(UiHelper.pillDrawable(0x2AE50914));
            row.addView(badge);

            LinearLayout mid = new LinearLayout(this);
            mid.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            mlp.leftMargin = UiHelper.dp(this, 10);
            mlp.rightMargin = UiHelper.dp(this, 8);
            mid.setLayoutParams(mlp);

            TextView etitle = new TextView(this);
            etitle.setText(!ep.episodeTitle.isEmpty() ? ep.episodeTitle : ep.name);
            etitle.setTextColor(0xFFF3F6FC);
            etitle.setTextSize(13f);
            etitle.setMaxLines(1);
            mid.addView(etitle);

            List<String> subParts = new ArrayList<>();
            subParts.add(srv);
            if (ep.quality != null) subParts.add(ep.quality);
            if (ep.size > 0) subParts.add(Models.formatBytes(ep.size));
            if (hist != null && hist.position > 5) {
                subParts.add(hist.completed ? "Watched" : "Resume " + Models.formatDurationSec(hist.position));
            }
            TextView esub = new TextView(this);
            esub.setText(String.join(" · ", subParts));
            esub.setTextColor(0xFF94A3B8);
            esub.setTextSize(11f);
            esub.setMaxLines(1);
            mid.addView(esub);
            row.addView(mid);

            String epQuality = ep.quality != null ? ep.quality : (bundle.item.quality != null ? bundle.item.quality : "HD");
            MaterialButton epDlBtn = createDownloadIconButton(0, UiHelper.dp(this, 6));
            epDlBtn.setOnClickListener(v -> showDownloadOptionsDialog(ep, epQuality, srv, active.name, active.subtitles));
            UiHelper.applyTvFocusEffect(epDlBtn, 1.05f);
            row.addView(epDlBtn);

            MaterialButton pbtn = new MaterialButton(this);
            pbtn.setText(hasResume ? "Resume" : "Play");
            pbtn.setAllCaps(false);
            pbtn.setBackgroundColor(0xFFE50914);
            pbtn.setTextColor(Color.WHITE);
            pbtn.setOnClickListener(v -> launchPlayer(new Models.PlaybackSession(
                    bundle.item.id, bundle.item.title, ep, active.subtitles, active.name,
                    active.episodes, epIdx, epQuality,
                    srv, Collections.emptyList(),
                    hist != null && !hist.completed ? hist.position : 0)));
            UiHelper.applyTvFocusEffect(pbtn, 1.05f);
            row.addView(pbtn);

            episodesList.addView(row);
        }
    }

    private MaterialButton createDownloadIconButton(int leftMarginPx, int rightMarginPx) {
        MaterialButton btn = new MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
        btn.setText("");
        btn.setIconResource(R.drawable.ic_download);
        btn.setIconGravity(MaterialButton.ICON_GRAVITY_TEXT_START);
        btn.setIconPadding(0);
        btn.setIconSize(UiHelper.dp(this, 20));
        btn.setIconTint(ColorStateList.valueOf(0xFFF3F6FC));
        btn.setPadding(0, 0, 0, 0);
        btn.setMinWidth(0);
        btn.setMinimumWidth(0);
        btn.setContentDescription("Download");
        TooltipCompat.setTooltipText(btn, "Download");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(UiHelper.dp(this, 44), UiHelper.dp(this, 40));
        lp.leftMargin = leftMarginPx;
        lp.rightMargin = rightMarginPx;
        btn.setLayoutParams(lp);
        return btn;
    }

    private void addSimpleChip(ChipGroup group, String label, boolean selected, Runnable onClick) {
        Chip chip = new Chip(this);
        chip.setText(label);
        chip.setCheckable(true);
        chip.setChecked(selected);
        chip.setTextColor(0xFFF3F6FC);
        chip.setOnClickListener(v -> onClick.run());
        UiHelper.applyTvFocusEffect(chip, 1.05f);
        group.addView(chip);
    }

    private void showDownloadOptionsDialog(Models.MediaFileEntry file, String quality,
                                           String serverLabel, String seasonName,
                                           List<Models.MediaFileEntry> subtitles) {
        if (file == null || !ServerConfig.isAllowedUrl(file.url)) {
            Toast.makeText(this, "Blocked untrusted download URL.", Toast.LENGTH_SHORT).show();
            return;
        }
        String displayTitle = bundle != null ? bundle.item.title : file.name;
        long mediaId = bundle != null ? bundle.item.id : 0L;

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = UiHelper.dp(this, 20);
        box.setPadding(pad, UiHelper.dp(this, 12), pad, UiHelper.dp(this, 6));

        TextView fileTv = new TextView(this);
        StringBuilder meta = new StringBuilder();
        meta.append("File: ").append(file.name);
        meta.append("\nSource: ").append(quality != null ? quality : "HD")
                .append(" · ").append(serverLabel != null ? serverLabel : "CineVault");
        if (seasonName != null && !seasonName.isEmpty()) {
            meta.append(" · ").append(seasonName);
            if (!file.label.isEmpty()) meta.append(" ").append(file.label);
        }
        meta.append("\nSize: ").append(file.size > 0 ? Models.formatBytes(file.size) : "Detected on start");
        meta.append("\nSave to: ").append(MediaDownloadManager.saveLocationHint());
        fileTv.setText(meta.toString());
        fileTv.setTextColor(0xFFCBD5E1);
        fileTv.setTextSize(13f);
        fileTv.setLineSpacing(UiHelper.dp(this, 3), 1f);
        box.addView(fileTv);

        CheckBox cbWifiOnly = new CheckBox(this);
        cbWifiOnly.setText("Download on Wi-Fi only");
        cbWifiOnly.setTextColor(0xFFF3F6FC);
        cbWifiOnly.setChecked(false);
        LinearLayout.LayoutParams lpWifi = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lpWifi.topMargin = UiHelper.dp(this, 12);
        cbWifiOnly.setLayoutParams(lpWifi);
        box.addView(cbWifiOnly);

        CheckBox cbSubs = null;
        if (subtitles != null && !subtitles.isEmpty()) {
            cbSubs = new CheckBox(this);
            cbSubs.setText("Also download external subtitle (.srt/.vtt)");
            cbSubs.setTextColor(0xFFF3F6FC);
            cbSubs.setChecked(true);
            box.addView(cbSubs);
        }

        final CheckBox finalCbSubs = cbSubs;
        new AlertDialog.Builder(this)
                .setTitle("In-App Download Options")
                .setView(box)
                .setPositiveButton("Start Download", (d, w) -> {
                    boolean wifiOnly = cbWifiOnly.isChecked();
                    List<Models.MediaFileEntry> subs = (finalCbSubs != null && finalCbSubs.isChecked())
                            ? subtitles : Collections.emptyList();
                    app.ioExecutor.execute(() -> {
                        long did = MediaDownloadManager.enqueueMediaDownload(
                                DetailActivity.this, app.repository.db, mediaId, displayTitle,
                                file, quality, serverLabel, seasonName, wifiOnly, subs);
                        app.mainHandler.post(() -> {
                            if (did > 0) {
                                Toast.makeText(DetailActivity.this,
                                        "Downloading inside CineVault — track progress in My List -> Downloads",
                                        Toast.LENGTH_LONG).show();
                            } else {
                                Toast.makeText(DetailActivity.this,
                                        "Could not start download. Check storage or connection.",
                                        Toast.LENGTH_LONG).show();
                            }
                        });
                    });
                })
                .setNeutralButton("View Downloads", (d, w) -> {
                    Intent i = new Intent(DetailActivity.this, MainActivity.class);
                    i.putExtra(MainActivity.EXTRA_OPEN_TAB, 3);
                    i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    startActivity(i);
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void launchPlayer(Models.PlaybackSession session) {
        if (!ServerConfig.isAllowedUrl(session.file.url)) {
            Toast.makeText(this, "Blocked untrusted stream URL.", Toast.LENGTH_SHORT).show();
            return;
        }
        Intent i = new Intent(this, PlayerActivity.class);
        i.putExtra(PlayerActivity.EXTRA_SESSION, session);
        startActivity(i);
    }
}
