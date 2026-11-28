package com.cinevault.app.ui;

import android.content.Intent;
import android.content.res.Configuration;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.ui.PlayerView;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.cinevault.app.CineVaultApp;
import com.cinevault.app.R;
import com.cinevault.app.data.H5aiService;
import com.cinevault.app.data.MediaDownloadManager;
import com.cinevault.app.data.MediaRepository;
import com.cinevault.app.data.Models;
import com.cinevault.app.data.ServerConfig;
import com.cinevault.app.data.UpdateService;
import com.cinevault.app.player.PlaybackManager;
import com.google.android.material.bottomnavigation.BottomNavigationView;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.chip.Chip;
import com.google.android.material.chip.ChipGroup;
import com.google.android.material.materialswitch.MaterialSwitch;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Main navigation shell hosting:
 * - Home (Recents-First + Hero + Continue Watching)
 * - Movies & TV/Anime Browse with Unified Filter Panel
 * - Instant FTS5 Search + live session-free ICC boost
 * - My List (Watchlist & Watch History)
 * - Dedicated Servers tab (Server Health, Auto-Sync Scheduler, ICC Session, Public Release Version Control Updates)
 */
public final class MainActivity extends AppCompatActivity {
    public static final String EXTRA_OPEN_TAB = "open_tab";

    private static final int[] AUTO_SYNC_INTERVAL_MINS = {15, 30, 60, 180, 360};
    private static final String[] AUTO_SYNC_INTERVAL_LABELS = {
            "Every 15 min", "Every 30 min", "Every 1 hour", "Every 3 hours", "Every 6 hours"
    };

    private CineVaultApp app;
    private final Handler uiHandler = new Handler(Looper.getMainLooper());

    private int currentTab = 0; // 0: Home, 1: Movies, 2: TV & Anime, 3: My List, 4: Search, 5: Servers
    private final Deque<Integer> tabBackStack = new ArrayDeque<>();
    private boolean isPoppingBackStack = false;
    private long lastHomeBackPressMs = 0L;
    private boolean searchOpen = false;
    private boolean filtersExpanded = false;
    private boolean suppressSpinnerEvents = false;
    private boolean suppressAutoSyncUiEvents = false;
    private boolean forceLockShown = false;
    private int heroIndex = 0;
    private Models.HomeFeed homeFeed;
    private Models.LibraryStats latestStats = Models.LibraryStats.empty();
    private Models.SearchFacets latestSearchFacets = null;
    private Models.BrowseFilter currentFilter = new Models.BrowseFilter();
    private final AtomicInteger browseRequestSeq = new AtomicInteger(0);
    private Models.AppUpdateInfo availableUpdate;
    private String confirmClearTarget = null;
    private String lastLiveIccSearchQuery = "";

    // Top bar, TV/Tablet top nav & 3-second update popup
    private View topAppBar, topBarInner, tvTabletNavBar;
    private TextView topNavHome, topNavMovies, topNavSeries, topNavMyList, topNavServers;
    private View brandContainer;
    private EditText searchInput;
    private ImageButton btnSearchToggle;
    private View syncStatusDot;
    private TextView syncChipText;
    private ProgressBar topSyncProgress;
    private View updateBanner;
    private TextView updateBannerText, updateBannerSub;
    private View v142FeaturePopup;
    private ProgressBar v142FeaturePopupBar;
    private android.animation.ObjectAnimator v142FeaturePopupAnimator;

    // Tab views & responsive containers
    private SwipeRefreshLayout homeSwipe;
    private View browseContainer, browseHeaderBox;
    private View myListContainer, myListContentInner;
    private View serversContainer, serversContentInner;
    private BottomNavigationView bottomNav;
    private RecyclerView browseRv, wlRv;
    private boolean initialTvFocusRequested = false;

    // Home widgets
    private View homeEmptyBox;
    private View heroContainer, heroContentBox, heroActionsRow;
    private ImageView heroBackdrop;
    private TextView heroKicker, heroTitle, heroMeta;
    private MaterialButton btnHeroPlay, btnHeroDetails, btnHeroWatchlist;
    private LinearLayout heroDots;
    private View cwSection;
    private MediaCardAdapter cwAdapter;
    private HomeSectionAdapter homeSectionsAdapter;

    // Browse widgets
    private TextView browseTitle, browseCount, browseEmpty, filterHeaderText, filterChevron, pageIndicator;
    private View filterBody, btnResetFilters, browsePagination;
    private ChipGroup filterCategoryChips;
    private Spinner spinYear, spinQuality, spinAudio, spinLanguage, spinServer, spinSort;
    private MediaCardAdapter browseAdapter;
    private MaterialButton btnPrevPage, btnNextPage;
    private final List<String> yearValues = new ArrayList<>();
    private final List<String> qualityValues = new ArrayList<>();
    private final List<String> audioValues = new ArrayList<>();
    private final List<String> langValues = new ArrayList<>();
    private final List<String> serverValues = new ArrayList<>();
    private final List<String> sortValues = new ArrayList<>();

    // My List & In-App Downloads widgets
    private View myListHistorySection, myListWlEmpty;
    private TextView myListHistoryTitle, myListWlTitle;
    private TextView myListDownloadsTitle, myListDownloadsActiveBadge, myListDownloadsEmpty;
    private LinearLayout myListDownloadsList;
    private MaterialButton btnClearHistory, btnClearWatchlist, btnClearCompletedDownloads;
    private MediaCardAdapter myListHistoryAdapter, myListWlAdapter;

    private final Runnable downloadsPollRunnable = new Runnable() {
        @Override
        public void run() {
            if (currentTab == 3 && !isFinishing() && !isDestroyed()) {
                refreshDownloadsSectionOnly();
                uiHandler.postDelayed(this, 1000L);
            }
        }
    };

    // Dedicated Servers, Health, Auto-Sync & App Updates widgets
    private TextView srvMetricTotal, srvMetricMovies, srvMetricSeries;
    private TextView srvStatsDups, srvStatsSources, srvSyncLabel, srvSyncErrors;
    private TextView srvListHeaderTitle, srvListStatusStrip;
    private ProgressBar srvSyncBar;
    private MaterialButton btnSrvSyncQuick, btnSrvSyncFull, btnSrvPingAll, btnSrvAddServer, btnSrvResetDefaults;
    private MaterialButton btnSrvBdixScan;
    private TextView srvBdixStatus;
    private ProgressBar srvBdixProgress;
    private LinearLayout srvBdixResults;
    private TextView srvLastSyncText, srvAppVersion, srvUpdateStatus, srvUpdateNotes;
    private MaterialSwitch switchAutoSync;
    private Spinner spinAutoSyncInterval;
    private LinearLayout srvHealthList;
    private MaterialButton btnSrvCheckUpdates, btnSrvDownloadUpdate;
    private volatile List<Models.ServerFilterOption> cachedServerFilterOptions = Collections.emptyList();
    private volatile long lastHealthReprobeMs = 0L;
    private android.net.ConnectivityManager connectivityManager;
    private android.net.ConnectivityManager.NetworkCallback networkCallback;
    private final Runnable networkReprobeRunnable = () -> app.ioExecutor.execute(() -> {
        lastHealthReprobeMs = System.currentTimeMillis();
        boolean netOk = isDeviceNetworkAvailable();
        if (!netOk) {
            app.repository.markAllServersOffline();
        } else {
            app.repository.checkAllServersHealth();
        }
        cachedServerFilterOptions = app.repository.db.getServerFilterOptions();
        uiHandler.post(() -> {
            if (isFinishing() || isDestroyed()) return;
            loadHome(false);
            if (currentTab == 1 || currentTab == 2 || currentTab == 4) loadBrowse();
            else if (currentTab == 3) loadMyList();
            else if (currentTab == 5) loadServersTab(false);
        });
    });
    private final com.cinevault.app.data.BdixScannerService.ScanListener bdixScanListener = p -> uiHandler.post(() -> {
        if (isFinishing() || isDestroyed()) return;
        renderBdixScanProgress(p);
        if (!p.running && "done".equals(p.phase)) {
            app.ioExecutor.execute(() -> {
                cachedServerFilterOptions = app.repository.db.getServerFilterOptions();
                uiHandler.post(() -> {
                    loadHome(false);
                    if (currentTab == 5) loadServersTab(false);
                });
            });
        }
    });

    // YouTube Premium-Style In-App Minimizable Mini-Player Drawer Bar widgets
    private View miniPlayerBar, miniPlayerContent;
    private PlayerView miniPlayerVideo;
    private ProgressBar miniPlayerProgress;
    private TextView miniPlayerTitle, miniPlayerSub;
    private ImageButton btnMiniPlayPause, btnMiniClose;

    private final PlaybackManager.Listener miniPlayerListener = new PlaybackManager.Listener() {
        @Override
        public void onSessionChanged(Models.PlaybackSession session) {
            uiHandler.post(MainActivity.this::updateMiniPlayerUi);
        }

        @Override
        public void onPlaybackStateChanged(int playbackState, boolean isPlaying) {
            uiHandler.post(MainActivity.this::updateMiniPlayerUi);
        }

        @Override
        public void onPositionUpdated(long posMs, long durMs) {
            uiHandler.post(() -> updateMiniPlayerProgress(posMs, durMs));
        }

        @Override
        public void onSessionStopped() {
            uiHandler.post(MainActivity.this::hideMiniPlayerBar);
        }
    };

    private Runnable pendingSearchRunnable;

    private final Runnable hideUpdatePopupRunnable = () -> {
        if (updateBanner != null && updateBanner.getVisibility() == View.VISIBLE) {
            updateBanner.animate()
                    .alpha(0f)
                    .setDuration(220)
                    .withEndAction(() -> {
                        updateBanner.setVisibility(View.GONE);
                        updateBanner.setAlpha(1f);
                    })
                    .start();
        }
    };

    private final Runnable hideV142FeaturePopupRunnable = this::dismissV142FeaturePopup;

    private final Runnable autoUpdateCheckRunnable = new Runnable() {
        @Override
        public void run() {
            checkForUpdatesBackground(false);
            uiHandler.postDelayed(this, UpdateService.AUTO_CHECK_INTERVAL_MS);
        }
    };

    private final Runnable heroRotateRunnable = new Runnable() {
        @Override
        public void run() {
            if (homeFeed != null && homeFeed.hero.size() > 1 && currentTab == 0) {
                heroIndex = (heroIndex + 1) % homeFeed.hero.size();
                renderHero();
            }
            uiHandler.postDelayed(this, 8000);
        }
    };

    private final Runnable autoSyncCheckRunnable = new Runnable() {
        @Override
        public void run() {
            app.ioExecutor.execute(() -> {
                if (app.repository.isAutoSyncDue() && !app.repository.getSyncProgress().running) {
                    app.repository.runSync("quick", true, () -> uiHandler.post(MainActivity.this::refreshSilentlyAfterBackgroundSync));
                }
            });
            uiHandler.postDelayed(this, 5L * 60L * 1000L);
        }
    };

    private boolean lastSyncRunningState = false;
    private final MediaRepository.SyncListener syncListener = p -> uiHandler.post(() -> {
        boolean showTopIndicator = p.running && !p.silent;
        topSyncProgress.setVisibility(showTopIndicator ? View.VISIBLE : View.GONE);
        topSyncProgress.setProgress(p.percent);
        syncStatusDot.setBackgroundColor(showTopIndicator ? 0xFF38BDF8 : 0xFF22C55E);
        if (showTopIndicator) {
            syncChipText.setText(p.percent + "%");
        } else {
            updateSyncChipCount();
            if (!p.running) homeSwipe.setRefreshing(false);
        }
        renderServersSyncProgress(p);
        if (lastSyncRunningState && !p.running) {
            app.ioExecutor.execute(() -> {
                cachedServerFilterOptions = app.repository.db.getServerFilterOptions();
                uiHandler.post(() -> {
                    if (currentTab == 5) loadServersTab(false);
                });
            });
        }
        lastSyncRunningState = p.running;
    });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        setContentView(R.layout.activity_main);
        app = CineVaultApp.get();

        applyEdgeToEdgeInsets();
        bindViews();
        setupListeners();
        setupBackNavigation();
        app.repository.addSyncListener(syncListener);
        app.repository.bdixScanner.addListener(bdixScanListener);
        registerNetworkMonitor();

        bootstrapCatalogAndHome();
        handleOpenTabIntent(getIntent());
        maybeShowOneTimeV142ServerFeaturePopup();
        checkForUpdatesBackground(true);
        uiHandler.postDelayed(heroRotateRunnable, 8000);
        uiHandler.postDelayed(autoSyncCheckRunnable, 60000);
        uiHandler.postDelayed(autoUpdateCheckRunnable, UpdateService.AUTO_CHECK_INTERVAL_MS);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleOpenTabIntent(intent);
    }

    private void handleOpenTabIntent(Intent intent) {
        if (intent == null) return;
        int requested = intent.getIntExtra(EXTRA_OPEN_TAB, -1);
        if (requested >= 0) {
            intent.removeExtra(EXTRA_OPEN_TAB);
            switchTab(requested, "", "", "recent");
        }
    }

    private void applyEdgeToEdgeInsets() {
        WindowInsetsControllerCompat ic = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        ic.setAppearanceLightStatusBars(false);
        ic.setAppearanceLightNavigationBars(false);

        View topBar = findViewById(R.id.top_app_bar);
        View navBar = findViewById(R.id.bottom_nav);

        ViewCompat.setOnApplyWindowInsetsListener(topBar, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, 0);
            return windowInsets;
        });

        ViewCompat.setOnApplyWindowInsetsListener(navBar, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(bars.left, 0, bars.right, bars.bottom);
            return windowInsets;
        });
    }

    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyResponsiveFormFactorUi();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            int code = event.getKeyCode();
            if (code == KeyEvent.KEYCODE_SEARCH) {
                if (!searchOpen) btnSearchToggle.performClick();
                else searchInput.requestFocus();
                return true;
            }
            if (code == KeyEvent.KEYCODE_MENU) {
                if (currentTab == 5) switchTab(0, "", "", "recent");
                else switchTab(5, "", "", "recent");
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (app.playbackManager != null) {
            app.playbackManager.addListener(miniPlayerListener);
            updateMiniPlayerUi();
        }
        // Never flash stale preloaded offline tiles before the initial reachability check completes!
        if (app.repository.hasCheckedHealthOnce()) {
            if (currentTab == 0) loadHome(false);
            else if (currentTab == 3) {
                loadMyList();
                startDownloadsPolling();
            }
            else if (currentTab == 5) loadServersTab(false);

            // Re-verify reachability when returning from background (e.g. switched Wi-Fi <-> Mobile Data!)
            if (System.currentTimeMillis() - lastHealthReprobeMs >= 20000L) {
                uiHandler.removeCallbacks(networkReprobeRunnable);
                uiHandler.postDelayed(networkReprobeRunnable, 250L);
            }
        }
        checkForUpdatesBackground(true);
    }

    @Override
    protected void onPause() {
        uiHandler.removeCallbacks(downloadsPollRunnable);
        if (app.playbackManager != null) {
            app.playbackManager.removeListener(miniPlayerListener);
            app.playbackManager.detachPlayerView(miniPlayerVideo);
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        uiHandler.removeCallbacksAndMessages(null);
        if (v142FeaturePopupAnimator != null) {
            v142FeaturePopupAnimator.cancel();
            v142FeaturePopupAnimator = null;
        }
        app.repository.removeSyncListener(syncListener);
        app.repository.bdixScanner.removeListener(bdixScanListener);
        unregisterNetworkMonitor();
        if (app.playbackManager != null) {
            app.playbackManager.removeListener(miniPlayerListener);
            app.playbackManager.detachPlayerView(miniPlayerVideo);
        }
        super.onDestroy();
    }

    private void bindViews() {
        topAppBar = findViewById(R.id.top_app_bar);
        topBarInner = findViewById(R.id.top_bar_inner);
        tvTabletNavBar = findViewById(R.id.tv_tablet_nav_bar);
        topNavHome = findViewById(R.id.top_nav_home);
        topNavMovies = findViewById(R.id.top_nav_movies);
        topNavSeries = findViewById(R.id.top_nav_series);
        topNavMyList = findViewById(R.id.top_nav_mylist);
        topNavServers = findViewById(R.id.top_nav_servers);
        brandContainer = findViewById(R.id.brand_container);
        searchInput = findViewById(R.id.search_input);
        btnSearchToggle = findViewById(R.id.btn_search_toggle);
        syncStatusDot = findViewById(R.id.sync_status_dot);
        syncChipText = findViewById(R.id.sync_chip_text);
        topSyncProgress = findViewById(R.id.top_sync_progress);
        updateBanner = findViewById(R.id.update_banner);
        updateBannerText = findViewById(R.id.update_banner_text);
        updateBannerSub = findViewById(R.id.update_banner_sub);
        v142FeaturePopup = findViewById(R.id.v142_feature_popup);
        v142FeaturePopupBar = findViewById(R.id.v142_feature_popup_bar);
        View btnV142Open = findViewById(R.id.btn_v142_feature_open);
        View btnV142Close = findViewById(R.id.btn_v142_feature_close);
        if (btnV142Open != null) {
            btnV142Open.setOnClickListener(v -> {
                dismissV142FeaturePopup();
                switchTab(5, "", "", "recent");
            });
        }
        if (btnV142Close != null) {
            btnV142Close.setOnClickListener(v -> dismissV142FeaturePopup());
        }

        homeSwipe = findViewById(R.id.home_swipe);
        browseContainer = findViewById(R.id.browse_container);
        browseHeaderBox = findViewById(R.id.browse_header_box);
        myListContainer = findViewById(R.id.mylist_container);
        myListContentInner = findViewById(R.id.mylist_content_inner);
        serversContainer = findViewById(R.id.servers_container);
        serversContentInner = findViewById(R.id.servers_content_inner);
        bottomNav = findViewById(R.id.bottom_nav);

        homeEmptyBox = findViewById(R.id.home_empty_box);
        heroContainer = findViewById(R.id.hero_container);
        heroContentBox = findViewById(R.id.hero_content_box);
        heroActionsRow = findViewById(R.id.hero_actions_row);
        heroBackdrop = findViewById(R.id.hero_backdrop);
        heroKicker = findViewById(R.id.hero_kicker);
        heroTitle = findViewById(R.id.hero_title);
        heroMeta = findViewById(R.id.hero_meta);
        btnHeroPlay = findViewById(R.id.btn_hero_play);
        btnHeroDetails = findViewById(R.id.btn_hero_details);
        btnHeroWatchlist = findViewById(R.id.btn_hero_watchlist);
        heroDots = findViewById(R.id.hero_dots);
        cwSection = findViewById(R.id.cw_section);

        RecyclerView cwRv = findViewById(R.id.cw_recycler);
        cwRv.setLayoutManager(new LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false));
        cwAdapter = new MediaCardAdapter(false, true, this::resumeFromHistory, this::removeHistoryItem);
        cwRv.setAdapter(cwAdapter);

        RecyclerView secRv = findViewById(R.id.home_sections_recycler);
        secRv.setLayoutManager(new LinearLayoutManager(this));
        homeSectionsAdapter = new HomeSectionAdapter(item -> openDetail(item, false), sec ->
                switchTab(sec.targetTab, sec.categoryFilter, sec.yearFilter, sec.sortFilter));
        secRv.setAdapter(homeSectionsAdapter);

        browseTitle = findViewById(R.id.browse_title);
        browseCount = findViewById(R.id.browse_count);
        browseEmpty = findViewById(R.id.browse_empty);
        filterHeaderText = findViewById(R.id.filter_header_text);
        filterChevron = findViewById(R.id.filter_chevron);
        filterBody = findViewById(R.id.filter_body);
        btnResetFilters = findViewById(R.id.btn_reset_filters);
        filterCategoryChips = findViewById(R.id.filter_category_chips);
        spinYear = findViewById(R.id.spin_year);
        spinQuality = findViewById(R.id.spin_quality);
        spinAudio = findViewById(R.id.spin_audio);
        spinLanguage = findViewById(R.id.spin_language);
        spinServer = findViewById(R.id.spin_server);
        spinSort = findViewById(R.id.spin_sort);
        browsePagination = findViewById(R.id.browse_pagination);
        btnPrevPage = findViewById(R.id.btn_prev_page);
        btnNextPage = findViewById(R.id.btn_next_page);
        pageIndicator = findViewById(R.id.page_indicator);

        int gridCols = computeGridColumns();
        browseRv = findViewById(R.id.browse_recycler);
        browseRv.setLayoutManager(new GridLayoutManager(this, gridCols));
        browseAdapter = new MediaCardAdapter(true, false, item -> openDetail(item, false), null);
        browseRv.setAdapter(browseAdapter);

        myListHistorySection = findViewById(R.id.mylist_history_section);
        myListHistoryTitle = findViewById(R.id.mylist_history_title);
        btnClearHistory = findViewById(R.id.btn_clear_history);
        myListWlTitle = findViewById(R.id.mylist_wl_title);
        btnClearWatchlist = findViewById(R.id.btn_clear_watchlist);
        myListWlEmpty = findViewById(R.id.mylist_wl_empty);
        myListDownloadsTitle = findViewById(R.id.mylist_downloads_title);
        myListDownloadsActiveBadge = findViewById(R.id.mylist_downloads_active_badge);
        myListDownloadsEmpty = findViewById(R.id.mylist_downloads_empty);
        myListDownloadsList = findViewById(R.id.mylist_downloads_list);
        btnClearCompletedDownloads = findViewById(R.id.btn_clear_completed_downloads);

        RecyclerView histRv = findViewById(R.id.mylist_history_recycler);
        histRv.setLayoutManager(new LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false));
        myListHistoryAdapter = new MediaCardAdapter(false, true, this::resumeFromHistory, this::removeHistoryItem);
        histRv.setAdapter(myListHistoryAdapter);

        wlRv = findViewById(R.id.mylist_wl_recycler);
        wlRv.setLayoutManager(new GridLayoutManager(this, gridCols));
        myListWlAdapter = new MediaCardAdapter(true, false, item -> openDetail(item, false), this::removeWatchlistItem);
        wlRv.setAdapter(myListWlAdapter);

        // Servers tab widgets
        srvMetricTotal = findViewById(R.id.srv_metric_total);
        srvMetricMovies = findViewById(R.id.srv_metric_movies);
        srvMetricSeries = findViewById(R.id.srv_metric_series);
        srvStatsDups = findViewById(R.id.srv_stats_dups);
        srvStatsSources = findViewById(R.id.srv_stats_sources);
        srvSyncLabel = findViewById(R.id.srv_sync_label);
        srvSyncBar = findViewById(R.id.srv_sync_bar);
        srvSyncErrors = findViewById(R.id.srv_sync_errors);
        btnSrvSyncQuick = findViewById(R.id.btn_srv_sync_quick);
        btnSrvSyncFull = findViewById(R.id.btn_srv_sync_full);
        srvLastSyncText = findViewById(R.id.srv_last_sync_text);
        switchAutoSync = findViewById(R.id.switch_auto_sync);
        spinAutoSyncInterval = findViewById(R.id.spin_auto_sync_interval);
        srvListHeaderTitle = findViewById(R.id.srv_list_header_title);
        srvListStatusStrip = findViewById(R.id.srv_list_status_strip);
        btnSrvBdixScan = findViewById(R.id.btn_srv_bdix_scan);
        srvBdixStatus = findViewById(R.id.srv_bdix_status);
        srvBdixProgress = findViewById(R.id.srv_bdix_progress);
        srvBdixResults = findViewById(R.id.srv_bdix_results);
        btnSrvAddServer = findViewById(R.id.btn_srv_add_server);
        btnSrvResetDefaults = findViewById(R.id.btn_srv_reset_defaults);
        btnSrvPingAll = findViewById(R.id.btn_srv_ping_all);
        srvHealthList = findViewById(R.id.srv_health_list);
        srvAppVersion = findViewById(R.id.srv_app_version);
        btnSrvCheckUpdates = findViewById(R.id.btn_srv_check_updates);
        btnSrvDownloadUpdate = findViewById(R.id.btn_srv_download_update);
        srvUpdateStatus = findViewById(R.id.srv_update_status);
        srvUpdateNotes = findViewById(R.id.srv_update_notes);

        // Mini-Player Drawer Bar widgets
        miniPlayerBar = findViewById(R.id.mini_player_bar);
        miniPlayerContent = findViewById(R.id.mini_player_content);
        miniPlayerVideo = findViewById(R.id.mini_player_video);
        miniPlayerProgress = findViewById(R.id.mini_player_progress);
        miniPlayerTitle = findViewById(R.id.mini_player_title);
        miniPlayerSub = findViewById(R.id.mini_player_sub);
        btnMiniPlayPause = findViewById(R.id.btn_mini_play_pause);
        btnMiniClose = findViewById(R.id.btn_mini_close);

        srvAppVersion.setText("V" + app.repository.updateService.getInstalledVersion()
                + " (Code " + app.repository.updateService.getInstalledVersionCode() + ")");
        setSpinnerItems(spinAutoSyncInterval, Arrays.asList(AUTO_SYNC_INTERVAL_LABELS));

        // TV & keyboard D-Pad focus highlights on key controls
        UiHelper.applyTvFocusEffect(btnHeroPlay, 1.05f);
        UiHelper.applyTvFocusEffect(btnHeroDetails, 1.05f);
        UiHelper.applyTvFocusEffect(btnHeroWatchlist, 1.06f);
        UiHelper.applyTvFocusEffect(findViewById(R.id.btn_home_bdix_scan), 1.05f);
        UiHelper.applyTvFocusEffect(findViewById(R.id.btn_home_sync_now), 1.05f);
        UiHelper.applyTvFocusEffect(btnSrvBdixScan, 1.03f);
        UiHelper.applyTvFocusEffect(btnPrevPage, 1.05f);
        UiHelper.applyTvFocusEffect(btnNextPage, 1.05f);
        UiHelper.applyTvFocusEffect(btnClearHistory, 1.05f);
        UiHelper.applyTvFocusEffect(btnClearWatchlist, 1.05f);
        UiHelper.applyTvFocusEffect(btnClearCompletedDownloads, 1.05f);
        UiHelper.applyTvFocusEffect(btnSrvSyncQuick, 1.04f);
        UiHelper.applyTvFocusEffect(btnSrvSyncFull, 1.04f);
        UiHelper.applyTvFocusEffect(btnSrvAddServer, 1.04f);
        UiHelper.applyTvFocusEffect(btnSrvResetDefaults, 1.04f);
        UiHelper.applyTvFocusEffect(btnSrvPingAll, 1.05f);
        UiHelper.applyTvFocusEffect(btnSrvCheckUpdates, 1.03f);
        UiHelper.applyTvFocusEffect(btnSrvDownloadUpdate, 1.03f);
        UiHelper.applyTvFocusEffect(btnMiniPlayPause, 1.08f);
        UiHelper.applyTvFocusEffect(btnMiniClose, 1.08f);
        UiHelper.applyTvFocusEffect(topNavHome, 1.06f);
        UiHelper.applyTvFocusEffect(topNavMovies, 1.06f);
        UiHelper.applyTvFocusEffect(topNavSeries, 1.06f);
        UiHelper.applyTvFocusEffect(topNavMyList, 1.06f);
        UiHelper.applyTvFocusEffect(topNavServers, 1.06f);

        applyResponsiveFormFactorUi();
    }

    private void applyResponsiveFormFactorUi() {
        boolean tv = UiHelper.isAndroidTv(this);
        boolean tablet = UiHelper.isTablet(this);
        boolean useTopNav = UiHelper.useTopNavLayout(this);
        float widthDp = UiHelper.screenWidthDp(this);

        if (tvTabletNavBar != null) {
            tvTabletNavBar.setVisibility((useTopNav && !searchOpen) ? View.VISIBLE : View.GONE);
        }
        if (bottomNav != null) {
            bottomNav.setVisibility(useTopNav ? View.GONE : View.VISIBLE);
        }

        if (topBarInner != null) {
            ViewGroup.LayoutParams tlp = topBarInner.getLayoutParams();
            tlp.height = UiHelper.dp(this, tv ? 64 : (tablet ? 60 : 56));
            topBarInner.setLayoutParams(tlp);
            int topHPad = UiHelper.dp(this, tv ? 28 : (tablet ? 20 : 12));
            topBarInner.setPadding(topHPad, 0, topHPad, 0);
        }

        if (heroContainer != null) {
            ViewGroup.LayoutParams hlp = heroContainer.getLayoutParams();
            hlp.height = UiHelper.dp(this, tv ? 420 : (widthDp >= 720f ? 375 : (tablet ? 345 : 305)));
            heroContainer.setLayoutParams(hlp);
        }
        if (heroContentBox != null) {
            int hp = UiHelper.dp(this, tv ? 28 : (tablet ? 24 : 16));
            int vp = UiHelper.dp(this, tv ? 22 : (tablet ? 18 : 16));
            heroContentBox.setPadding(hp, vp, hp, vp);
        }
        if (heroTitle != null) {
            heroTitle.setTextSize(tv ? 32f : (tablet ? 28f : 24f));
        }
        if (heroMeta != null) {
            heroMeta.setTextSize(tv ? 14f : (tablet ? 13f : 12f));
        }
        if (heroActionsRow != null) {
            ViewGroup.LayoutParams alp = heroActionsRow.getLayoutParams();
            alp.width = (tv || widthDp >= 600f) ? UiHelper.dp(this, 440) : ViewGroup.LayoutParams.MATCH_PARENT;
            heroActionsRow.setLayoutParams(alp);
        }

        int gridCols = computeGridColumns();
        if (browseRv != null && browseRv.getLayoutManager() instanceof GridLayoutManager) {
            ((GridLayoutManager) browseRv.getLayoutManager()).setSpanCount(gridCols);
            int bPad = UiHelper.dp(this, tv ? 24 : (tablet ? 18 : 12));
            browseRv.setPadding(bPad, browseRv.getPaddingTop(), bPad, browseRv.getPaddingBottom());
        }
        if (wlRv != null && wlRv.getLayoutManager() instanceof GridLayoutManager) {
            ((GridLayoutManager) wlRv.getLayoutManager()).setSpanCount(gridCols);
        }

        int basePad = UiHelper.dp(this, tv ? 28 : (tablet ? 22 : 16));
        if (browseHeaderBox != null) {
            browseHeaderBox.setPadding(basePad, UiHelper.dp(this, 12), basePad, UiHelper.dp(this, 8));
        }

        int centeredSidePad = basePad;
        if (widthDp >= 900f) {
            centeredSidePad = Math.max(basePad, UiHelper.dp(this, (int) ((widthDp - 840f) / 2f)));
        }
        if (serversContentInner != null) {
            serversContentInner.setPadding(centeredSidePad, UiHelper.dp(this, 18), centeredSidePad, UiHelper.dp(this, 32));
        }
        if (myListContentInner != null) {
            myListContentInner.setPadding(basePad, UiHelper.dp(this, 18), basePad, UiHelper.dp(this, 28));
        }

        if (cwSection != null) {
            RecyclerView cwRv = findViewById(R.id.cw_recycler);
            if (cwRv != null && (tv || tablet)) {
                int cPad = UiHelper.dp(this, tv ? 24 : 20);
                cwRv.setPadding(cPad, cwRv.getPaddingTop(), cPad, cwRv.getPaddingBottom());
            }
        }

        updateTopNavStyles();
    }

    private void updateTopNavStyles() {
        if (topNavHome == null) return;
        styleTopNavItem(topNavHome, currentTab == 0);
        styleTopNavItem(topNavMovies, currentTab == 1);
        styleTopNavItem(topNavSeries, currentTab == 2);
        styleTopNavItem(topNavMyList, currentTab == 3);
        styleTopNavItem(topNavServers, currentTab == 5);
    }

    private void styleTopNavItem(TextView tv, boolean active) {
        tv.setTextColor(active ? 0xFFE50914 : 0xFFCBD5E1);
    }

    private int computeGridColumns() {
        float widthDp = UiHelper.screenWidthDp(this);
        if (UiHelper.isAndroidTv(this)) {
            return Math.max(4, Math.min(7, (int) ((widthDp - 56f) / 172f)));
        }
        if (UiHelper.isTablet(this)) {
            return Math.max(3, Math.min(6, (int) ((widthDp - 36f) / 156f)));
        }
        return Math.max(2, Math.min(4, (int) (widthDp / 140f)));
    }

    private void setupListeners() {
        findViewById(R.id.btn_sync_chip).setOnClickListener(v -> switchTab(5, "", "", "recent"));
        findViewById(R.id.btn_home_bdix_scan).setOnClickListener(v -> {
            switchTab(5, "", "", "recent");
            startWifiBdixScan();
        });
        findViewById(R.id.btn_home_sync_now).setOnClickListener(v -> switchTab(5, "", "", "recent"));
        homeSwipe.setColorSchemeColors(0xFFE50914);
        homeSwipe.setOnRefreshListener(() -> triggerSync("quick"));

        View.OnClickListener openUpdateClick = v -> {
            uiHandler.removeCallbacks(hideUpdatePopupRunnable);
            updateBanner.setVisibility(View.GONE);
            if (availableUpdate != null) showUpdateDialog(availableUpdate);
        };
        updateBanner.setOnClickListener(openUpdateClick);
        findViewById(R.id.btn_update_banner_open).setOnClickListener(openUpdateClick);
        findViewById(R.id.btn_update_banner_close).setOnClickListener(v -> {
            uiHandler.removeCallbacks(hideUpdatePopupRunnable);
            updateBanner.setVisibility(View.GONE);
        });

        btnSearchToggle.setOnClickListener(v -> {
            searchOpen = !searchOpen;
            brandContainer.setVisibility(searchOpen ? View.GONE : View.VISIBLE);
            if (tvTabletNavBar != null) {
                tvTabletNavBar.setVisibility((!searchOpen && UiHelper.useTopNavLayout(this)) ? View.VISIBLE : View.GONE);
            }
            searchInput.setVisibility(searchOpen ? View.VISIBLE : View.GONE);
            btnSearchToggle.setImageResource(searchOpen ? R.drawable.ic_close : R.drawable.ic_search);
            if (searchOpen) {
                searchInput.requestFocus();
            } else {
                searchInput.setText("");
                if (currentTab == 4) switchTab(0, "", "", "recent");
            }
        });

        topNavHome.setOnClickListener(v -> { if (searchOpen) btnSearchToggle.performClick(); switchTab(0, "", "", "recent"); });
        topNavMovies.setOnClickListener(v -> { if (searchOpen) btnSearchToggle.performClick(); switchTab(1, "", "", "recent"); });
        topNavSeries.setOnClickListener(v -> { if (searchOpen) btnSearchToggle.performClick(); switchTab(2, "", "", "recent"); });
        topNavMyList.setOnClickListener(v -> { if (searchOpen) btnSearchToggle.performClick(); switchTab(3, "", "", "recent"); });
        topNavServers.setOnClickListener(v -> { if (searchOpen) btnSearchToggle.performClick(); switchTab(5, "", "", "recent"); });

        searchInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable s) {
                if (pendingSearchRunnable != null) uiHandler.removeCallbacks(pendingSearchRunnable);
                String q = s.toString().trim();
                long delay = q.length() == 1 ? 250L : 150L;
                pendingSearchRunnable = () -> {
                    if (q.isEmpty()) {
                        latestSearchFacets = null;
                        if (currentTab == 4) switchTab(0, "", "", "recent");
                        return;
                    }
                    latestSearchFacets = null;
                    currentTab = 4;
                    currentFilter = new Models.BrowseFilter();
                    currentFilter.query = q;
                    currentFilter.sort = "relevance";
                    currentFilter.limit = 36;
                    showActiveTabView();
                    populateFilterControls();
                    loadBrowse();
                    boostSearchWithLiveIcc(q);
                };
                uiHandler.postDelayed(pendingSearchRunnable, delay);
            }
        });

        bottomNav.setOnItemSelectedListener(item -> {
            int id = item.getItemId();
            if (searchOpen) btnSearchToggle.performClick();
            if (id == R.id.nav_home) switchTab(0, "", "", "recent");
            else if (id == R.id.nav_movies) switchTab(1, "", "", "recent");
            else if (id == R.id.nav_series) switchTab(2, "", "", "recent");
            else if (id == R.id.nav_mylist) switchTab(3, "", "", "recent");
            else if (id == R.id.nav_servers) switchTab(5, "", "", "recent");
            return true;
        });

        findViewById(R.id.btn_toggle_filters).setOnClickListener(v -> {
            filtersExpanded = !filtersExpanded;
            filterBody.setVisibility(filtersExpanded ? View.VISIBLE : View.GONE);
            filterChevron.setText(filtersExpanded ? "Hide" : "Show");
        });

        btnResetFilters.setOnClickListener(v -> {
            String prevQ = currentTab == 4 ? currentFilter.query : "";
            String group = currentTab == 1 ? "movies" : (currentTab == 2 ? "series" : "");
            currentFilter = new Models.BrowseFilter();
            currentFilter.query = prevQ;
            currentFilter.group = group;
            currentFilter.sort = (currentTab == 4 && !prevQ.isEmpty()) ? "relevance" : "recent";
            populateFilterControls();
            loadBrowse();
        });

        btnPrevPage.setOnClickListener(v -> {
            if (currentFilter.page > 1) {
                currentFilter.page--;
                loadBrowse();
            }
        });
        btnNextPage.setOnClickListener(v -> {
            currentFilter.page++;
            loadBrowse();
        });

        btnClearHistory.setOnClickListener(v -> handleTwoStepClear("history", btnClearHistory, "Clear History", () ->
                app.ioExecutor.execute(() -> {
                    app.repository.db.clearWatchHistory();
                    uiHandler.post(() -> { loadMyList(); loadHome(false); });
                })));

        btnClearWatchlist.setOnClickListener(v -> handleTwoStepClear("watchlist", btnClearWatchlist, "Clear Watchlist", () ->
                app.ioExecutor.execute(() -> {
                    app.repository.db.clearWatchlist();
                    uiHandler.post(() -> { loadMyList(); loadHome(false); });
                })));

        btnClearCompletedDownloads.setOnClickListener(v -> app.ioExecutor.execute(() -> {
            List<Models.DownloadStatusItem> live = MediaDownloadManager.queryLiveDownloads(MainActivity.this, app.repository.db);
            for (Models.DownloadStatusItem it : live) {
                if (it.completed || it.failed) {
                    app.repository.db.deleteDownloadRecord(it.record.downloadId);
                }
            }
            uiHandler.post(this::refreshDownloadsSectionOnly);
        }));

        setupSpinners();
        setupServersTabListeners();
    }

    private void setupServersTabListeners() {
        btnSrvSyncQuick.setOnClickListener(v -> triggerSync("quick"));
        btnSrvSyncFull.setOnClickListener(v -> triggerSync("full"));

        switchAutoSync.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (suppressAutoSyncUiEvents) return;
            app.ioExecutor.execute(() -> app.repository.setAutoSyncEnabled(isChecked));
            Toast.makeText(this, isChecked ? "Auto-Sync enabled" : "Auto-Sync paused", Toast.LENGTH_SHORT).show();
        });

        spinAutoSyncInterval.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int pos, long id) {
                if (suppressAutoSyncUiEvents || pos < 0 || pos >= AUTO_SYNC_INTERVAL_MINS.length) return;
                int mins = AUTO_SYNC_INTERVAL_MINS[pos];
                app.ioExecutor.execute(() -> app.repository.setAutoSyncIntervalMinutes(mins));
            }
            @Override public void onNothingSelected(AdapterView<?> parent) {}
        });

        if (btnSrvBdixScan != null) {
            btnSrvBdixScan.setOnClickListener(v -> startWifiBdixScan());
        }
        btnSrvAddServer.setOnClickListener(v -> showAddServerDialog());
        btnSrvResetDefaults.setOnClickListener(v -> confirmResetDefaultServers());
        btnSrvPingAll.setOnClickListener(v -> pingAllServersIntoTab());

        btnSrvCheckUpdates.setOnClickListener(v -> runManualUpdateCheck());

        btnSrvDownloadUpdate.setOnClickListener(v -> {
            if (availableUpdate != null) {
                UiHelper.downloadAppUpdateDirect(this, availableUpdate);
            }
        });

        miniPlayerContent.setOnClickListener(v -> expandMiniPlayerToFullscreen());
        btnMiniPlayPause.setOnClickListener(v -> {
            if (app.playbackManager != null) app.playbackManager.togglePlayPause();
        });
        btnMiniClose.setOnClickListener(v -> {
            if (app.playbackManager != null) app.playbackManager.stopAndRelease();
        });
    }

    private void updateMiniPlayerUi() {
        if (miniPlayerBar == null || app.playbackManager == null) return;
        PlaybackManager pm = app.playbackManager;
        if (!pm.hasActiveSession() || pm.isFullscreenActive() || pm.isInPipMode()) {
            hideMiniPlayerBar();
            return;
        }
        miniPlayerBar.setVisibility(View.VISIBLE);
        miniPlayerTitle.setText(pm.formatSessionTitle());
        btnMiniPlayPause.setImageResource(pm.isPlaying() ? R.drawable.ic_pause : R.drawable.ic_play);
        pm.attachPlayerView(miniPlayerVideo);
        updateMiniPlayerProgress(pm.getCurrentPositionMs(), pm.getDurationMs());
    }

    private void updateMiniPlayerProgress(long posMs, long durMs) {
        if (miniPlayerBar == null || miniPlayerBar.getVisibility() != View.VISIBLE || app.playbackManager == null) return;
        PlaybackManager pm = app.playbackManager;
        if (durMs > 0L) {
            int p = (int) Math.max(0L, Math.min(1000L, (posMs * 1000L) / durMs));
            miniPlayerProgress.setProgress(p);
        } else {
            miniPlayerProgress.setProgress(0);
        }
        String base = pm.formatSessionSubtitle();
        String timePart = durMs > 0L
                ? Models.formatDurationSec(posMs / 1000.0) + " / " + Models.formatDurationSec(durMs / 1000.0)
                : (pm.isPlaying() ? "Playing" : "Paused");
        miniPlayerSub.setText(base.isEmpty() ? timePart : (base + " · " + timePart));
    }

    private void hideMiniPlayerBar() {
        if (app.playbackManager != null) {
            app.playbackManager.detachPlayerView(miniPlayerVideo);
        }
        if (miniPlayerBar != null) {
            miniPlayerBar.setVisibility(View.GONE);
        }
    }

    private void expandMiniPlayerToFullscreen() {
        if (app.playbackManager == null || !app.playbackManager.hasActiveSession()) {
            hideMiniPlayerBar();
            return;
        }
        app.playbackManager.detachPlayerView(miniPlayerVideo);
        Intent i = new Intent(this, PlayerActivity.class);
        i.putExtra(PlayerActivity.EXTRA_RESUME_ACTIVE, true);
        startActivity(i);
    }

    private void setupBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (searchOpen) {
                    btnSearchToggle.performClick();
                    return;
                }
                if ((currentTab == 1 || currentTab == 2 || currentTab == 4) && filtersExpanded) {
                    filtersExpanded = false;
                    filterBody.setVisibility(View.GONE);
                    filterChevron.setText("Show");
                    return;
                }
                if (!tabBackStack.isEmpty()) {
                    int prev = tabBackStack.pop();
                    isPoppingBackStack = true;
                    switchTab(prev, "", "", "recent");
                    isPoppingBackStack = false;
                    return;
                }
                if (currentTab != 0) {
                    isPoppingBackStack = true;
                    switchTab(0, "", "", "recent");
                    isPoppingBackStack = false;
                    return;
                }

                long now = System.currentTimeMillis();
                if (now - lastHomeBackPressMs <= 2500L) {
                    lastHomeBackPressMs = 0L;
                    new AlertDialog.Builder(MainActivity.this)
                            .setTitle("Exit CineVault?")
                            .setMessage("Are you sure you want to quit CineVault?")
                            .setNegativeButton("Cancel", null)
                            .setPositiveButton("Quit", (d, w) -> {
                                if (app.playbackManager != null) app.playbackManager.stopAndRelease();
                                finishAffinity();
                            })
                            .show();
                } else {
                    lastHomeBackPressMs = now;
                    Toast.makeText(MainActivity.this, "Press back again to quit CineVault", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    private boolean isDeviceNetworkAvailable() {
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            android.net.Network active = cm.getActiveNetwork();
            if (active == null) return false;
            android.net.NetworkCapabilities caps = cm.getNetworkCapabilities(active);
            return caps != null && (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                    || caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)
                    || caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR));
        } catch (Exception e) {
            return true;
        }
    }

    private void registerNetworkMonitor() {
        try {
            connectivityManager = (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (connectivityManager == null) return;
            networkCallback = new android.net.ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(android.net.Network network) {
                    uiHandler.removeCallbacks(networkReprobeRunnable);
                    uiHandler.postDelayed(networkReprobeRunnable, 1200L);
                }

                @Override
                public void onLost(android.net.Network network) {
                    uiHandler.removeCallbacks(networkReprobeRunnable);
                    uiHandler.postDelayed(networkReprobeRunnable, 400L);
                }
            };
            connectivityManager.registerDefaultNetworkCallback(networkCallback);
        } catch (Exception ignored) {}
    }

    private void unregisterNetworkMonitor() {
        try {
            if (connectivityManager != null && networkCallback != null) {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            }
        } catch (Exception ignored) {}
        networkCallback = null;
    }

    private void bootstrapCatalogAndHome() {
        app.ioExecutor.execute(() -> {
            // Verify live server reachability BEFORE showing Home so OFFLINE servers NEVER display stale preloaded content!
            lastHealthReprobeMs = System.currentTimeMillis();
            if (!isDeviceNetworkAvailable()) {
                app.repository.markAllServersOffline();
            } else {
                app.repository.checkAllServersHealth();
            }
            // Clean stray release tags & run deduplication automatically on upgrade (respecting live is_online state!)
            app.repository.db.cleanupDirtyTitlesAndDeduplicate();
            cachedServerFilterOptions = app.repository.db.getServerFilterOptions();
            uiHandler.post(() -> loadHome(true));
        });
    }

    private void boostSearchWithLiveIcc(String query) {
        if (query.length() < 3 || query.equalsIgnoreCase(lastLiveIccSearchQuery)) return;
        lastLiveIccSearchQuery = query;
        app.ioExecutor.execute(() -> {
            int added = app.repository.indexIccLiveSearch(query);
            if (added > 0) {
                uiHandler.post(() -> {
                    if (currentTab == 4 && query.equals(currentFilter.query)) {
                        loadBrowse();
                    }
                });
            }
        });
    }

    private void handleTwoStepClear(String target, MaterialButton btn, String defaultText, Runnable action) {
        if (!target.equals(confirmClearTarget)) {
            confirmClearTarget = target;
            btn.setText("Confirm Clear?");
            uiHandler.postDelayed(() -> {
                if (target.equals(confirmClearTarget)) {
                    confirmClearTarget = null;
                    btn.setText(defaultText);
                }
            }, 4000);
            return;
        }
        confirmClearTarget = null;
        btn.setText(defaultText);
        action.run();
    }

    private void setupSpinners() {
        qualityValues.clear();
        qualityValues.addAll(Arrays.asList("", "4K", "1080p", "720p", "3D"));
        setSpinnerItems(spinQuality, Arrays.asList("All Quality", "4K Ultra HD", "1080p Full HD", "720p HD", "3D Movies"));

        audioValues.clear();
        audioValues.addAll(Arrays.asList("", "dual", "multi", "hindi-dubbed"));
        setSpinnerItems(spinAudio, Arrays.asList("All Audio", "Dual Audio", "Multi Audio", "Hindi Dubbed"));

        serverValues.clear();
        serverValues.addAll(Arrays.asList("", "dhakaflix", "icc", "circleftp", "discoveryftp"));
        setSpinnerItems(spinServer, Arrays.asList("All Servers", "DhakaFlix", "ICC FTP", "CircleFTP", "DiscoveryFTP"));

        AdapterView.OnItemSelectedListener listener = new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int pos, long id) {
                if (suppressSpinnerEvents) return;
                boolean changed = false;
                if (parent == spinYear && pos >= 0 && pos < yearValues.size()) {
                    String next = yearValues.get(pos);
                    if (!next.equals(currentFilter.year)) { currentFilter.year = next; changed = true; }
                } else if (parent == spinQuality && pos >= 0 && pos < qualityValues.size()) {
                    String next = qualityValues.get(pos);
                    if (!next.equals(currentFilter.quality)) { currentFilter.quality = next; changed = true; }
                } else if (parent == spinAudio && pos >= 0 && pos < audioValues.size()) {
                    String next = audioValues.get(pos);
                    if (!next.equals(currentFilter.audio)) { currentFilter.audio = next; changed = true; }
                } else if (parent == spinLanguage && pos >= 0 && pos < langValues.size()) {
                    String next = langValues.get(pos);
                    if (!next.equals(currentFilter.language)) { currentFilter.language = next; changed = true; }
                } else if (parent == spinServer && pos >= 0 && pos < serverValues.size()) {
                    String next = serverValues.get(pos);
                    if (!next.equals(currentFilter.source)) { currentFilter.source = next; changed = true; }
                } else if (parent == spinSort && pos >= 0 && pos < sortValues.size()) {
                    String next = sortValues.get(pos);
                    if (!next.equals(currentFilter.sort)) { currentFilter.sort = next; changed = true; }
                }
                if (!changed) return;
                currentFilter.page = 1;
                loadBrowse();
            }
            @Override public void onNothingSelected(AdapterView<?> parent) {}
        };

        spinYear.setOnItemSelectedListener(listener);
        spinQuality.setOnItemSelectedListener(listener);
        spinAudio.setOnItemSelectedListener(listener);
        spinLanguage.setOnItemSelectedListener(listener);
        spinServer.setOnItemSelectedListener(listener);
        spinSort.setOnItemSelectedListener(listener);
    }

    private void setSpinnerItems(Spinner sp, List<String> labels) {
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, labels);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        sp.setAdapter(adapter);
    }

    private void populateFilterControls() {
        suppressSpinnerEvents = true;
        boolean isSearchMode = (currentTab == 4);
        Models.SearchFacets facets = isSearchMode ? latestSearchFacets : null;

        // 1. Section Chips (scoped to active search results when in Search mode!)
        filterCategoryChips.removeAllViews();
        if (isSearchMode) {
            if (facets != null) {
                String allLbl = "All (" + facets.totalUnfiltered + (facets.capped ? "+" : "") + ")";
                addCategoryChip(allLbl, "", currentFilter.category.isEmpty());
                List<ServerConfig.CategoryDef> matchedCats = new ArrayList<>();
                for (ServerConfig.CategoryDef c : ServerConfig.CATEGORIES) {
                    int cnt = facets.byCategory.containsKey(c.id) ? facets.byCategory.get(c.id) : 0;
                    if (cnt > 0 || c.id.equals(currentFilter.category)) matchedCats.add(c);
                }
                matchedCats.sort((a, b) -> {
                    int ca = facets.byCategory.containsKey(a.id) ? facets.byCategory.get(a.id) : 0;
                    int cb = facets.byCategory.containsKey(b.id) ? facets.byCategory.get(b.id) : 0;
                    return Integer.compare(cb, ca);
                });
                for (ServerConfig.CategoryDef c : matchedCats) {
                    int cnt = facets.byCategory.containsKey(c.id) ? facets.byCategory.get(c.id) : 0;
                    addCategoryChip(c.shortLabel + " (" + cnt + ")", c.id, c.id.equals(currentFilter.category));
                }
            } else {
                addCategoryChip("All", "", currentFilter.category.isEmpty());
            }
        } else {
            addCategoryChip("All", "", currentFilter.category.isEmpty());
            for (ServerConfig.CategoryDef c : ServerConfig.CATEGORIES) {
                if (currentTab == 1 && !"movies".equals(c.group)) continue;
                if (currentTab == 2 && !"series".equals(c.group)) continue;
                Integer count = latestStats.byCategory.get(c.id);
                String lbl = (count != null && count > 0) ? c.shortLabel + " (" + count + ")" : c.shortLabel;
                addCategoryChip(lbl, c.id, c.id.equals(currentFilter.category));
            }
        }

        // 2. Year Spinner
        yearValues.clear();
        List<String> yearLabels = new ArrayList<>();
        yearValues.add(""); yearLabels.add("All Years");
        if (facets != null) {
            for (int y : facets.years) {
                String ys = String.valueOf(y);
                int yc = facets.yearCounts.containsKey(y) ? facets.yearCounts.get(y) : 0;
                yearValues.add(ys);
                yearLabels.add(ys + " (" + yc + ")");
            }
            if (!currentFilter.year.isEmpty() && !yearValues.contains(currentFilter.year)) {
                yearValues.add(1, currentFilter.year);
                yearLabels.add(1, currentFilter.year + " (0)");
            }
        } else {
            for (int y : latestStats.years) {
                yearValues.add(String.valueOf(y));
                yearLabels.add(String.valueOf(y));
            }
        }
        setSpinnerItems(spinYear, yearLabels);
        spinYear.setSelection(Math.max(0, yearValues.indexOf(currentFilter.year)), false);

        // 3. Quality Spinner
        qualityValues.clear();
        List<String> qualityLabels = new ArrayList<>();
        qualityValues.add(""); qualityLabels.add("All Quality");
        String[][] qOpts = {{"4K", "4K Ultra HD"}, {"1080p", "1080p Full HD"}, {"720p", "720p HD"}, {"3D", "3D Movies"}};
        for (String[] opt : qOpts) {
            if (facets != null) {
                int qCnt = facets.qualities.containsKey(opt[0]) ? facets.qualities.get(opt[0]) : 0;
                if (qCnt > 0 || opt[0].equals(currentFilter.quality)) {
                    qualityValues.add(opt[0]);
                    qualityLabels.add(opt[1] + " (" + qCnt + ")");
                }
            } else {
                qualityValues.add(opt[0]);
                qualityLabels.add(opt[1]);
            }
        }
        setSpinnerItems(spinQuality, qualityLabels);
        spinQuality.setSelection(Math.max(0, qualityValues.indexOf(currentFilter.quality)), false);

        // 4. Audio Spinner
        audioValues.clear();
        List<String> audioLabels = new ArrayList<>();
        audioValues.add(""); audioLabels.add("All Audio");
        String[][] aOpts = {{"dual", "Dual Audio"}, {"multi", "Multi Audio"}, {"hindi-dubbed", "Hindi Dubbed"}};
        for (String[] opt : aOpts) {
            if (facets != null) {
                int aCnt = facets.audios.containsKey(opt[0]) ? facets.audios.get(opt[0]) : 0;
                if (aCnt > 0 || opt[0].equals(currentFilter.audio)) {
                    audioValues.add(opt[0]);
                    audioLabels.add(opt[1] + " (" + aCnt + ")");
                }
            } else {
                audioValues.add(opt[0]);
                audioLabels.add(opt[1]);
            }
        }
        setSpinnerItems(spinAudio, audioLabels);
        spinAudio.setSelection(Math.max(0, audioValues.indexOf(currentFilter.audio)), false);

        // 5. Language Spinner
        langValues.clear();
        List<String> langLabels = new ArrayList<>();
        langValues.add(""); langLabels.add("All Languages");
        List<Models.LanguageCount> langSrc = facets != null ? facets.languages : latestStats.languages;
        for (Models.LanguageCount lc : langSrc) {
            langValues.add(lc.lang);
            langLabels.add(lc.lang + " (" + lc.count + ")");
        }
        if (!currentFilter.language.isEmpty() && !langValues.contains(currentFilter.language)) {
            langValues.add(1, currentFilter.language);
            langLabels.add(1, currentFilter.language + " (0)");
        }
        setSpinnerItems(spinLanguage, langLabels);
        spinLanguage.setSelection(Math.max(0, langValues.indexOf(currentFilter.language)), false);

        // 6. Server Spinner (dynamic active + custom servers)
        serverValues.clear();
        List<String> serverLabels = new ArrayList<>();
        serverValues.add(""); serverLabels.add("All Servers");

        java.util.Map<String, String> dynamicSrvMap = new java.util.LinkedHashMap<>();
        List<Models.ServerFilterOption> dynOpts = cachedServerFilterOptions;
        if (dynOpts != null && !dynOpts.isEmpty()) {
            for (Models.ServerFilterOption o : dynOpts) {
                dynamicSrvMap.put(o.value, o.label);
            }
        } else {
            dynamicSrvMap.put("dhakaflix", "DhakaFlix");
            dynamicSrvMap.put("icc", "ICC FTP");
            dynamicSrvMap.put("circleftp", "CircleFTP");
            dynamicSrvMap.put("discoveryftp", "DiscoveryFTP");
        }
        if (facets != null) {
            for (String srcKey : facets.sources.keySet()) {
                if (!dynamicSrvMap.containsKey(srcKey)) {
                    dynamicSrvMap.put(srcKey, ServerConfig.serverDisplayName(srcKey, ""));
                }
            }
        }
        if (!currentFilter.source.isEmpty() && !dynamicSrvMap.containsKey(currentFilter.source)) {
            dynamicSrvMap.put(currentFilter.source, ServerConfig.serverDisplayName(currentFilter.source, ""));
        }

        for (java.util.Map.Entry<String, String> e : dynamicSrvMap.entrySet()) {
            String key = e.getKey();
            String lbl = e.getValue();
            if (facets != null) {
                int sCnt = facets.sources.containsKey(key) ? facets.sources.get(key) : 0;
                if (sCnt > 0 || key.equals(currentFilter.source)) {
                    serverValues.add(key);
                    serverLabels.add(lbl + " (" + sCnt + ")");
                }
            } else {
                serverValues.add(key);
                serverLabels.add(lbl);
            }
        }
        setSpinnerItems(spinServer, serverLabels);
        spinServer.setSelection(Math.max(0, serverValues.indexOf(currentFilter.source)), false);

        // 7. Sort Spinner
        sortValues.clear();
        List<String> sortLabels = new ArrayList<>();
        if (currentTab == 4) { sortValues.add("relevance"); sortLabels.add("Best Match"); }
        sortValues.add("recent"); sortLabels.add("Recently Added");
        sortValues.add("quality"); sortLabels.add("Highest Quality");
        sortValues.add("year"); sortLabels.add("Release Year");
        sortValues.add("title"); sortLabels.add("Title (A-Z)");
        sortValues.add("imdb"); sortLabels.add("IMDb Rank");
        sortValues.add("oldest"); sortLabels.add("Oldest First");
        setSpinnerItems(spinSort, sortLabels);
        spinSort.setSelection(Math.max(0, sortValues.indexOf(currentFilter.sort)), false);

        int cnt = currentFilter.activeFilterCount();
        filterHeaderText.setText(cnt > 0 ? "Filters (" + cnt + " active)" : "Filters");
        btnResetFilters.setVisibility(cnt > 0 ? View.VISIBLE : View.GONE);

        uiHandler.post(() -> suppressSpinnerEvents = false);
    }

    private void addCategoryChip(String label, String catId, boolean selected) {
        Chip chip = new Chip(this);
        chip.setText(label);
        chip.setCheckable(true);
        chip.setChecked(selected);
        chip.setTextColor(0xFFF3F6FC);
        chip.setOnClickListener(v -> {
            currentFilter.category = catId;
            if ("imdb-top-250".equals(catId)) currentFilter.sort = "imdb";
            else if ("imdb".equals(currentFilter.sort)) currentFilter.sort = (currentTab == 4 ? "relevance" : "recent");
            currentFilter.page = 1;
            populateFilterControls();
            loadBrowse();
        });
        UiHelper.applyTvFocusEffect(chip, 1.05f);
        filterCategoryChips.addView(chip);
    }

    private void switchTab(int tabIndex, String category, String year, String sort) {
        if (!isPoppingBackStack && tabIndex != currentTab) {
            if (tabIndex == 0) {
                tabBackStack.clear();
            } else if (currentTab != 4) {
                if (tabBackStack.isEmpty() || tabBackStack.peek() != currentTab) {
                    tabBackStack.push(currentTab);
                    while (tabBackStack.size() > 20) tabBackStack.removeLast();
                }
            }
        }
        lastHomeBackPressMs = 0L;
        if (tabIndex != 4) latestSearchFacets = null;
        currentTab = tabIndex;
        updateTopNavStyles();
        if (tabIndex == 0) {
            bottomNav.getMenu().findItem(R.id.nav_home).setChecked(true);
            showActiveTabView();
            loadHome(false);
        } else if (tabIndex == 1 || tabIndex == 2) {
            bottomNav.getMenu().findItem(tabIndex == 1 ? R.id.nav_movies : R.id.nav_series).setChecked(true);
            currentFilter = new Models.BrowseFilter();
            currentFilter.group = tabIndex == 1 ? "movies" : "series";
            currentFilter.category = category == null ? "" : category;
            currentFilter.year = year == null ? "" : year;
            currentFilter.sort = sort == null || sort.isEmpty() ? "recent" : sort;
            currentFilter.limit = 36;
            showActiveTabView();
            populateFilterControls();
            loadBrowse();
        } else if (tabIndex == 3) {
            bottomNav.getMenu().findItem(R.id.nav_mylist).setChecked(true);
            showActiveTabView();
            loadMyList();
            startDownloadsPolling();
        } else if (tabIndex == 5) {
            uiHandler.removeCallbacks(downloadsPollRunnable);
            bottomNav.getMenu().findItem(R.id.nav_servers).setChecked(true);
            showActiveTabView();
            loadServersTab(app.repository.getSyncProgress().serverHealth.isEmpty());
        }
        if (tabIndex != 3) {
            uiHandler.removeCallbacks(downloadsPollRunnable);
        }
    }

    private void startDownloadsPolling() {
        uiHandler.removeCallbacks(downloadsPollRunnable);
        uiHandler.postDelayed(downloadsPollRunnable, 1000L);
    }

    private void showActiveTabView() {
        homeSwipe.setVisibility(currentTab == 0 ? View.VISIBLE : View.GONE);
        browseContainer.setVisibility((currentTab == 1 || currentTab == 2 || currentTab == 4) ? View.VISIBLE : View.GONE);
        myListContainer.setVisibility(currentTab == 3 ? View.VISIBLE : View.GONE);
        serversContainer.setVisibility(currentTab == 5 ? View.VISIBLE : View.GONE);
    }

    private void loadHome(boolean initialBootstrap) {
        app.ioExecutor.execute(() -> {
            Models.HomeFeed feed = app.repository.loadHomeFeed();
            cachedServerFilterOptions = app.repository.db.getServerFilterOptions();
            boolean iccOnline = false;
            boolean hasAnyOnlineServer = false;
            for (Models.ManagedServer s : app.repository.db.getEnabledServers()) {
                if (s.online) {
                    hasAnyOnlineServer = true;
                    if ("icc".equals(s.adapter)) iccOnline = true;
                }
            }
            boolean shouldAutoSync = initialBootstrap && feed.stats.total > 0 && app.repository.isAutoSyncDue();
            final boolean finalIccOnline = iccOnline;
            final boolean finalHasAnyOnline = hasAnyOnlineServer;
            uiHandler.post(() -> {
                homeFeed = feed;
                latestStats = feed.stats;
                updateSyncChipCount();

                boolean empty = feed.sections.isEmpty();
                homeEmptyBox.setVisibility(empty ? View.VISIBLE : View.GONE);
                heroContainer.setVisibility(!feed.hero.isEmpty() ? View.VISIBLE : View.GONE);
                if (!feed.hero.isEmpty()) renderHero();

                cwSection.setVisibility(!feed.continueWatching.isEmpty() ? View.VISIBLE : View.GONE);
                cwAdapter.submitList(feed.continueWatching);
                homeSectionsAdapter.submitList(feed.sections);

                if (UiHelper.isAndroidTv(MainActivity.this) && !initialTvFocusRequested && currentTab == 0) {
                    initialTvFocusRequested = true;
                    if (!feed.hero.isEmpty() && btnHeroPlay != null) {
                        btnHeroPlay.post(() -> btnHeroPlay.requestFocus());
                    } else if (empty) {
                        View syncBtn = findViewById(R.id.btn_home_sync_now);
                        if (syncBtn != null) syncBtn.post(syncBtn::requestFocus);
                    }
                }

                if (initialBootstrap && finalHasAnyOnline) {
                    int iccCount = feed.stats.bySource.containsKey("icc") ? feed.stats.bySource.get("icc") : 0;
                    if (feed.stats.total == 0) {
                        triggerSync("full", false);
                    } else if (finalIccOnline && iccCount < 500) {
                        uiHandler.postDelayed(() -> triggerSync("full", true), 2500L);
                    } else if (shouldAutoSync || app.repository.isAutoSyncEnabled()) {
                        uiHandler.postDelayed(() -> triggerSync("quick", true), 3500L);
                    } else {
                        app.ioExecutor.execute(() -> app.repository.checkAllServersHealth());
                    }
                }
            });
        });
    }

    private void renderHero() {
        if (homeFeed == null || homeFeed.hero.isEmpty()) return;
        Models.MediaSummary active = homeFeed.hero.get(heroIndex % homeFeed.hero.size());
        ServerConfig.CategoryDef cat = ServerConfig.CATEGORY_BY_ID.get(active.category);
        heroKicker.setText("FEATURED LATEST · " + (cat != null ? cat.shortLabel.toUpperCase(Locale.US) : active.category.toUpperCase(Locale.US)));
        heroTitle.setText(active.title);
        List<String> metaParts = new ArrayList<>();
        if (active.year != null) metaParts.add(String.valueOf(active.year));
        if (active.quality != null) metaParts.add(active.quality);
        if (active.audioTags != null) metaParts.add(active.audioTags);
        if (active.languageTag != null) metaParts.add(active.languageTag);
        heroMeta.setText(String.join(" · ", metaParts));
        UiHelper.loadPoster(heroBackdrop, active.posterUrl);
        btnHeroWatchlist.setText(active.inWatchlist ? "OK" : "+");

        btnHeroPlay.setOnClickListener(v -> openDetail(active, true));
        btnHeroDetails.setOnClickListener(v -> openDetail(active, false));
        btnHeroWatchlist.setOnClickListener(v -> app.ioExecutor.execute(() -> {
            app.repository.db.toggleWatchlist(active.id);
            uiHandler.post(() -> loadHome(false));
        }));

        heroDots.removeAllViews();
        for (int i = 0; i < homeFeed.hero.size(); i++) {
            final int idx = i;
            View dot = new View(this);
            boolean isActive = idx == (heroIndex % homeFeed.hero.size());
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    UiHelper.dp(this, isActive ? 24 : 12), UiHelper.dp(this, 4));
            lp.setMargins(UiHelper.dp(this, 3), 0, UiHelper.dp(this, 3), 0);
            dot.setLayoutParams(lp);
            dot.setFocusable(false);
            dot.setBackgroundColor(isActive ? 0xFFE50914 : 0x44FFFFFF);
            dot.setOnClickListener(v -> { heroIndex = idx; renderHero(); });
            heroDots.addView(dot);
        }
    }

    private void loadBrowse() {
        Models.BrowseFilter snap = currentFilter.copy();
        final int targetTab = currentTab;
        final int seq = browseRequestSeq.incrementAndGet();
        if (targetTab == 1) browseTitle.setText("Movies Library");
        else if (targetTab == 2) browseTitle.setText("TV Series, Anime & Shows");
        else browseTitle.setText("Search: \"" + snap.query + "\"");

        int cnt = snap.activeFilterCount();
        filterHeaderText.setText(cnt > 0 ? "Filters (" + cnt + " active)" : "Filters");
        btnResetFilters.setVisibility(cnt > 0 ? View.VISIBLE : View.GONE);

        app.ioExecutor.execute(() -> {
            Models.BrowsePageResult res = app.repository.db.queryItems(snap);
            uiHandler.post(() -> {
                if (seq != browseRequestSeq.get() || isFinishing() || isDestroyed()) return;
                browseCount.setText(res.total + " title" + (res.total == 1 ? "" : "s") + " found");
                browseEmpty.setVisibility(res.items.isEmpty() ? View.VISIBLE : View.GONE);
                browseAdapter.submitList(res.items);
                if (res.page == 1 && browseRv != null) {
                    browseRv.scrollToPosition(0);
                }
                if (res.totalPages > 1) {
                    browsePagination.setVisibility(View.VISIBLE);
                    pageIndicator.setText("Page " + res.page + " of " + res.totalPages);
                    btnPrevPage.setEnabled(res.page > 1);
                    btnNextPage.setEnabled(res.page < res.totalPages);
                } else {
                    browsePagination.setVisibility(View.GONE);
                }
                if (targetTab == 4 && currentTab == 4 && res.facets != null && res.facets != latestSearchFacets) {
                    latestSearchFacets = res.facets;
                    populateFilterControls();
                }
            });
        });
    }

    private void loadMyList() {
        app.ioExecutor.execute(() -> {
            List<Models.DownloadStatusItem> downloads = MediaDownloadManager.queryLiveDownloads(this, app.repository.db);
            List<Models.MediaSummary> hist = app.repository.db.getContinueWatching(40);
            List<Models.MediaSummary> wl = app.repository.db.getWatchlist();
            uiHandler.post(() -> {
                renderDownloadsList(downloads);
                myListHistorySection.setVisibility(hist.isEmpty() ? View.GONE : View.VISIBLE);
                myListHistoryTitle.setText("Recently Watched (" + hist.size() + ")");
                myListHistoryAdapter.submitList(hist);

                myListWlTitle.setText("Saved Watchlist (" + wl.size() + ")");
                btnClearWatchlist.setVisibility(wl.isEmpty() ? View.GONE : View.VISIBLE);
                myListWlEmpty.setVisibility(wl.isEmpty() ? View.VISIBLE : View.GONE);
                myListWlAdapter.submitList(wl);
            });
        });
    }

    private void refreshDownloadsSectionOnly() {
        app.ioExecutor.execute(() -> {
            List<Models.DownloadStatusItem> downloads = MediaDownloadManager.queryLiveDownloads(this, app.repository.db);
            uiHandler.post(() -> renderDownloadsList(downloads));
        });
    }

    private void renderDownloadsList(List<Models.DownloadStatusItem> items) {
        if (myListDownloadsList == null) return;
        int total = items != null ? items.size() : 0;
        int activeCount = 0;
        boolean hasClearable = false;
        if (items != null) {
            for (Models.DownloadStatusItem it : items) {
                if (it.active) activeCount++;
                if (it.completed || it.failed) hasClearable = true;
            }
        }
        myListDownloadsTitle.setText("Current Downloads (" + total + ")");
        if (activeCount > 0) {
            myListDownloadsActiveBadge.setVisibility(View.VISIBLE);
            myListDownloadsActiveBadge.setText(activeCount + " active");
        } else {
            myListDownloadsActiveBadge.setVisibility(View.GONE);
        }
        btnClearCompletedDownloads.setVisibility(hasClearable ? View.VISIBLE : View.GONE);
        myListDownloadsEmpty.setVisibility(total == 0 ? View.VISIBLE : View.GONE);

        myListDownloadsList.removeAllViews();
        if (items == null || items.isEmpty()) return;

        for (Models.DownloadStatusItem item : items) {
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            int p = UiHelper.dp(this, 12);
            card.setPadding(p, p, p, p);
            int stroke = item.active ? 0x6638BDF8 : (item.completed ? 0x5522C55E : 0x44EF4444);
            card.setBackground(UiHelper.outlineBoxDrawable(stroke, 0xFF0D1220));
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            clp.bottomMargin = UiHelper.dp(this, 10);
            card.setLayoutParams(clp);

            LinearLayout header = new LinearLayout(this);
            header.setOrientation(LinearLayout.HORIZONTAL);
            header.setGravity(android.view.Gravity.CENTER_VERTICAL);

            TextView tvTitle = new TextView(this);
            String titleTxt = item.record.title;
            if (item.record.episodeLabel != null && !item.record.episodeLabel.isEmpty()) {
                titleTxt += " · " + item.record.episodeLabel;
            }
            tvTitle.setText(titleTxt);
            tvTitle.setTextColor(0xFFF3F6FC);
            tvTitle.setTextSize(13.5f);
            tvTitle.setTypeface(null, android.graphics.Typeface.BOLD);
            tvTitle.setMaxLines(1);
            tvTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
            tvTitle.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            header.addView(tvTitle);

            TextView tvStatus = new TextView(this);
            tvStatus.setText(item.statusLabel);
            tvStatus.setTextSize(11.5f);
            tvStatus.setTypeface(null, android.graphics.Typeface.BOLD);
            tvStatus.setPadding(UiHelper.dp(this, 8), 0, 0, 0);
            tvStatus.setTextColor(item.completed ? 0xFF22C55E : (item.active ? 0xFF38BDF8 : 0xFFEF4444));
            header.addView(tvStatus);
            card.addView(header);

            TextView tvSub = new TextView(this);
            List<String> subParts = new ArrayList<>();
            if (item.record.quality != null && !item.record.quality.isEmpty()) subParts.add(item.record.quality);
            if (item.record.serverLabel != null && !item.record.serverLabel.isEmpty()) subParts.add(item.record.serverLabel);
            if (item.totalBytes > 0) {
                if (item.completed) subParts.add(Models.formatBytes(item.totalBytes));
                else subParts.add(Models.formatBytes(item.downloadedBytes) + " / " + Models.formatBytes(item.totalBytes));
            } else if (item.downloadedBytes > 0) {
                subParts.add(Models.formatBytes(item.downloadedBytes) + " downloaded");
            }
            if (item.record.wifiOnly) subParts.add("Wi-Fi only");
            subParts.add(MediaDownloadManager.saveLocationHint());
            tvSub.setText(String.join(" · ", subParts));
            tvSub.setTextColor(0xFF94A3B8);
            tvSub.setTextSize(11.5f);
            tvSub.setPadding(0, UiHelper.dp(this, 3), 0, UiHelper.dp(this, 6));
            card.addView(tvSub);

            ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
            bar.setMax(100);
            bar.setIndeterminate(item.active && item.totalBytes <= 0 && item.percent == 0);
            bar.setProgress(item.percent);
            bar.setProgressTintList(android.content.res.ColorStateList.valueOf(
                    item.completed ? 0xFF22C55E : (item.active ? 0xFF38BDF8 : 0xFFEF4444)));
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, UiHelper.dp(this, 6));
            blp.bottomMargin = UiHelper.dp(this, 8);
            bar.setLayoutParams(blp);
            card.addView(bar);

            LinearLayout actions = new LinearLayout(this);
            actions.setOrientation(LinearLayout.HORIZONTAL);
            actions.setGravity(android.view.Gravity.END);

            if (item.completed && item.localUri != null && !item.localUri.isEmpty()) {
                MaterialButton playOfflineBtn = new MaterialButton(this);
                playOfflineBtn.setText("Play Offline");
                playOfflineBtn.setAllCaps(false);
                playOfflineBtn.setBackgroundColor(0xFFE50914);
                playOfflineBtn.setTextColor(0xFFFFFFFF);
                playOfflineBtn.setTextSize(12f);
                LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT, UiHelper.dp(this, 36));
                plp.rightMargin = UiHelper.dp(this, 8);
                playOfflineBtn.setLayoutParams(plp);
                playOfflineBtn.setOnClickListener(v -> playDownloadedOffline(item));
                UiHelper.applyTvFocusEffect(playOfflineBtn, 1.05f);
                actions.addView(playOfflineBtn);
            } else if (item.failed && ServerConfig.isAllowedUrl(item.record.url)) {
                MaterialButton retryBtn = new MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
                retryBtn.setText("Retry");
                retryBtn.setAllCaps(false);
                retryBtn.setTextSize(12f);
                LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT, UiHelper.dp(this, 36));
                rlp.rightMargin = UiHelper.dp(this, 8);
                retryBtn.setLayoutParams(rlp);
                retryBtn.setOnClickListener(v -> app.ioExecutor.execute(() -> {
                    MediaDownloadManager.cancelOrRemoveDownload(MainActivity.this, app.repository.db, item.record.downloadId);
                    Models.MediaFileEntry fe = new Models.MediaFileEntry(
                            item.record.fileName, item.record.url, "video", "", item.record.totalBytes, 0,
                            null, 1, item.record.episodeLabel != null ? item.record.episodeLabel : "",
                            "", item.record.quality, true);
                    MediaDownloadManager.enqueueMediaDownload(MainActivity.this, app.repository.db,
                            item.record.mediaId, item.record.title, fe, item.record.quality,
                            item.record.serverLabel, item.record.seasonName, item.record.wifiOnly,
                            Collections.emptyList());
                    uiHandler.post(this::refreshDownloadsSectionOnly);
                }));
                UiHelper.applyTvFocusEffect(retryBtn, 1.05f);
                actions.addView(retryBtn);
            }

            MaterialButton removeBtn = new MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
            removeBtn.setText(item.active ? "Cancel" : "Remove");
            removeBtn.setAllCaps(false);
            removeBtn.setTextColor(0xFFFCA5A5);
            removeBtn.setTextSize(12f);
            removeBtn.setLayoutParams(new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, UiHelper.dp(this, 36)));
            removeBtn.setOnClickListener(v -> app.ioExecutor.execute(() -> {
                MediaDownloadManager.cancelOrRemoveDownload(MainActivity.this, app.repository.db, item.record.downloadId);
                uiHandler.post(this::refreshDownloadsSectionOnly);
            }));
            UiHelper.applyTvFocusEffect(removeBtn, 1.05f);
            actions.addView(removeBtn);

            card.addView(actions);
            myListDownloadsList.addView(card);
        }
    }

    private void playDownloadedOffline(Models.DownloadStatusItem item) {
        if (item == null || item.localUri == null || item.localUri.isEmpty()) return;
        Models.MediaFileEntry localFile = new Models.MediaFileEntry(
                item.record.fileName, item.localUri, "video", "", item.totalBytes, 0,
                null, 1, item.record.episodeLabel != null ? item.record.episodeLabel : "",
                "", item.record.quality, true);
        Models.PlaybackSession session = new Models.PlaybackSession(
                item.record.mediaId, item.record.title, localFile, Collections.emptyList(),
                item.record.seasonName, Collections.emptyList(), 0,
                item.record.quality != null ? item.record.quality : "Offline",
                "Downloaded Offline", Collections.emptyList(), 0);
        Intent i = new Intent(this, PlayerActivity.class);
        i.putExtra(PlayerActivity.EXTRA_SESSION, session);
        startActivity(i);
    }

    private void loadServersTab(boolean triggerPing) {
        app.ioExecutor.execute(() -> {
            Models.LibraryStats st = app.repository.db.getLibraryStats(false);
            cachedServerFilterOptions = app.repository.db.getServerFilterOptions();
            List<Models.ManagedServer> allServers = app.repository.db.getAllServers();
            boolean autoEnabled = app.repository.isAutoSyncEnabled();
            int intervalMin = app.repository.getAutoSyncIntervalMinutes();

            // Merge persisted server list with latest live ping statuses
            java.util.Map<String, Models.ServerHealth> lastById = new java.util.HashMap<>();
            for (Models.ServerHealth h : app.repository.getLastServerHealth()) {
                if (h != null && h.node != null) lastById.put(h.node.id, h);
            }
            List<Models.ServerHealth> merged = new ArrayList<>();
            for (Models.ManagedServer srv : allServers) {
                Models.ServerHealth prev = lastById.get(srv.id);
                if (!srv.enabled) {
                    merged.add(new Models.ServerHealth(srv.toServerNode(), false, null, "Disabled", srv));
                } else if (prev != null) {
                    merged.add(new Models.ServerHealth(srv.toServerNode(), prev.online, prev.latencyMs, prev.reason, srv));
                } else if (app.repository.hasCheckedHealthOnce()) {
                    merged.add(new Models.ServerHealth(srv.toServerNode(), srv.online, null,
                            srv.online ? "Online" : "Offline", srv));
                } else {
                    merged.add(new Models.ServerHealth(srv.toServerNode(), false, null, "Not pinged yet", srv));
                }
            }

            uiHandler.post(() -> {
                latestStats = st;
                updateSyncChipCount();
                if (srvMetricTotal != null) srvMetricTotal.setText(String.format(Locale.US, "%,d", st.total));
                if (srvMetricMovies != null) srvMetricMovies.setText(String.format(Locale.US, "%,d", st.movies));
                if (srvMetricSeries != null) srvMetricSeries.setText(String.format(Locale.US, "%,d", st.series));
                srvStatsDups.setText(String.format(Locale.US, "Duplicates merged (highest quality kept): %,d (from %,d active)",
                        st.duplicatesMerged, st.totalRaw));
                List<String> srcParts = new ArrayList<>();
                for (java.util.Map.Entry<String, Integer> e : st.bySource.entrySet()) {
                    if (e.getValue() != null && e.getValue() > 0) {
                        srcParts.add(String.format(Locale.US, "%s: %,d",
                                ServerConfig.serverDisplayName(e.getKey(), ""), e.getValue()));
                    }
                }
                srvStatsSources.setText(srcParts.isEmpty() ? "No active titles visible" : String.join(" · ", srcParts));

                if (st.lastSync != null && st.lastSync > 0) {
                    SimpleDateFormat sdf = new SimpleDateFormat("MMM d, hh:mm a", Locale.US);
                    srvLastSyncText.setText("Last synced: " + sdf.format(new Date(st.lastSync)));
                } else {
                    srvLastSyncText.setText("Last synced: Not yet completed");
                }

                suppressAutoSyncUiEvents = true;
                switchAutoSync.setChecked(autoEnabled);
                int selIdx = 2;
                for (int i = 0; i < AUTO_SYNC_INTERVAL_MINS.length; i++) {
                    if (AUTO_SYNC_INTERVAL_MINS[i] == intervalMin) { selIdx = i; break; }
                }
                spinAutoSyncInterval.setSelection(selIdx);
                suppressAutoSyncUiEvents = false;

                renderServersSyncProgress(app.repository.getSyncProgress());
                renderBdixScanProgress(app.repository.bdixScanner.getProgress());
                renderServersHealthList(merged);
                if (availableUpdate != null) renderUpdateCard(availableUpdate);
                if (triggerPing) pingAllServersIntoTab();
            });
        });
    }

    private void renderServersSyncProgress(Models.SyncProgress p) {
        if (btnSrvSyncQuick == null) return;
        btnSrvSyncQuick.setEnabled(!p.running);
        btnSrvSyncFull.setEnabled(!p.running);
        if (p.running) {
            srvSyncLabel.setVisibility(View.VISIBLE);
            srvSyncLabel.setTextColor(0xFF38BDF8);
            srvSyncLabel.setText(p.currentLabel + " (" + p.percent + "%)");
            srvSyncBar.setVisibility(View.VISIBLE);
            srvSyncBar.setProgress(p.percent);
        } else {
            srvSyncBar.setVisibility(View.GONE);
            if (p.currentLabel != null && !p.currentLabel.isEmpty()) {
                srvSyncLabel.setVisibility(View.VISIBLE);
                srvSyncLabel.setTextColor(0xFF22C55E);
                srvSyncLabel.setText(p.currentLabel);
            } else {
                srvSyncLabel.setVisibility(View.GONE);
            }
        }
        if (p.errors != null && !p.errors.isEmpty()) {
            srvSyncErrors.setVisibility(View.VISIBLE);
            StringBuilder sb = new StringBuilder();
            int cap = Math.min(3, p.errors.size());
            for (int i = 0; i < cap; i++) {
                if (i > 0) sb.append('\n');
                sb.append("- ").append(p.errors.get(i));
            }
            if (p.errors.size() > cap) sb.append("\n(+").append(p.errors.size() - cap).append(" more)");
            srvSyncErrors.setText(sb.toString());
        } else {
            srvSyncErrors.setVisibility(View.GONE);
        }
        if (!p.serverHealth.isEmpty()) {
            renderServersHealthList(p.serverHealth);
        }
    }

    private void pingAllServersIntoTab() {
        btnSrvPingAll.setEnabled(false);
        btnSrvPingAll.setText("Pinging...");
        app.ioExecutor.execute(() -> {
            lastHealthReprobeMs = System.currentTimeMillis();
            List<Models.ServerHealth> health = app.repository.checkAllServersHealth();
            cachedServerFilterOptions = app.repository.db.getServerFilterOptions();
            uiHandler.post(() -> {
                btnSrvPingAll.setEnabled(true);
                btnSrvPingAll.setText("Ping All");
                renderServersHealthList(health);
                loadServersTab(false);
                loadHome(false);
            });
        });
    }

    private void renderServersHealthList(List<Models.ServerHealth> health) {
        srvHealthList.removeAllViews();
        int total = health != null ? health.size() : 0;
        int enabledCount = 0;
        int onlineCount = 0;
        int hiddenCount = 0;
        if (health != null) {
            for (Models.ServerHealth h : health) {
                boolean en = h.managedServer == null || h.managedServer.enabled;
                if (en) {
                    enabledCount++;
                    if (h.online) onlineCount++;
                } else {
                    hiddenCount++;
                }
            }
        }
        if (srvListHeaderTitle != null) {
            srvListHeaderTitle.setText("Connected FTP Servers (" + enabledCount + "/" + total + ")");
        }
        if (srvListStatusStrip != null) {
            String strip = onlineCount + " Online · " + enabledCount + " Active";
            if (hiddenCount > 0) strip += " · " + hiddenCount + " Hidden";
            srvListStatusStrip.setText(strip);
        }
        if (health == null || health.isEmpty()) {
            TextView tv = new TextView(this);
            tv.setText("No servers configured. Tap + Add Server or Defaults above to connect FTP servers.");
            tv.setTextColor(0xFF94A3B8);
            tv.setTextSize(12.5f);
            tv.setPadding(0, UiHelper.dp(this, 8), 0, UiHelper.dp(this, 8));
            srvHealthList.addView(tv);
            return;
        }
        boolean syncRunning = app.repository.getSyncProgress().running;
        for (Models.ServerHealth h : health) {
            final Models.ManagedServer srv = h.managedServer;
            final boolean isEnabled = srv == null || srv.enabled;
            final boolean isCustom = srv != null && !srv.isBuiltin;
            final int itemCount = srv != null ? srv.itemCount : 0;
            int customFolderCount = 0;
            if (isCustom && srv.foldersJson != null && !srv.foldersJson.isEmpty()) {
                try { customFolderCount = new org.json.JSONArray(srv.foldersJson).length(); } catch (Exception ignored) {}
            }

            final int accentColor = !isEnabled ? 0xFF475569
                    : (h.online ? 0xFF22C55E : ("Not pinged yet".equals(h.reason) ? 0xFF38BDF8
                    : (h.node.optional ? 0xFFF59E0B : 0xFFEF4444)));
            final int pillBgColor = !isEnabled ? 0x2294A3B8
                    : (h.online ? 0x2222C55E : ("Not pinged yet".equals(h.reason) ? 0x2238BDF8
                    : (h.node.optional ? 0x22F59E0B : 0x24EF4444)));

            // Outer horizontal card wrapper with left colored status accent bar
            LinearLayout cardWrap = new LinearLayout(this);
            cardWrap.setOrientation(LinearLayout.HORIZONTAL);
            cardWrap.setBackground(UiHelper.outlineBoxDrawable(isEnabled ? 0x22FFFFFF : 0x14FFFFFF, 0xFF0B111E));
            cardWrap.setAlpha(isEnabled ? 1f : 0.72f);
            LinearLayout.LayoutParams wlp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            wlp.bottomMargin = UiHelper.dp(this, 10);
            cardWrap.setLayoutParams(wlp);

            View accentBar = new View(this);
            accentBar.setBackgroundColor(accentColor);
            accentBar.setLayoutParams(new LinearLayout.LayoutParams(
                    UiHelper.dp(this, 4), LinearLayout.LayoutParams.MATCH_PARENT));
            cardWrap.addView(accentBar);

            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            int pad = UiHelper.dp(this, 11);
            card.setPadding(pad, pad, pad, UiHelper.dp(this, 9));
            card.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            cardWrap.addView(card);

            // Top row: Name + Custom tag + tinted Status Pill
            LinearLayout topRow = new LinearLayout(this);
            topRow.setOrientation(LinearLayout.HORIZONTAL);
            topRow.setGravity(android.view.Gravity.CENTER_VERTICAL);

            LinearLayout left = new LinearLayout(this);
            left.setOrientation(LinearLayout.VERTICAL);
            left.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

            TextView name = new TextView(this);
            name.setText(isCustom ? (h.node.name + "  ·  CUSTOM") : h.node.name);
            name.setTextColor(0xFFF3F6FC);
            name.setTextSize(13.5f);
            name.setTypeface(null, android.graphics.Typeface.BOLD);
            name.setMaxLines(1);
            name.setEllipsize(android.text.TextUtils.TruncateAt.END);
            left.addView(name);

            TextView urlTv = new TextView(this);
            StringBuilder urlSb = new StringBuilder(h.node.origin);
            if (h.node.rootHref != null && !"/".equals(h.node.rootHref)) {
                urlSb.append(com.cinevault.app.data.MediaParser.safeDecode(h.node.rootHref));
            }
            urlTv.setText(urlSb.toString());
            urlTv.setTextColor(0xFF64748B);
            urlTv.setTextSize(11f);
            urlTv.setMaxLines(1);
            urlTv.setEllipsize(android.text.TextUtils.TruncateAt.END);
            left.addView(urlTv);

            TextView statusPill = new TextView(this);
            statusPill.setTextSize(11f);
            statusPill.setTypeface(null, android.graphics.Typeface.BOLD);
            statusPill.setPadding(UiHelper.dp(this, 8), UiHelper.dp(this, 3), UiHelper.dp(this, 8), UiHelper.dp(this, 3));
            android.graphics.drawable.GradientDrawable pillBg = new android.graphics.drawable.GradientDrawable();
            pillBg.setColor(pillBgColor);
            pillBg.setCornerRadius(UiHelper.dp(this, 99));
            statusPill.setBackground(pillBg);
            LinearLayout.LayoutParams splp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            splp.leftMargin = UiHelper.dp(this, 8);
            statusPill.setLayoutParams(splp);

            if (!isEnabled) {
                statusPill.setText("Hidden");
                statusPill.setTextColor(0xFF94A3B8);
            } else if (h.online) {
                statusPill.setText((h.latencyMs != null ? h.latencyMs : 0) + "ms");
                statusPill.setTextColor(0xFF22C55E);
            } else if ("Not pinged yet".equals(h.reason)) {
                statusPill.setText("Active");
                statusPill.setTextColor(0xFF38BDF8);
            } else if (h.node.optional) {
                statusPill.setText("Upstream");
                statusPill.setTextColor(0xFFF59E0B);
            } else {
                statusPill.setText("Offline");
                statusPill.setTextColor(0xFFFCA5A5);
            }

            topRow.addView(left);
            topRow.addView(statusPill);
            card.addView(topRow);

            // Middle metadata line (indexed count, custom folder count, hidden/error note)
            List<String> metaParts = new ArrayList<>();
            if (itemCount > 0) metaParts.add(String.format(Locale.US, "%,d indexed", itemCount));
            if (customFolderCount > 0) metaParts.add(customFolderCount + " folder" + (customFolderCount == 1 ? "" : "s"));
            if (!isEnabled) metaParts.add("Disabled — files hidden");
            else if (!h.online) {
                if ("Not pinged yet".equals(h.reason)) {
                    metaParts.add("Checking reachability...");
                } else {
                    metaParts.add("Offline — content hidden" + (h.reason != null && !h.reason.isEmpty() ? " (" + h.reason + ")" : ""));
                }
            }
            if (!metaParts.isEmpty()) {
                TextView metaTv = new TextView(this);
                metaTv.setText(String.join(" · ", metaParts));
                metaTv.setTextColor(isEnabled ? 0xFF94A3B8 : 0xFF64748B);
                metaTv.setTextSize(11.2f);
                metaTv.setPadding(0, UiHelper.dp(this, 5), 0, 0);
                card.addView(metaTv);
            }

            if (srv != null) {
                View div = new View(this);
                div.setBackgroundColor(0x14FFFFFF);
                LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, UiHelper.dp(this, 1));
                dlp.topMargin = UiHelper.dp(this, 8);
                dlp.bottomMargin = UiHelper.dp(this, 4);
                div.setLayoutParams(dlp);
                card.addView(div);

                LinearLayout actionRow = new LinearLayout(this);
                actionRow.setOrientation(LinearLayout.HORIZONTAL);
                actionRow.setGravity(android.view.Gravity.CENTER_VERTICAL);

                MaterialSwitch toggle = new MaterialSwitch(this);
                toggle.setChecked(srv.enabled);
                toggle.setText(srv.enabled ? "Visible" : "Hidden");
                toggle.setTextColor(srv.enabled ? 0xFFCBD5E1 : 0xFF64748B);
                toggle.setTextSize(11.5f);
                toggle.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
                toggle.setOnCheckedChangeListener((bw, checked) -> {
                    toggle.setEnabled(false);
                    app.ioExecutor.execute(() -> {
                        app.repository.db.setServerEnabled(srv.id, checked);
                        if (checked) {
                            app.repository.checkAllServersHealth();
                        }
                        cachedServerFilterOptions = app.repository.db.getServerFilterOptions();
                        uiHandler.post(() -> {
                            Toast.makeText(MainActivity.this,
                                    srv.name + (checked ? " enabled — visible if online" : " disabled — files hidden"),
                                    Toast.LENGTH_SHORT).show();
                            loadHome(false);
                            loadServersTab(false);
                        });
                    });
                });
                actionRow.addView(toggle);

                if (srv.enabled) {
                    MaterialButton syncBtn = new MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
                    syncBtn.setText("Sync");
                    syncBtn.setAllCaps(false);
                    syncBtn.setTextSize(11.5f);
                    syncBtn.setTextColor(0xFF38BDF8);
                    syncBtn.setEnabled(!syncRunning);
                    LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.WRAP_CONTENT, UiHelper.dp(this, 34));
                    slp.rightMargin = UiHelper.dp(this, 6);
                    syncBtn.setLayoutParams(slp);
                    syncBtn.setOnClickListener(v -> triggerSyncForServer(srv));
                    UiHelper.applyTvFocusEffect(syncBtn, 1.05f);
                    actionRow.addView(syncBtn);
                }

                MaterialButton delBtn = new MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
                delBtn.setText("Remove");
                delBtn.setAllCaps(false);
                delBtn.setTextSize(11.5f);
                delBtn.setTextColor(0xFFFCA5A5);
                delBtn.setLayoutParams(new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT, UiHelper.dp(this, 34)));
                delBtn.setOnClickListener(v -> confirmDeleteServer(srv));
                UiHelper.applyTvFocusEffect(delBtn, 1.05f);
                actionRow.addView(delBtn);

                card.addView(actionRow);
            }

            srvHealthList.addView(cardWrap);
        }
    }

    private void startWifiBdixScan() {
        if (app.repository.bdixScanner.isRunning()) {
            Toast.makeText(this, "Wi-Fi BDIX server scan is already running...", Toast.LENGTH_SHORT).show();
            return;
        }
        Toast.makeText(this, "Scanning open BDIX servers on your Wi-Fi via bdix.link...", Toast.LENGTH_SHORT).show();
        app.ioExecutor.execute(() -> app.repository.bdixScanner.runWifiBdixScanAndSync(
                app.repository, true, () -> uiHandler.post(this::refreshVisibleTabAfterSync)));
    }

    private void renderBdixScanProgress(Models.BdixScanProgress p) {
        if (p == null || btnSrvBdixScan == null) return;
        btnSrvBdixScan.setEnabled(!p.running);
        if (p.running) {
            btnSrvBdixScan.setText(p.total > 0
                    ? String.format(Locale.US, "Testing %d/%d Servers (%d Open)...", p.tested, p.total, p.openCount)
                    : "Fetching BDIX Server List...");
        } else {
            btnSrvBdixScan.setText("Run Wi-Fi BDIX Server Test & Auto-Sync");
        }

        boolean showProgress = p.running || p.total > 0 || !p.message.isEmpty();
        if (srvBdixStatus != null) {
            srvBdixStatus.setVisibility(showProgress ? View.VISIBLE : View.GONE);
            srvBdixStatus.setTextColor("error".equals(p.phase) ? 0xFFFCA5A5 : ("done".equals(p.phase) ? 0xFF22C55E : 0xFF38BDF8));
            srvBdixStatus.setText(p.message);
        }
        if (srvBdixProgress != null) {
            srvBdixProgress.setVisibility(p.running ? View.VISIBLE : View.GONE);
            srvBdixProgress.setIndeterminate(p.total == 0);
            if (p.total > 0) srvBdixProgress.setProgress(p.percent());
        }
        if (srvBdixResults != null) {
            List<Models.BdixSiteResult> openOnly = new ArrayList<>();
            for (Models.BdixSiteResult r : p.results) {
                if (r.open) openOnly.add(r);
            }
            if (openOnly.isEmpty()) {
                srvBdixResults.setVisibility(View.GONE);
                srvBdixResults.removeAllViews();
            } else {
                srvBdixResults.setVisibility(View.VISIBLE);
                srvBdixResults.removeAllViews();
                int cap = Math.min(openOnly.size(), 16);
                for (int i = 0; i < cap; i++) {
                    Models.BdixSiteResult r = openOnly.get(i);
                    LinearLayout row = new LinearLayout(this);
                    row.setOrientation(LinearLayout.HORIZONTAL);
                    row.setGravity(android.view.Gravity.CENTER_VERTICAL);
                    row.setPadding(UiHelper.dp(this, 9), UiHelper.dp(this, 6), UiHelper.dp(this, 9), UiHelper.dp(this, 6));
                    row.setBackground(UiHelper.outlineBoxDrawable(r.syncable ? 0x4422C55E : 0x2238BDF8, 0xFF0A0F1D));
                    LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                    rlp.bottomMargin = UiHelper.dp(this, 5);
                    row.setLayoutParams(rlp);

                    LinearLayout col = new LinearLayout(this);
                    col.setOrientation(LinearLayout.VERTICAL);
                    col.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

                    TextView tvT = new TextView(this);
                    tvT.setText(r.title);
                    tvT.setTextColor(0xFFF3F6FC);
                    tvT.setTextSize(12f);
                    tvT.setTypeface(null, android.graphics.Typeface.BOLD);
                    tvT.setMaxLines(1);
                    tvT.setEllipsize(android.text.TextUtils.TruncateAt.END);
                    col.addView(tvT);

                    TextView tvU = new TextView(this);
                    tvU.setText(r.url);
                    tvU.setTextColor(0xFF64748B);
                    tvU.setTextSize(10.5f);
                    tvU.setMaxLines(1);
                    tvU.setEllipsize(android.text.TextUtils.TruncateAt.END);
                    col.addView(tvU);
                    row.addView(col);

                    TextView pill = new TextView(this);
                    String pillText = r.syncable
                            ? ("Synced · " + (r.latencyMs != null ? r.latencyMs : 0) + "ms")
                            : ("web-only".equals(r.status) ? "Web Portal" : ("Open · " + (r.latencyMs != null ? r.latencyMs : 0) + "ms"));
                    pill.setText(pillText);
                    pill.setTextColor(r.syncable ? 0xFF22C55E : 0xFF38BDF8);
                    pill.setTextSize(10.5f);
                    pill.setTypeface(null, android.graphics.Typeface.BOLD);
                    pill.setPadding(UiHelper.dp(this, 8), UiHelper.dp(this, 3), UiHelper.dp(this, 8), UiHelper.dp(this, 3));
                    android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
                    bg.setColor(r.syncable ? 0x2222C55E : 0x2238BDF8);
                    bg.setCornerRadius(UiHelper.dp(this, 99));
                    pill.setBackground(bg);
                    row.addView(pill);
                    srvBdixResults.addView(row);
                }
            }
        }
    }

    private void triggerSyncForServer(Models.ManagedServer srv) {
        Toast.makeText(this, "Syncing " + srv.name + "...", Toast.LENGTH_SHORT).show();
        app.ioExecutor.execute(() -> app.repository.runSync("full", false, srv.id,
                () -> uiHandler.post(this::refreshVisibleTabAfterSync)));
    }

    private void confirmDeleteServer(Models.ManagedServer srv) {
        new AlertDialog.Builder(this)
                .setTitle("Remove \"" + srv.name + "\"?")
                .setMessage("This removes the server from your list and deletes its indexed titles ("
                        + srv.itemCount + " items). Surviving mirrors on other servers stay intact. You can re-add it or restore defaults anytime.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Remove", (d, w) -> app.ioExecutor.execute(() -> {
                    int deleted = app.repository.db.deleteServerAndPurgeMedia(srv.id);
                    cachedServerFilterOptions = app.repository.db.getServerFilterOptions();
                    uiHandler.post(() -> {
                        Toast.makeText(MainActivity.this,
                                deleted > 0
                                        ? "Removed " + srv.name + " & cleaned " + deleted + " items"
                                        : "Removed " + srv.name,
                                Toast.LENGTH_SHORT).show();
                        loadHome(false);
                        loadServersTab(false);
                    });
                }))
                .show();
    }

    private void confirmResetDefaultServers() {
        new AlertDialog.Builder(this)
                .setTitle("Restore Default FTP Servers?")
                .setMessage("Re-adds and enables all built-in DhakaFlix, ICC FTP, CircleFTP, and DiscoveryFTP servers. Your custom added servers will be kept.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Restore Defaults", (d, w) -> app.ioExecutor.execute(() -> {
                    app.repository.db.resetDefaultServers();
                    cachedServerFilterOptions = app.repository.db.getServerFilterOptions();
                    uiHandler.post(() -> {
                        Toast.makeText(MainActivity.this, "Default FTP servers restored & visible", Toast.LENGTH_SHORT).show();
                        loadHome(false);
                        loadServersTab(true);
                    });
                }))
                .show();
    }

    private void showAddServerDialog() {
        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = UiHelper.dp(this, 18);
        root.setPadding(pad, UiHelper.dp(this, 10), pad, UiHelper.dp(this, 10));
        scroll.addView(root);

        TextView intro = new TextView(this);
        intro.setText("Paste any FTP URL playable on your Wi-Fi (h5ai, Apache, Nginx, Caddy, or BDIX portal). CineVault automatically detects all compatible movie & series folders and merges them into your library.");
        intro.setTextColor(0xFF94A3B8);
        intro.setTextSize(12f);
        intro.setPadding(0, 0, 0, UiHelper.dp(this, 10));
        root.addView(intro);

        TextView lblUrl = new TextView(this);
        lblUrl.setText("FTP Server URL");
        lblUrl.setTextColor(0xFFCBD5E1);
        lblUrl.setTextSize(12f);
        lblUrl.setTypeface(null, android.graphics.Typeface.BOLD);
        root.addView(lblUrl);

        EditText etUrl = new EditText(this);
        etUrl.setHint("http://172.16.50.14/ or ftp.myisp.net/movies/");
        etUrl.setSingleLine(true);
        etUrl.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        etUrl.setTextColor(0xFFF3F6FC);
        etUrl.setHintTextColor(0xFF64748B);
        etUrl.setTextSize(13f);
        etUrl.setBackgroundResource(R.drawable.bg_input_box);
        etUrl.setPadding(UiHelper.dp(this, 12), UiHelper.dp(this, 10), UiHelper.dp(this, 12), UiHelper.dp(this, 10));
        LinearLayout.LayoutParams ulp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        ulp.topMargin = UiHelper.dp(this, 4);
        etUrl.setLayoutParams(ulp);
        root.addView(etUrl);

        TextView lblName = new TextView(this);
        lblName.setText("Display Name (optional — auto-detected)");
        lblName.setTextColor(0xFFCBD5E1);
        lblName.setTextSize(12f);
        lblName.setTypeface(null, android.graphics.Typeface.BOLD);
        lblName.setPadding(0, UiHelper.dp(this, 10), 0, 0);
        root.addView(lblName);

        EditText etName = new EditText(this);
        etName.setHint("Auto from server");
        etName.setSingleLine(true);
        etName.setTextColor(0xFFF3F6FC);
        etName.setHintTextColor(0xFF64748B);
        etName.setTextSize(13f);
        etName.setBackgroundResource(R.drawable.bg_input_box);
        etName.setPadding(UiHelper.dp(this, 12), UiHelper.dp(this, 10), UiHelper.dp(this, 12), UiHelper.dp(this, 10));
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        nlp.topMargin = UiHelper.dp(this, 4);
        etName.setLayoutParams(nlp);
        root.addView(etName);

        MaterialButton btnTest = new MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
        btnTest.setText("Auto-Detect Compatible Folders");
        btnTest.setAllCaps(false);
        btnTest.setTextColor(0xFF38BDF8);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, UiHelper.dp(this, 42));
        tlp.topMargin = UiHelper.dp(this, 12);
        btnTest.setLayoutParams(tlp);
        root.addView(btnTest);

        ProgressBar probeSpinner = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        probeSpinner.setIndeterminate(true);
        probeSpinner.setVisibility(View.GONE);
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, UiHelper.dp(this, 6));
        plp.topMargin = UiHelper.dp(this, 6);
        probeSpinner.setLayoutParams(plp);
        root.addView(probeSpinner);

        TextView tvProbeStatus = new TextView(this);
        tvProbeStatus.setTextSize(12f);
        tvProbeStatus.setPadding(0, UiHelper.dp(this, 6), 0, UiHelper.dp(this, 4));
        tvProbeStatus.setVisibility(View.GONE);
        root.addView(tvProbeStatus);

        LinearLayout quickBar = new LinearLayout(this);
        quickBar.setOrientation(LinearLayout.HORIZONTAL);
        quickBar.setVisibility(View.GONE);
        quickBar.setPadding(0, UiHelper.dp(this, 4), 0, UiHelper.dp(this, 6));
        root.addView(quickBar);

        LinearLayout foldersBox = new LinearLayout(this);
        foldersBox.setOrientation(LinearLayout.VERTICAL);
        root.addView(foldersBox);

        final List<Models.DiscoveredFolder> discovered = new ArrayList<>();
        final List<android.widget.CheckBox> folderBoxes = new ArrayList<>();
        final boolean[] hasProbed = {false};
        final String[] detectedAdapter = {"directory"};
        final String[] detectedOrigin = {null};
        final String[] detectedRootHref = {null};

        etUrl.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                if (hasProbed[0]) {
                    hasProbed[0] = false;
                    detectedAdapter[0] = "directory";
                    detectedOrigin[0] = null;
                    detectedRootHref[0] = null;
                    discovered.clear();
                    foldersBox.removeAllViews();
                    quickBar.setVisibility(View.GONE);
                }
            }
            @Override public void afterTextChanged(android.text.Editable s) {}
        });

        Runnable renderFolderRows = () -> {
            foldersBox.removeAllViews();
            folderBoxes.clear();
            for (Models.DiscoveredFolder f : discovered) {
                LinearLayout fCard = new LinearLayout(MainActivity.this);
                fCard.setOrientation(LinearLayout.HORIZONTAL);
                fCard.setGravity(android.view.Gravity.CENTER_VERTICAL);
                fCard.setPadding(UiHelper.dp(MainActivity.this, 8), UiHelper.dp(MainActivity.this, 6),
                        UiHelper.dp(MainActivity.this, 10), UiHelper.dp(MainActivity.this, 6));
                fCard.setBackground(UiHelper.outlineBoxDrawable(f.selected ? 0x4438BDF8 : 0x1AFFFFFF, 0xFF0A0F1D));
                LinearLayout.LayoutParams flp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                flp.bottomMargin = UiHelper.dp(MainActivity.this, 6);
                fCard.setLayoutParams(flp);

                android.widget.CheckBox cb = new android.widget.CheckBox(MainActivity.this);
                cb.setChecked(f.selected);
                fCard.addView(cb);
                folderBoxes.add(cb);

                LinearLayout txtCol = new LinearLayout(MainActivity.this);
                txtCol.setOrientation(LinearLayout.VERTICAL);
                txtCol.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

                TextView tvN = new TextView(MainActivity.this);
                tvN.setText(f.name);
                tvN.setTextColor(0xFFF3F6FC);
                tvN.setTextSize(12.5f);
                tvN.setTypeface(null, android.graphics.Typeface.BOLD);
                tvN.setMaxLines(1);
                tvN.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
                txtCol.addView(tvN);

                TextView tvMeta = new TextView(MainActivity.this);
                String modeStr = "bucketed".equals(f.mode) ? "Year/A-Z buckets" : "Direct titles";
                if (f.childCount > 0) modeStr += " · " + f.childCount + " entries";
                tvMeta.setText(modeStr);
                tvMeta.setTextColor(0xFF64748B);
                tvMeta.setTextSize(10.5f);
                txtCol.addView(tvMeta);
                fCard.addView(txtCol);

                ServerConfig.CategoryDef catDef = ServerConfig.CATEGORY_BY_ID.get(f.category);
                String catLbl = catDef != null ? catDef.shortLabel : f.category;
                TextView tvCat = new TextView(MainActivity.this);
                tvCat.setText(catLbl);
                tvCat.setTextColor(0xFF38BDF8);
                tvCat.setTextSize(10.5f);
                tvCat.setTypeface(null, android.graphics.Typeface.BOLD);
                tvCat.setPadding(UiHelper.dp(MainActivity.this, 7), UiHelper.dp(MainActivity.this, 2),
                        UiHelper.dp(MainActivity.this, 7), UiHelper.dp(MainActivity.this, 2));
                android.graphics.drawable.GradientDrawable catBg = new android.graphics.drawable.GradientDrawable();
                catBg.setColor(0x2238BDF8);
                catBg.setCornerRadius(UiHelper.dp(MainActivity.this, 99));
                tvCat.setBackground(catBg);
                fCard.addView(tvCat);

                cb.setOnCheckedChangeListener((b, chk) -> {
                    f.selected = chk;
                    fCard.setBackground(UiHelper.outlineBoxDrawable(chk ? 0x4438BDF8 : 0x1AFFFFFF, 0xFF0A0F1D));
                });
                fCard.setOnClickListener(v2 -> cb.setChecked(!cb.isChecked()));
                foldersBox.addView(fCard);
            }
        };

        // Quick selection pills
        String[] quickTitles = {"Compatible Only", "Select All", "Clear"};
        for (int qi = 0; qi < quickTitles.length; qi++) {
            final int mode = qi;
            TextView qBtn = new TextView(this);
            qBtn.setText(quickTitles[qi]);
            qBtn.setTextColor(0xFFCBD5E1);
            qBtn.setTextSize(11f);
            qBtn.setTypeface(null, android.graphics.Typeface.BOLD);
            qBtn.setPadding(UiHelper.dp(this, 10), UiHelper.dp(this, 5), UiHelper.dp(this, 10), UiHelper.dp(this, 5));
            qBtn.setBackground(UiHelper.outlineBoxDrawable(0x22FFFFFF, 0xFF141C2E));
            LinearLayout.LayoutParams qlp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            qlp.rightMargin = UiHelper.dp(this, 6);
            qBtn.setLayoutParams(qlp);
            qBtn.setOnClickListener(v -> {
                for (int i = 0; i < discovered.size(); i++) {
                    Models.DiscoveredFolder f = discovered.get(i);
                    boolean next = mode == 1 || (mode == 0 && !H5aiService.classifyDiscoveredFolder(f.name).skipDefault);
                    f.selected = next;
                    if (i < folderBoxes.size()) folderBoxes.get(i).setChecked(next);
                }
            });
            quickBar.addView(qBtn);
        }

        btnTest.setOnClickListener(v -> {
            String rawUrl = ServerConfig.normalizeServerInputUrl(etUrl.getText().toString());
            if (!ServerConfig.isSafeServerUrl(rawUrl)) {
                tvProbeStatus.setVisibility(View.VISIBLE);
                tvProbeStatus.setTextColor(0xFFFCA5A5);
                tvProbeStatus.setText("Enter a valid FTP server URL (loopback addresses blocked).");
                return;
            }
            btnTest.setEnabled(false);
            btnTest.setText("Scanning Folders...");
            probeSpinner.setVisibility(View.VISIBLE);
            tvProbeStatus.setVisibility(View.VISIBLE);
            tvProbeStatus.setTextColor(0xFF38BDF8);
            tvProbeStatus.setText("Recursively discovering compatible movie & series folders...");
            foldersBox.removeAllViews();
            quickBar.setVisibility(View.GONE);
            discovered.clear();

            app.ioExecutor.execute(() -> {
                Models.ProbeResult res = app.repository.h5ai.probeDirectoryServer(rawUrl, 8500);
                uiHandler.post(() -> {
                    btnTest.setEnabled(true);
                    btnTest.setText("Auto-Detect Compatible Folders");
                    probeSpinner.setVisibility(View.GONE);
                    if (!res.ok) {
                        tvProbeStatus.setTextColor(0xFFFCA5A5);
                        tvProbeStatus.setText("Error: " + (res.error != null ? res.error : "Unreachable"));
                        return;
                    }
                    hasProbed[0] = true;
                    detectedAdapter[0] = (res.detectedAdapter != null && !res.detectedAdapter.isEmpty())
                            ? res.detectedAdapter : "directory";
                    detectedOrigin[0] = (res.origin != null && !res.origin.isEmpty()) ? res.origin : null;
                    detectedRootHref[0] = res.rootHref;
                    if (etName.getText().toString().trim().isEmpty()) {
                        if (res.suggestedName != null && !res.suggestedName.trim().isEmpty()) {
                            etName.setText(res.suggestedName.trim());
                        } else if (!res.origin.isEmpty()) {
                            try { etName.setText(new java.net.URL(res.origin).getHost()); } catch (Exception ignored) {}
                        }
                    }
                    int compat = 0;
                    for (Models.DiscoveredFolder f : res.folders) if (f.selected) compat++;
                    tvProbeStatus.setTextColor(0xFF22C55E);
                    tvProbeStatus.setText("Reachable (" + res.protocol.toUpperCase(Locale.US) + ") · "
                            + res.latencyMs + "ms · " + compat + " compatible / " + res.folders.size() + " folders"
                            + (res.directVideoCount > 0 ? " · " + res.directVideoCount + " videos" : ""));
                    discovered.addAll(res.folders);
                    if (!discovered.isEmpty()) {
                        quickBar.setVisibility(View.VISIBLE);
                        renderFolderRows.run();
                    }
                });
            });
        });

        AlertDialog dlg = new AlertDialog.Builder(this)
                .setTitle("Add Custom FTP Server")
                .setView(scroll)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Add & Auto-Sync", null)
                .create();

        dlg.setOnShowListener(d -> dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String rawUrl = ServerConfig.normalizeServerInputUrl(etUrl.getText().toString());
            if (!ServerConfig.isSafeServerUrl(rawUrl)) {
                tvProbeStatus.setVisibility(View.VISIBLE);
                tvProbeStatus.setTextColor(0xFFFCA5A5);
                tvProbeStatus.setText("Enter a valid FTP server URL first.");
                return;
            }
            final String initialName = etName.getText().toString().trim();
            final String initialAdapter = detectedAdapter[0];
            final String initialOrigin = detectedOrigin[0];
            final String initialRootHref = detectedRootHref[0];
            final List<Models.DiscoveredFolder> preSelected = new ArrayList<>();
            for (Models.DiscoveredFolder f : discovered) {
                if (f.selected) preSelected.add(f);
            }
            final boolean needAutoDiscover = !hasProbed[0];

            dlg.dismiss();
            if (needAutoDiscover) {
                Toast.makeText(MainActivity.this, "Auto-detecting server & compatible folders...", Toast.LENGTH_SHORT).show();
            }
            app.ioExecutor.execute(() -> {
                try {
                    String finalAdapter = initialAdapter;
                    String finalUrl = (initialOrigin != null && initialRootHref != null)
                            ? (initialOrigin + initialRootHref) : rawUrl;
                    String finalRootHref = initialRootHref;
                    String finalName = initialName;
                    List<Models.DiscoveredFolder> finalFolders = preSelected;
                    if (needAutoDiscover) {
                        Models.ProbeResult auto = app.repository.h5ai.probeDirectoryServer(rawUrl, 8000);
                        if (auto.ok) {
                            if (auto.detectedAdapter != null && !auto.detectedAdapter.isEmpty()) {
                                finalAdapter = auto.detectedAdapter;
                            }
                            if (auto.origin != null && !auto.origin.isEmpty()) {
                                finalUrl = auto.origin + (auto.rootHref != null ? auto.rootHref : "/");
                            }
                            if (auto.rootHref != null && !auto.rootHref.isEmpty()) {
                                finalRootHref = auto.rootHref;
                            }
                            if (finalName.isEmpty() && auto.suggestedName != null && !auto.suggestedName.trim().isEmpty()) {
                                finalName = auto.suggestedName.trim();
                            }
                            List<Models.DiscoveredFolder> compat = new ArrayList<>();
                            for (Models.DiscoveredFolder f : auto.folders) {
                                if (f.selected) compat.add(f);
                            }
                            finalFolders = compat;
                        }
                    }
                    Models.ManagedServer saved = app.repository.db.addOrUpdateCustomServer(
                            null, finalName, finalUrl, finalAdapter, finalFolders, finalRootHref);
                    cachedServerFilterOptions = app.repository.db.getServerFilterOptions();
                    int fCnt = finalFolders.size();
                    uiHandler.post(() -> {
                        Toast.makeText(MainActivity.this,
                                fCnt > 0
                                        ? "Added \"" + saved.name + "\" (" + fCnt + " folders auto-detected) — syncing..."
                                        : "Added \"" + saved.name + "\" — syncing...",
                                Toast.LENGTH_SHORT).show();
                        loadServersTab(false);
                        triggerSyncForServer(saved);
                    });
                } catch (Exception e) {
                    uiHandler.post(() -> Toast.makeText(MainActivity.this,
                            "Save failed: " + e.getMessage(), Toast.LENGTH_LONG).show());
                }
            });
        }));
        dlg.show();
    }

    private void renderUpdateCard(Models.AppUpdateInfo info) {
        if (info == null) return;
        srvUpdateStatus.setVisibility(View.VISIBLE);
        if (info.hasUpdate) {
            srvUpdateStatus.setTextColor(info.forceUpdate ? 0xFFEF4444 : 0xFF22C55E);
            srvUpdateStatus.setText((info.forceUpdate ? "Mandatory update: " : "Update available: ")
                    + info.displayVersion + " (Code " + info.latestVersionCode + ") · Installed V" + info.currentVersion);
            btnSrvDownloadUpdate.setVisibility(View.VISIBLE);
            btnSrvDownloadUpdate.setText("Download " + info.apkPackage + " (" + info.displayVersion + ")");
            StringBuilder notes = new StringBuilder(info.changelog);
            if (info.apkSizeBytes > 0) notes.append("\nAPK Size: ").append(Models.formatBytes(info.apkSizeBytes));
            if (info.sha256 != null && !info.sha256.isEmpty()) notes.append("\nSHA-256: ").append(info.sha256);
            if (info.minVersion != null && !"0.0.0".equals(info.minVersion)) {
                notes.append("\nMinimum required version: v").append(info.minVersion);
            }
            if (info.publishedAt != null && !info.publishedAt.isEmpty()) {
                notes.append("\nUpdated: ").append(info.publishedAt);
            }
            srvUpdateNotes.setVisibility(View.VISIBLE);
            srvUpdateNotes.setText(notes.toString());
        } else {
            srvUpdateStatus.setTextColor(0xFF22C55E);
            srvUpdateStatus.setText("You are on the latest version (V" + info.currentVersion
                    + " · Code " + info.currentVersionCode + ").");
            btnSrvDownloadUpdate.setVisibility(View.GONE);
            srvUpdateNotes.setVisibility(View.GONE);
        }
    }

    private void runManualUpdateCheck() {
        btnSrvCheckUpdates.setEnabled(false);
        srvUpdateStatus.setVisibility(View.VISIBLE);
        srvUpdateStatus.setTextColor(0xFF94A3B8);
        srvUpdateStatus.setText("Checking for updates...");
        app.ioExecutor.execute(() -> {
            Models.AppUpdateInfo info = app.repository.updateService.checkForUpdate();
            app.repository.markUpdateCheckedNow();
            uiHandler.post(() -> {
                btnSrvCheckUpdates.setEnabled(true);
                if (info != null) {
                    availableUpdate = info;
                    renderUpdateCard(info);
                    if (info.forceUpdate) showMandatoryUpdateLock(info);
                    else if (info.hasUpdate) showThreeSecondUpdatePopup(info);
                } else {
                    srvUpdateStatus.setTextColor(0xFFF59E0B);
                    srvUpdateStatus.setText("Unable to check for updates right now. Please check your internet connection.");
                }
            });
        });
    }

    private void removeHistoryItem(Models.MediaSummary item) {
        app.ioExecutor.execute(() -> {
            app.repository.db.removeMediaWatchHistory(item.id);
            uiHandler.post(() -> { loadHome(false); if (currentTab == 3) loadMyList(); });
        });
    }

    private void removeWatchlistItem(Models.MediaSummary item) {
        app.ioExecutor.execute(() -> {
            app.repository.db.removeFromWatchlist(item.id);
            uiHandler.post(() -> { loadHome(false); if (currentTab == 3) loadMyList(); });
        });
    }

    private void triggerSync(String mode) {
        triggerSync(mode, false);
    }

    private void triggerSync(String mode, boolean silent) {
        app.ioExecutor.execute(() -> app.repository.runSync(mode, silent, () -> uiHandler.post(
                silent ? this::refreshSilentlyAfterBackgroundSync : this::refreshVisibleTabAfterSync)));
    }

    private void refreshSilentlyAfterBackgroundSync() {
        app.ioExecutor.execute(() -> {
            Models.LibraryStats st = app.repository.db.getLibraryStats(false);
            uiHandler.post(() -> {
                latestStats = st;
                updateSyncChipCount();
                if (currentTab == 0) loadHome(false);
                else if (currentTab == 5) loadServersTab(false);
            });
        });
    }

    private void refreshVisibleTabAfterSync() {
        loadHome(false);
        if (currentTab == 1 || currentTab == 2 || currentTab == 4) loadBrowse();
        else if (currentTab == 5) loadServersTab(false);
    }

    private void updateSyncChipCount() {
        int tot = latestStats.total;
        if (tot >= 1000) syncChipText.setText(String.format(Locale.US, "%.1fK", tot / 1000.0));
        else syncChipText.setText(String.valueOf(tot));
    }

    private void checkForUpdatesBackground(boolean respectThrottle) {
        app.ioExecutor.execute(() -> {
            if (respectThrottle && !app.repository.isAutoUpdateCheckDue()) return;
            Models.AppUpdateInfo info = app.repository.updateService.checkForUpdate();
            app.repository.markUpdateCheckedNow();
            if (info != null) {
                uiHandler.post(() -> {
                    availableUpdate = info;
                    if (info.forceUpdate) {
                        showMandatoryUpdateLock(info);
                    } else if (info.hasUpdate) {
                        showThreeSecondUpdatePopup(info);
                    }
                    if (currentTab == 5) renderUpdateCard(info);
                });
            }
        });
    }

    /**
     * Strictly V1.4.2-only one-time 5-second feature popup highlighting automatic FTP Server Adding.
     * Persists immediately in SharedPreferences + SQLite so re-entering never shows it again,
     * and version-gated to V1.4.2 only so future updates never trigger it.
     */
    private void maybeShowOneTimeV142ServerFeaturePopup() {
        if (v142FeaturePopup == null) return;
        final String installedVer = app.repository.updateService.getInstalledVersion();
        android.content.SharedPreferences prefs = getSharedPreferences("cinevault_one_time_popups", MODE_PRIVATE);
        boolean seenInPrefs = prefs.getBoolean(UpdateService.V142_FEATURE_POPUP_PREF_KEY, false);
        if (!UpdateService.shouldShowV142ServerFeaturePopup(installedVer, seenInPrefs)) {
            return;
        }
        app.ioExecutor.execute(() -> {
            String seenInDb = app.repository.db.getSyncState(UpdateService.V142_FEATURE_POPUP_PREF_KEY);
            boolean alreadySeen = "1".equals(seenInDb) || prefs.getBoolean(UpdateService.V142_FEATURE_POPUP_PREF_KEY, false);
            if (!UpdateService.shouldShowV142ServerFeaturePopup(installedVer, alreadySeen)) {
                return;
            }
            // Mark as shown IMMEDIATELY before displaying so further entering will NEVER show it again!
            prefs.edit().putBoolean(UpdateService.V142_FEATURE_POPUP_PREF_KEY, true).commit();
            app.repository.db.setSyncState(UpdateService.V142_FEATURE_POPUP_PREF_KEY, "1");
            uiHandler.post(this::showV142FeaturePopupForFiveSeconds);
        });
    }

    private void showV142FeaturePopupForFiveSeconds() {
        if (v142FeaturePopup == null || isFinishing() || isDestroyed()) return;
        uiHandler.removeCallbacks(hideV142FeaturePopupRunnable);
        v142FeaturePopup.setBackground(UiHelper.outlineBoxDrawable(0x6638BDF8, 0xFF0E1A30));
        v142FeaturePopup.animate().cancel();
        v142FeaturePopup.setAlpha(0f);
        v142FeaturePopup.setTranslationY(-UiHelper.dp(this, 20));
        v142FeaturePopup.setVisibility(View.VISIBLE);
        v142FeaturePopup.animate()
                .alpha(1f)
                .translationY(0f)
                .setDuration(240)
                .start();

        if (v142FeaturePopupBar != null) {
            if (v142FeaturePopupAnimator != null) v142FeaturePopupAnimator.cancel();
            v142FeaturePopupBar.setProgress(1000);
            v142FeaturePopupAnimator = android.animation.ObjectAnimator.ofInt(v142FeaturePopupBar, "progress", 1000, 0);
            v142FeaturePopupAnimator.setDuration(UpdateService.V142_FEATURE_POPUP_DURATION_MS);
            v142FeaturePopupAnimator.setInterpolator(new android.view.animation.LinearInterpolator());
            v142FeaturePopupAnimator.start();
        }
        uiHandler.postDelayed(hideV142FeaturePopupRunnable, UpdateService.V142_FEATURE_POPUP_DURATION_MS);
    }

    private void dismissV142FeaturePopup() {
        uiHandler.removeCallbacks(hideV142FeaturePopupRunnable);
        if (v142FeaturePopupAnimator != null) {
            v142FeaturePopupAnimator.cancel();
            v142FeaturePopupAnimator = null;
        }
        if (v142FeaturePopup != null && v142FeaturePopup.getVisibility() == View.VISIBLE) {
            v142FeaturePopup.animate().cancel();
            v142FeaturePopup.animate()
                    .alpha(0f)
                    .translationY(-UiHelper.dp(this, 16))
                    .setDuration(220)
                    .withEndAction(() -> {
                        v142FeaturePopup.setVisibility(View.GONE);
                        v142FeaturePopup.setAlpha(1f);
                        v142FeaturePopup.setTranslationY(0f);
                    })
                    .start();
        }
    }

    private void showThreeSecondUpdatePopup(Models.AppUpdateInfo info) {
        uiHandler.removeCallbacks(hideUpdatePopupRunnable);
        updateBannerText.setText("New Update Available · " + info.displayVersion);
        if (updateBannerSub != null) {
            updateBannerSub.setText("Tap Update to install the latest CineVault release");
        }
        updateBanner.animate().cancel();
        updateBanner.setAlpha(0f);
        updateBanner.setVisibility(View.VISIBLE);
        updateBanner.animate().alpha(1f).setDuration(200).start();
        uiHandler.postDelayed(hideUpdatePopupRunnable, 3000L);
    }

    private void showMandatoryUpdateLock(Models.AppUpdateInfo info) {
        if (forceLockShown || isFinishing()) return;
        forceLockShown = true;
        StringBuilder msg = new StringBuilder(info.lockMessage);
        msg.append("\n\nInstalled: V").append(info.currentVersion).append(" (Code ").append(info.currentVersionCode).append(")");
        msg.append("\nLatest: ").append(info.displayVersion).append(" (Code ").append(info.latestVersionCode).append(")");
        if (info.sha256 != null && !info.sha256.isEmpty()) msg.append("\nSHA-256: ").append(info.sha256);

        AlertDialog dlg = new AlertDialog.Builder(this)
                .setTitle(info.lockTitle)
                .setMessage(msg.toString())
                .setCancelable(false)
                .setPositiveButton("Update Now", null)
                .create();
        dlg.setOnShowListener(d -> dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v ->
                UiHelper.downloadAppUpdateDirect(this, info)));
        dlg.show();
    }

    private void showUpdateDialog(Models.AppUpdateInfo info) {
        StringBuilder msg = new StringBuilder();
        msg.append("Installed: V").append(info.currentVersion)
                .append(" -> Latest: ").append(info.displayVersion).append("\n\n");
        msg.append(info.changelog);
        if (info.apkSizeBytes > 0) msg.append("\n\nAPK Size: ").append(Models.formatBytes(info.apkSizeBytes));
        if (info.sha256 != null && !info.sha256.isEmpty()) msg.append("\nSHA-256: ").append(info.sha256);
        msg.append("\n\nDownloads CineVault directly to your Downloads folder.");

        new AlertDialog.Builder(this)
                .setTitle("CineVault " + info.displayVersion + " Available")
                .setMessage(msg.toString())
                .setNegativeButton("Later", null)
                .setPositiveButton("Download Update", (d, w) ->
                        UiHelper.downloadAppUpdateDirect(this, info))
                .show();
    }

    private void openDetail(Models.MediaSummary item, boolean autoPlay) {
        Intent i = new Intent(this, DetailActivity.class);
        i.putExtra(DetailActivity.EXTRA_ITEM_ID, item.id);
        i.putExtra(DetailActivity.EXTRA_AUTO_PLAY, autoPlay);
        startActivity(i);
    }

    private void resumeFromHistory(Models.MediaSummary item) {
        // Open Details screen first so the user can choose the previously watched file/episode
        // (which resumes from its saved position) or pick any other season/edition.
        openDetail(item, false);
    }
}
