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
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.cinevault.app.CineVaultApp;
import com.cinevault.app.R;
import com.cinevault.app.data.MediaDownloadManager;
import com.cinevault.app.data.MediaRepository;
import com.cinevault.app.data.Models;
import com.cinevault.app.data.ServerConfig;
import com.cinevault.app.data.UpdateService;
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
    private Models.BrowseFilter currentFilter = new Models.BrowseFilter();
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
    private final List<String> langValues = new ArrayList<>();
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
    private TextView srvStatsSummary, srvStatsDups, srvStatsSources, srvSyncLabel, srvSyncErrors;
    private ProgressBar srvSyncBar;
    private MaterialButton btnSrvSyncQuick, btnSrvSyncFull, btnSrvPingAll;
    private TextView srvLastSyncText, srvAppVersion, srvUpdateStatus, srvUpdateNotes;
    private MaterialSwitch switchAutoSync;
    private Spinner spinAutoSyncInterval;
    private LinearLayout srvHealthList;
    private MaterialButton btnSrvCheckUpdates, btnSrvDownloadUpdate;

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

        bootstrapCatalogAndHome();
        handleOpenTabIntent(getIntent());
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
        if (currentTab == 0) loadHome(false);
        else if (currentTab == 3) {
            loadMyList();
            startDownloadsPolling();
        }
        else if (currentTab == 5) loadServersTab(false);
        checkForUpdatesBackground(true);
    }

    @Override
    protected void onPause() {
        uiHandler.removeCallbacks(downloadsPollRunnable);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        uiHandler.removeCallbacksAndMessages(null);
        app.repository.removeSyncListener(syncListener);
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
        srvStatsSummary = findViewById(R.id.srv_stats_summary);
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
        btnSrvPingAll = findViewById(R.id.btn_srv_ping_all);
        srvHealthList = findViewById(R.id.srv_health_list);
        srvAppVersion = findViewById(R.id.srv_app_version);
        btnSrvCheckUpdates = findViewById(R.id.btn_srv_check_updates);
        btnSrvDownloadUpdate = findViewById(R.id.btn_srv_download_update);
        srvUpdateStatus = findViewById(R.id.srv_update_status);
        srvUpdateNotes = findViewById(R.id.srv_update_notes);

        srvAppVersion.setText("V" + app.repository.updateService.getInstalledVersion()
                + " (Code " + app.repository.updateService.getInstalledVersionCode() + ")");
        setSpinnerItems(spinAutoSyncInterval, Arrays.asList(AUTO_SYNC_INTERVAL_LABELS));

        // TV & keyboard D-Pad focus highlights on key controls
        UiHelper.applyTvFocusEffect(btnHeroPlay, 1.05f);
        UiHelper.applyTvFocusEffect(btnHeroDetails, 1.05f);
        UiHelper.applyTvFocusEffect(btnHeroWatchlist, 1.06f);
        UiHelper.applyTvFocusEffect(findViewById(R.id.btn_home_sync_now), 1.05f);
        UiHelper.applyTvFocusEffect(btnPrevPage, 1.05f);
        UiHelper.applyTvFocusEffect(btnNextPage, 1.05f);
        UiHelper.applyTvFocusEffect(btnClearHistory, 1.05f);
        UiHelper.applyTvFocusEffect(btnClearWatchlist, 1.05f);
        UiHelper.applyTvFocusEffect(btnClearCompletedDownloads, 1.05f);
        UiHelper.applyTvFocusEffect(btnSrvSyncQuick, 1.04f);
        UiHelper.applyTvFocusEffect(btnSrvSyncFull, 1.04f);
        UiHelper.applyTvFocusEffect(btnSrvPingAll, 1.05f);
        UiHelper.applyTvFocusEffect(btnSrvCheckUpdates, 1.03f);
        UiHelper.applyTvFocusEffect(btnSrvDownloadUpdate, 1.03f);
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
        findViewById(R.id.btn_home_sync_now).setOnClickListener(v -> triggerSync("full"));
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
                pendingSearchRunnable = () -> {
                    if (q.isEmpty()) {
                        if (currentTab == 4) switchTab(0, "", "", "recent");
                        return;
                    }
                    currentTab = 4;
                    currentFilter = new Models.BrowseFilter();
                    currentFilter.query = q;
                    currentFilter.sort = "relevance";
                    showActiveTabView();
                    populateFilterControls();
                    loadBrowse();
                    boostSearchWithLiveIcc(q);
                };
                uiHandler.postDelayed(pendingSearchRunnable, 240);
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

        btnSrvPingAll.setOnClickListener(v -> pingAllServersIntoTab());

        btnSrvCheckUpdates.setOnClickListener(v -> runManualUpdateCheck());

        btnSrvDownloadUpdate.setOnClickListener(v -> {
            if (availableUpdate != null) {
                UiHelper.downloadAppUpdateDirect(this, availableUpdate);
            }
        });
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
                            .setPositiveButton("Quit", (d, w) -> finishAffinity())
                            .show();
                } else {
                    lastHomeBackPressMs = now;
                    Toast.makeText(MainActivity.this, "Press back again to quit CineVault", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    private void bootstrapCatalogAndHome() {
        app.ioExecutor.execute(() -> {
            // Clean stray release tags & run deduplication automatically on v1.0.0 -> v1.0.1 upgrade!
            app.repository.db.cleanupDirtyTitlesAndDeduplicate();
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
        final List<String> qualityVals = Arrays.asList("", "4K", "1080p", "720p", "3D");
        setSpinnerItems(spinQuality, Arrays.asList("All Quality", "4K Ultra HD", "1080p Full HD", "720p HD", "3D Movies"));

        final List<String> audioVals = Arrays.asList("", "dual", "multi", "hindi-dubbed");
        setSpinnerItems(spinAudio, Arrays.asList("All Audio", "Dual Audio", "Multi Audio", "Hindi Dubbed"));

        final List<String> serverVals = Arrays.asList("", "dhakaflix", "icc", "circleftp", "discoveryftp");
        setSpinnerItems(spinServer, Arrays.asList("All Servers", "DhakaFlix", "ICC FTP", "CircleFTP", "DiscoveryFTP"));

        AdapterView.OnItemSelectedListener listener = new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int pos, long id) {
                if (suppressSpinnerEvents) return;
                if (parent == spinYear && pos < yearValues.size()) currentFilter.year = yearValues.get(pos);
                else if (parent == spinQuality && pos < qualityVals.size()) currentFilter.quality = qualityVals.get(pos);
                else if (parent == spinAudio && pos < audioVals.size()) currentFilter.audio = audioVals.get(pos);
                else if (parent == spinLanguage && pos < langValues.size()) currentFilter.language = langValues.get(pos);
                else if (parent == spinServer && pos < serverVals.size()) currentFilter.source = serverVals.get(pos);
                else if (parent == spinSort && pos < sortValues.size()) currentFilter.sort = sortValues.get(pos);
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

        filterCategoryChips.removeAllViews();
        addCategoryChip("All", "", currentFilter.category.isEmpty());
        for (ServerConfig.CategoryDef c : ServerConfig.CATEGORIES) {
            if (currentTab == 1 && !"movies".equals(c.group)) continue;
            if (currentTab == 2 && !"series".equals(c.group)) continue;
            Integer count = latestStats.byCategory.get(c.id);
            String lbl = (count != null && count > 0) ? c.shortLabel + " (" + count + ")" : c.shortLabel;
            addCategoryChip(lbl, c.id, c.id.equals(currentFilter.category));
        }

        yearValues.clear();
        List<String> yearLabels = new ArrayList<>();
        yearValues.add(""); yearLabels.add("All Years");
        for (int y : latestStats.years) {
            yearValues.add(String.valueOf(y));
            yearLabels.add(String.valueOf(y));
        }
        setSpinnerItems(spinYear, yearLabels);
        spinYear.setSelection(Math.max(0, yearValues.indexOf(currentFilter.year)));

        langValues.clear();
        List<String> langLabels = new ArrayList<>();
        langValues.add(""); langLabels.add("All Languages");
        for (Models.LanguageCount lc : latestStats.languages) {
            langValues.add(lc.lang);
            langLabels.add(lc.lang + " (" + lc.count + ")");
        }
        setSpinnerItems(spinLanguage, langLabels);
        spinLanguage.setSelection(Math.max(0, langValues.indexOf(currentFilter.language)));

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
        spinSort.setSelection(Math.max(0, sortValues.indexOf(currentFilter.sort)));

        spinQuality.setSelection(Math.max(0, Arrays.asList("", "4K", "1080p", "720p", "3D").indexOf(currentFilter.quality)));
        spinAudio.setSelection(Math.max(0, Arrays.asList("", "dual", "multi", "hindi-dubbed").indexOf(currentFilter.audio)));
        spinServer.setSelection(Math.max(0, Arrays.asList("", "dhakaflix", "icc", "circleftp", "discoveryftp").indexOf(currentFilter.source)));

        int cnt = currentFilter.activeFilterCount();
        filterHeaderText.setText(cnt > 0 ? "Filters (" + cnt + " active)" : "Filters");
        btnResetFilters.setVisibility(cnt > 0 ? View.VISIBLE : View.GONE);

        suppressSpinnerEvents = false;
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
            else if ("imdb".equals(currentFilter.sort)) currentFilter.sort = "recent";
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
            boolean shouldAutoSync = initialBootstrap && feed.stats.total > 0 && app.repository.isAutoSyncDue();
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

                if (initialBootstrap) {
                    int iccCount = feed.stats.bySource.containsKey("icc") ? feed.stats.bySource.get("icc") : 0;
                    if (feed.stats.total == 0) {
                        triggerSync("full", false);
                    } else if (iccCount < 500) {
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
        if (currentTab == 1) browseTitle.setText("Movies Library");
        else if (currentTab == 2) browseTitle.setText("TV Series, Anime & Shows");
        else browseTitle.setText("Search: \"" + snap.query + "\"");

        int cnt = snap.activeFilterCount();
        filterHeaderText.setText(cnt > 0 ? "Filters (" + cnt + " active)" : "Filters");
        btnResetFilters.setVisibility(cnt > 0 ? View.VISIBLE : View.GONE);

        app.ioExecutor.execute(() -> {
            Models.BrowsePageResult res = app.repository.db.queryItems(snap);
            uiHandler.post(() -> {
                browseCount.setText(res.total + " title" + (res.total == 1 ? "" : "s") + " found");
                browseEmpty.setVisibility(res.items.isEmpty() ? View.VISIBLE : View.GONE);
                browseAdapter.submitList(res.items);
                if (res.totalPages > 1) {
                    browsePagination.setVisibility(View.VISIBLE);
                    pageIndicator.setText("Page " + res.page + " of " + res.totalPages);
                    btnPrevPage.setEnabled(res.page > 1);
                    btnNextPage.setEnabled(res.page < res.totalPages);
                } else {
                    browsePagination.setVisibility(View.GONE);
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
            boolean autoEnabled = app.repository.isAutoSyncEnabled();
            int intervalMin = app.repository.getAutoSyncIntervalMinutes();

            uiHandler.post(() -> {
                latestStats = st;
                updateSyncChipCount();
                srvStatsSummary.setText(st.total + " Unique Titles · " + st.movies + " Movies · " + st.series + " TV & Anime");
                srvStatsDups.setText("Duplicates merged (highest quality kept): " + st.duplicatesMerged
                        + " (from " + st.totalRaw + " indexed)");
                int df = st.bySource.containsKey("dhakaflix") ? st.bySource.get("dhakaflix") : 0;
                int ic = st.bySource.containsKey("icc") ? st.bySource.get("icc") : 0;
                int cf = st.bySource.containsKey("circleftp") ? st.bySource.get("circleftp") : 0;
                int ds = st.bySource.containsKey("discoveryftp") ? st.bySource.get("discoveryftp") : 0;
                srvStatsSources.setText("DhakaFlix: " + df + " · ICC FTP: " + ic + " · CircleFTP: " + cf + " · DiscoveryFTP: " + ds);

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
            List<Models.ServerHealth> health = app.repository.checkAllServersHealth();
            uiHandler.post(() -> {
                btnSrvPingAll.setEnabled(true);
                btnSrvPingAll.setText("Ping All");
                renderServersHealthList(health);
            });
        });
    }

    private void renderServersHealthList(List<Models.ServerHealth> health) {
        srvHealthList.removeAllViews();
        if (health == null || health.isEmpty()) {
            TextView tv = new TextView(this);
            tv.setText("Tap Ping All to test all 10 BDIX media servers.");
            tv.setTextColor(0xFF94A3B8);
            tv.setTextSize(12f);
            srvHealthList.addView(tv);
            return;
        }
        for (Models.ServerHealth h : health) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setPadding(0, UiHelper.dp(this, 6), 0, UiHelper.dp(this, 6));

            LinearLayout left = new LinearLayout(this);
            left.setOrientation(LinearLayout.VERTICAL);
            left.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

            TextView name = new TextView(this);
            name.setText(h.node.name);
            name.setTextColor(0xFFF3F6FC);
            name.setTextSize(12.5f);
            name.setMaxLines(1);
            left.addView(name);

            TextView sub = new TextView(this);
            String subTxt = h.node.origin + (!h.online && h.reason != null && !h.reason.isEmpty() ? " · " + h.reason : "");
            sub.setText(subTxt);
            sub.setTextColor(0xFF64748B);
            sub.setTextSize(11f);
            sub.setMaxLines(2);
            left.addView(sub);

            TextView status = new TextView(this);
            status.setTextSize(11.5f);
            status.setTypeface(null, android.graphics.Typeface.BOLD);
            status.setPadding(UiHelper.dp(this, 8), 0, 0, 0);
            if (h.online) {
                status.setText((h.latencyMs != null ? h.latencyMs : 0) + "ms OK");
                status.setTextColor(0xFF22C55E);
            } else if (h.node.optional) {
                status.setText("Upstream Down");
                status.setTextColor(0xFFF59E0B);
            } else {
                status.setText("Offline");
                status.setTextColor(0xFFEF4444);
            }

            row.addView(left);
            row.addView(status);
            srvHealthList.addView(row);
        }
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
        if (item.historyFileUrl != null && !item.historyFileUrl.isEmpty()
                && ServerConfig.isAllowedUrl(item.historyFileUrl)) {
            Models.MediaFileEntry file = new Models.MediaFileEntry(
                    item.historyFileName != null ? item.historyFileName : item.title,
                    item.historyFileUrl, "video", "", 0, 0, null, 1,
                    item.historyEpisodeLabel != null ? item.historyEpisodeLabel : "",
                    "", item.quality, true);
            Models.PlaybackSession session = new Models.PlaybackSession(
                    item.id, item.title, file, Collections.emptyList(), item.historySeasonName,
                    Collections.emptyList(), 0, item.quality,
                    ServerConfig.serverDisplayName(item.source, item.origin),
                    Collections.emptyList(), item.historyCompleted ? 0 : item.historyPosition);
            Intent i = new Intent(this, PlayerActivity.class);
            i.putExtra(PlayerActivity.EXTRA_SESSION, session);
            startActivity(i);
            return;
        }
        openDetail(item, false);
    }
}
