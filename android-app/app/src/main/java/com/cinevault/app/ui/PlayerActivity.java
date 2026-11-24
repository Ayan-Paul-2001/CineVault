package com.cinevault.app.ui;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.media.AudioManager;
import android.media.audiofx.LoudnessEnhancer;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.text.Cue;
import androidx.media3.common.text.CueGroup;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo;
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.mp4.Mp4Extractor;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import com.cinevault.app.CineVaultApp;
import com.cinevault.app.R;
import com.cinevault.app.data.MediaDownloadManager;
import com.cinevault.app.data.Models;
import com.cinevault.app.data.ServerConfig;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Fullscreen Cinema Video Player powered by AndroidX Media3 ExoPlayer + Jellyfin FFmpeg Audio Decoder.
 * Supports hardware H.264/HEVC/10-bit video, Dolby AC3/EAC3/DTS audio, Dual/Multi-Audio switching,
 * VLC-style left-side brightness slider, right-side volume + 200% sound boost slider,
 * VLC-style video size / aspect-ratio fixing (Best Fit, Fit Screen Crop, Fill Stretch, 16:9, 4:3,
 * 21:9, Fit Horizontal, Fit Vertical + 2-finger pinch-to-zoom), automatic non-forced-first subtitle
 * selection, subtitle size & timing offset, quality switcher, Next Episode auto-advance, and
 * persistent SQLite watch history resume.
 */
@OptIn(markerClass = UnstableApi.class)
public final class PlayerActivity extends AppCompatActivity {
    public static final String EXTRA_SESSION = "playback_session";

    private static final int GESTURE_NONE = 0;
    private static final int GESTURE_BRIGHTNESS = 1;
    private static final int GESTURE_VOLUME = 2;

    private static final class VideoScaleMode {
        final String key;
        final String label;
        final String shortLabel;
        final int resizeMode;
        final float forcedAspectRatio;

        VideoScaleMode(String key, String label, String shortLabel, int resizeMode, float forcedAspectRatio) {
            this.key = key;
            this.label = label;
            this.shortLabel = shortLabel;
            this.resizeMode = resizeMode;
            this.forcedAspectRatio = forcedAspectRatio;
        }
    }

    private static final VideoScaleMode[] SCALE_MODES = new VideoScaleMode[]{
            new VideoScaleMode("fit", "Best Fit", "Fit", AspectRatioFrameLayout.RESIZE_MODE_FIT, 0f),
            new VideoScaleMode("crop", "Fit Screen (Crop)", "Crop", AspectRatioFrameLayout.RESIZE_MODE_ZOOM, 0f),
            new VideoScaleMode("fill", "Fill (Stretch)", "Fill", AspectRatioFrameLayout.RESIZE_MODE_FILL, 0f),
            new VideoScaleMode("16_9", "16:9 Cinema", "16:9", AspectRatioFrameLayout.RESIZE_MODE_FIT, 16f / 9f),
            new VideoScaleMode("4_3", "4:3 Classic", "4:3", AspectRatioFrameLayout.RESIZE_MODE_FIT, 4f / 3f),
            new VideoScaleMode("21_9", "21:9 Ultrawide", "21:9", AspectRatioFrameLayout.RESIZE_MODE_FIT, 21f / 9f),
            new VideoScaleMode("width", "Fit Horizontal", "Width", AspectRatioFrameLayout.RESIZE_MODE_FIXED_WIDTH, 0f),
            new VideoScaleMode("height", "Fit Vertical", "Height", AspectRatioFrameLayout.RESIZE_MODE_FIXED_HEIGHT, 0f)
    };

    private static final float[] PLAYBACK_SPEEDS = {0.25f, 0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 1.75f, 2.0f};
    private static final String[] PLAYBACK_SPEED_LABELS = {
            "0.25x", "0.5x", "0.75x", "1x (Normal)", "1.25x", "1.5x", "1.75x", "2x"
    };

    private CineVaultApp app;
    private Models.PlaybackSession session;
    private ExoPlayer player;
    private PlayerView playerView;
    private AudioManager audioManager;
    private LoudnessEnhancer loudnessEnhancer;
    private ScaleGestureDetector scaleGestureDetector;
    private GestureDetector tapGestureDetector;

    private View gestureLayer, gestureHud, gestureBarTrack, gestureBarFill;
    private View scaleHud, doubleTapLeftHud, doubleTapRightHud;
    private ImageView gestureHudIcon;
    private TextView gestureHudPercent, gestureHudLabel, scaleHudTitle, scaleHudHint;
    private TextView doubleTapLeftText, doubleTapRightText;

    private TextView cinemaSubText, titleView, subtitleView, posTimeView, durTimeView;
    private TextView btnNextEp, btnSpeed, btnScale, btnAudio, btnCc, btnQuality, btnExternal;
    private ImageButton btnPlayPause;
    private View btnRotate, btnRew, btnFwd;
    private SeekBar seekBar;
    private View bufferingView, controlsOverlay;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean isTvDevice = false;
    private boolean controlsVisible = true;
    private boolean isLandscape = true;
    private boolean isSeeking = false;
    private boolean didInitialSeek = false;
    private boolean didAutoSelectSub = false;
    private double lastSavedSec = 0;
    private float subTextSp = 20f;
    private double subDelaySec = 0.0;
    private boolean subtitlesEnabled = true;

    // Anti-time-jump clock watchdog & automatic playback error recovery
    private long lastStablePosMs = 0L;
    private long lastUserSeekElapsedMs = 0L;
    private int jumpRecoveryCount = 0;
    private boolean retriedWithoutSubs = false;
    private boolean useSoftwareVideoFallback = false;
    private int ioRetryCount = 0;
    private final Set<String> failedStreamUrls = new HashSet<>();

    // VLC-style Video Size / Aspect Ratio & YouTube-style Speed / Double-Tap state
    private int scaleModeIndex = 0;
    private float naturalVideoAspectRatio = 16f / 9f;
    private float playbackSpeed = 1.0f;
    private int doubleTapSide = 0; // -1 = left, 1 = right
    private int doubleTapAccumSec = 0;
    private long lastDoubleTapElapsedMs = 0L;
    private boolean pinchActive = false;
    private boolean pinchTriggered = false;
    private float pinchSpanFactor = 1.0f;

    // VLC-style Brightness & Volume Boost gesture state
    private int touchSlop;
    private int gestureMode = GESTURE_NONE;
    private float gestureStartX = 0f;
    private float gestureStartY = 0f;
    private float startBrightness = 0.5f;
    private float startVolumePct = 50f;
    private float currentVolumePct = -1f;

    private final Runnable hideControlsTask = () -> {
        if (player != null && player.isPlaying()) {
            controlsVisible = false;
            controlsOverlay.setVisibility(View.GONE);
            updateSubtitleMargin();
        }
    };

    private final Runnable hideGestureHudTask = () -> {
        if (gestureHud != null && gestureHud.getVisibility() == View.VISIBLE) {
            gestureHud.animate().alpha(0f).setDuration(180).withEndAction(() -> {
                gestureHud.setVisibility(View.GONE);
                gestureHud.setAlpha(1f);
            }).start();
        }
    };

    private final Runnable hideScaleHudTask = () -> {
        if (scaleHud != null && scaleHud.getVisibility() == View.VISIBLE) {
            scaleHud.animate().alpha(0f).setDuration(180).withEndAction(() -> {
                scaleHud.setVisibility(View.GONE);
                scaleHud.setAlpha(1f);
            }).start();
        }
    };

    private final Runnable hideDoubleTapHudTask = () -> {
        doubleTapSide = 0;
        doubleTapAccumSec = 0;
        if (doubleTapLeftHud != null && doubleTapLeftHud.getVisibility() == View.VISIBLE) {
            doubleTapLeftHud.animate().alpha(0f).setDuration(180).withEndAction(() -> {
                doubleTapLeftHud.setVisibility(View.GONE);
                doubleTapLeftHud.setAlpha(1f);
            }).start();
        }
        if (doubleTapRightHud != null && doubleTapRightHud.getVisibility() == View.VISIBLE) {
            doubleTapRightHud.animate().alpha(0f).setDuration(180).withEndAction(() -> {
                doubleTapRightHud.setVisibility(View.GONE);
                doubleTapRightHud.setAlpha(1f);
            }).start();
        }
    };

    private void markUserSeek() {
        lastUserSeekElapsedMs = SystemClock.elapsedRealtime();
    }

    private final Runnable progressPollTask = new Runnable() {
        @Override
        public void run() {
            if (player != null) {
                long rawPos = player.getCurrentPosition();
                long rawDur = player.getDuration();
                long posMs = rawPos == C.TIME_UNSET ? 0L : Math.max(0L, rawPos);
                long durMs = rawDur == C.TIME_UNSET ? 0L : Math.max(0L, rawDur);

                boolean userRecentlySought = (SystemClock.elapsedRealtime() - lastUserSeekElapsedMs) <= 3000L;
                if (player.getPlaybackState() == Player.STATE_READY && player.isPlaying() && !isSeeking) {
                    if (!userRecentlySought && lastStablePosMs > 1000L && durMs > 0L) {
                        long deltaMs = posMs - lastStablePosMs;
                        boolean suddenForwardJump = deltaMs > 120_000L && posMs < (durMs - 5_000L);
                        boolean suddenBackwardJump = deltaMs < -30_000L;
                        if ((suddenForwardJump || suddenBackwardJump) && jumpRecoveryCount < 4) {
                            jumpRecoveryCount++;
                            long recoverMs = Math.min(durMs - 1000L, lastStablePosMs + 1000L);
                            markUserSeek();
                            player.seekTo(Math.max(0L, recoverMs));
                            handler.postDelayed(this, 500);
                            return;
                        }
                    }
                    if (userRecentlySought || lastStablePosMs == 0L || Math.abs(posMs - lastStablePosMs) <= 15_000L) {
                        lastStablePosMs = posMs;
                    }
                } else if (userRecentlySought && posMs > 0L) {
                    lastStablePosMs = posMs;
                }

                if (!isSeeking && durMs > 0L) {
                    int durSec = (int) (durMs / 1000L);
                    int posSecInt = (int) (posMs / 1000L);
                    posTimeView.setText(Models.formatDurationSec(posMs / 1000.0));
                    durTimeView.setText(Models.formatDurationSec(durMs / 1000.0));
                    if (seekBar.getMax() != durSec) {
                        seekBar.setMax(durSec);
                    }
                    seekBar.setProgress(posSecInt);
                }
                double posSec = lastStablePosMs > 0L ? (lastStablePosMs / 1000.0) : (posMs / 1000.0);
                if (posSec >= 5.0 && Math.abs(posSec - lastSavedSec) >= 8.0) {
                    lastSavedSec = posSec;
                    persistProgress();
                }
            }
            handler.postDelayed(this, 500);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_player);
        app = CineVaultApp.get();
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        touchSlop = ViewConfiguration.get(this).getScaledTouchSlop();

        Object extra = getIntent().getSerializableExtra(EXTRA_SESSION);
        if (!(extra instanceof Models.PlaybackSession)) { finish(); return; }
        session = (Models.PlaybackSession) extra;
        boolean allowedRemote = ServerConfig.isAllowedUrl(session.file.url);
        boolean verifiedLocal = !allowedRemote
                && MediaDownloadManager.isVerifiedLocalDownloadUri(this, app.repository.db, session.file.url);
        if (!allowedRemote && !verifiedLocal) {
            Toast.makeText(this, "Blocked untrusted stream URL.", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (isTvDevice && controlsVisible) {
                    controlsVisible = false;
                    controlsOverlay.setVisibility(View.GONE);
                    updateSubtitleMargin();
                    return;
                }
                persistProgress();
                finish();
            }
        });

        isTvDevice = UiHelper.isAndroidTv(this);
        subTextSp = isTvDevice ? 26f : (UiHelper.isTablet(this) ? 23f : 20f);

        enterImmersive();
        bindViews();
        initPlayer(false);
        loadSavedScaleMode();
        openCurrentSession();
        handler.post(progressPollTask);
        scheduleHideControls();
        if (isTvDevice && btnPlayPause != null) {
            btnPlayPause.post(() -> btnPlayPause.requestFocus());
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            int code = event.getKeyCode();
            if (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_SPACE) {
                togglePlayPause();
                showControlsAndFocus(btnPlayPause);
                return true;
            }
            if (code == KeyEvent.KEYCODE_MEDIA_PLAY) {
                if (player != null) player.play();
                showControlsAndFocus(btnPlayPause);
                return true;
            }
            if (code == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                if (player != null) player.pause();
                showControlsAndFocus(btnPlayPause);
                return true;
            }
            if (code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD || code == KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD) {
                seekRelativeWithHud(15);
                return true;
            }
            if (code == KeyEvent.KEYCODE_MEDIA_REWIND || code == KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD) {
                seekRelativeWithHud(-15);
                return true;
            }
            if (code == KeyEvent.KEYCODE_MEDIA_NEXT && hasNextEpisode()) {
                switchEpisode(session.playlistIndex + 1);
                return true;
            }
            if (code == KeyEvent.KEYCODE_CAPTIONS) {
                showControlsAndFocus(btnCc);
                showSubtitleDialog();
                return true;
            }
            if (code == KeyEvent.KEYCODE_TV_ZOOM_MODE || code == KeyEvent.KEYCODE_ZOOM_IN || code == KeyEvent.KEYCODE_A) {
                setVideoScaleMode((scaleModeIndex + 1) % SCALE_MODES.length, true);
                return true;
            }
            if (code == KeyEvent.KEYCODE_MENU || code == KeyEvent.KEYCODE_INFO) {
                showControlsAndFocus(btnPlayPause);
                return true;
            }

            if (!controlsVisible) {
                if (code == KeyEvent.KEYCODE_DPAD_LEFT) {
                    seekRelativeWithHud(-10);
                    return true;
                }
                if (code == KeyEvent.KEYCODE_DPAD_RIGHT) {
                    seekRelativeWithHud(10);
                    return true;
                }
                if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) {
                    togglePlayPause();
                    showControlsAndFocus(btnPlayPause);
                    return true;
                }
                if (code == KeyEvent.KEYCODE_DPAD_UP) {
                    showControlsAndFocus(btnPlayPause);
                    return true;
                }
                if (code == KeyEvent.KEYCODE_DPAD_DOWN) {
                    showControlsAndFocus(seekBar != null ? seekBar : btnScale);
                    return true;
                }
            } else if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN
                    || code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT
                    || code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) {
                scheduleHideControls();
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private void togglePlayPause() {
        if (player == null) return;
        if (player.isPlaying()) player.pause();
        else player.play();
    }

    private void showControlsAndFocus(View target) {
        controlsVisible = true;
        controlsOverlay.setVisibility(View.VISIBLE);
        updateSubtitleMargin();
        if (target != null && target.getVisibility() == View.VISIBLE) {
            target.post(target::requestFocus);
        }
        scheduleHideControls();
    }

    private void seekRelativeWithHud(int deltaSec) {
        if (player == null) return;
        long target = Math.max(0, player.getCurrentPosition() + deltaSec * 1000L);
        long dur = player.getDuration();
        if (dur > 0 && dur != C.TIME_UNSET) target = Math.min(dur, target);
        markUserSeek();
        lastStablePosMs = target;
        player.seekTo(target);
        if (scaleHud != null) {
            handler.removeCallbacks(hideScaleHudTask);
            scaleHud.animate().cancel();
            scaleHud.setAlpha(1f);
            String prefix = deltaSec >= 0 ? "+" + deltaSec + "s" : deltaSec + "s";
            scaleHudTitle.setText(prefix + " · " + Models.formatDurationSec(target / 1000.0));
            scaleHudHint.setText("D-Pad Left/Right to seek · OK Play/Pause");
            scaleHud.setVisibility(View.VISIBLE);
            handler.postDelayed(hideScaleHudTask, 950);
        }
    }

    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        isLandscape = newConfig.orientation == Configuration.ORIENTATION_LANDSCAPE;
        handler.post(() -> applyVideoScaleMode(false, false));
    }

    private void enterImmersive() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat ctrl = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        ctrl.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        ctrl.hide(WindowInsetsCompat.Type.systemBars());
    }

    @SuppressLint("ClickableViewAccessibility")
    private void bindViews() {
        playerView = findViewById(R.id.exo_player_view);
        gestureLayer = findViewById(R.id.player_gesture_layer);
        gestureHud = findViewById(R.id.player_gesture_hud);
        gestureBarTrack = findViewById(R.id.gesture_bar_track);
        gestureBarFill = findViewById(R.id.gesture_bar_fill);
        gestureHudIcon = findViewById(R.id.gesture_hud_icon);
        gestureHudPercent = findViewById(R.id.gesture_hud_percent);
        gestureHudLabel = findViewById(R.id.gesture_hud_label);
        scaleHud = findViewById(R.id.player_scale_hud);
        scaleHudTitle = findViewById(R.id.scale_hud_title);
        scaleHudHint = findViewById(R.id.scale_hud_hint);
        doubleTapLeftHud = findViewById(R.id.player_double_tap_left);
        doubleTapRightHud = findViewById(R.id.player_double_tap_right);
        doubleTapLeftText = findViewById(R.id.double_tap_left_text);
        doubleTapRightText = findViewById(R.id.double_tap_right_text);

        cinemaSubText = findViewById(R.id.cinema_subtitle_text);
        bufferingView = findViewById(R.id.player_buffering);
        controlsOverlay = findViewById(R.id.player_controls_overlay);
        titleView = findViewById(R.id.player_title);
        subtitleView = findViewById(R.id.player_subtitle);
        posTimeView = findViewById(R.id.player_pos_time);
        durTimeView = findViewById(R.id.player_dur_time);
        seekBar = findViewById(R.id.player_seekbar);
        btnPlayPause = findViewById(R.id.btn_player_play_pause);
        btnRotate = findViewById(R.id.btn_player_rotate);
        btnRew = findViewById(R.id.btn_player_rew);
        btnFwd = findViewById(R.id.btn_player_fwd);
        btnNextEp = findViewById(R.id.btn_player_next_ep);
        btnSpeed = findViewById(R.id.btn_player_speed);
        btnScale = findViewById(R.id.btn_player_scale);
        btnAudio = findViewById(R.id.btn_player_audio);
        btnCc = findViewById(R.id.btn_player_cc);
        btnQuality = findViewById(R.id.btn_player_quality);
        btnExternal = findViewById(R.id.btn_player_external);

        seekBar.setKeyProgressIncrement(15);
        UiHelper.applyTvFocusEffect(btnRew, 1.12f);
        UiHelper.applyTvFocusEffect(btnPlayPause, 1.12f);
        UiHelper.applyTvFocusEffect(btnFwd, 1.12f);
        UiHelper.applyTvFocusEffect(btnNextEp, 1.06f);
        UiHelper.applyTvFocusEffect(btnSpeed, 1.06f);
        UiHelper.applyTvFocusEffect(btnScale, 1.06f);
        UiHelper.applyTvFocusEffect(btnAudio, 1.06f);
        UiHelper.applyTvFocusEffect(btnCc, 1.06f);
        UiHelper.applyTvFocusEffect(btnQuality, 1.06f);
        UiHelper.applyTvFocusEffect(btnExternal, 1.06f);

        if (isTvDevice) {
            btnRotate.setVisibility(View.GONE);
            titleView.setTextSize(20f);
            subtitleView.setTextSize(13.5f);
            posTimeView.setTextSize(14f);
            durTimeView.setTextSize(14f);
            btnNextEp.setTextSize(14.5f);
            btnSpeed.setTextSize(14.5f);
            btnScale.setTextSize(14.5f);
            btnAudio.setTextSize(14.5f);
            btnCc.setTextSize(14.5f);
            btnQuality.setTextSize(14.5f);
            btnExternal.setTextSize(14.5f);
        } else if (UiHelper.isTablet(this)) {
            titleView.setTextSize(18f);
            subtitleView.setTextSize(12.5f);
        }

        if (playerView.getSubtitleView() != null) {
            playerView.getSubtitleView().setVisibility(View.GONE);
        }

        tapGestureDetector = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(@NonNull MotionEvent e) {
                return true;
            }

            @Override
            public boolean onSingleTapConfirmed(@NonNull MotionEvent e) {
                if (gestureMode == GESTURE_NONE && !pinchActive) {
                    toggleControls();
                    return true;
                }
                return false;
            }

            @Override
            public boolean onDoubleTap(@NonNull MotionEvent e) {
                if (gestureMode != GESTURE_NONE || pinchActive) return false;
                int width = Math.max(1, gestureLayer.getWidth());
                float x = e.getX();
                if (x < width * 0.42f) {
                    performDoubleTapSeek(-10);
                } else if (x > width * 0.58f) {
                    performDoubleTapSeek(10);
                } else {
                    togglePlayPause();
                    showCenterToastHud(
                            player != null && player.isPlaying() ? "Playing" : "Paused",
                            "Double-tap left/right to seek ±10s"
                    );
                }
                return true;
            }
        });

        scaleGestureDetector = new ScaleGestureDetector(this, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override
            public boolean onScaleBegin(@NonNull ScaleGestureDetector detector) {
                pinchSpanFactor = 1.0f;
                pinchTriggered = false;
                return true;
            }

            @Override
            public boolean onScale(@NonNull ScaleGestureDetector detector) {
                pinchSpanFactor *= detector.getScaleFactor();
                if (!pinchTriggered) {
                    if (pinchSpanFactor >= 1.14f) {
                        pinchTriggered = true;
                        setVideoScaleMode(1, true); // Fit Screen (Crop)
                    } else if (pinchSpanFactor <= 0.86f) {
                        pinchTriggered = true;
                        setVideoScaleMode(0, true); // Best Fit
                    }
                }
                return true;
            }
        });

        gestureLayer.setOnTouchListener(this::handleGestureTouch);

        findViewById(R.id.btn_player_back).setOnClickListener(v -> {
            persistProgress();
            finish();
        });
        findViewById(R.id.btn_player_rotate).setOnClickListener(v -> {
            isLandscape = !isLandscape;
            setRequestedOrientation(isLandscape
                    ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            scheduleHideControls();
        });

        findViewById(R.id.btn_player_rew).setOnClickListener(v -> seekRelative(-10));
        findViewById(R.id.btn_player_fwd).setOnClickListener(v -> seekRelative(10));
        btnPlayPause.setOnClickListener(v -> {
            if (player == null) return;
            if (player.isPlaying()) player.pause();
            else player.play();
            scheduleHideControls();
        });

        btnNextEp.setOnClickListener(v -> switchEpisode(session.playlistIndex + 1));
        btnSpeed.setOnClickListener(v -> showSpeedDialog());
        btnSpeed.setOnLongClickListener(v -> {
            applyPlaybackSpeed(1.0f, true);
            scheduleHideControls();
            return true;
        });
        btnScale.setOnClickListener(v -> {
            setVideoScaleMode((scaleModeIndex + 1) % SCALE_MODES.length, true);
            scheduleHideControls();
        });
        btnScale.setOnLongClickListener(v -> {
            showScaleModeDialog();
            return true;
        });
        btnAudio.setOnClickListener(v -> showAudioDialog());
        btnCc.setOnClickListener(v -> showSubtitleDialog());
        btnQuality.setOnClickListener(v -> showQualityDialog());
        btnExternal.setOnClickListener(v -> {
            persistProgress();
            UiHelper.openInExternalPlayer(this, session.file.url, session.title);
        });

        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (fromUser) {
                    posTimeView.setText(Models.formatDurationSec(progress));
                    // Seek immediately for TV D-Pad / keyboard Left-Right; touch waits for release
                    if (!isSeeking && !sb.isInTouchMode() && player != null) {
                        long targetMs = progress * 1000L;
                        markUserSeek();
                        lastStablePosMs = targetMs;
                        player.seekTo(targetMs);
                        scheduleHideControls();
                    }
                }
            }
            @Override public void onStartTrackingTouch(SeekBar sb) {
                isSeeking = true;
                markUserSeek();
            }
            @Override public void onStopTrackingTouch(SeekBar sb) {
                isSeeking = false;
                long targetMs = sb.getProgress() * 1000L;
                markUserSeek();
                lastStablePosMs = targetMs;
                if (player != null) player.seekTo(targetMs);
                scheduleHideControls();
            }
        });
    }

    private boolean handleGestureTouch(View v, MotionEvent event) {
        if (scaleGestureDetector != null) {
            scaleGestureDetector.onTouchEvent(event);
        }
        if (tapGestureDetector != null && !pinchActive) {
            tapGestureDetector.onTouchEvent(event);
        }
        int action = event.getActionMasked();
        int width = Math.max(1, v.getWidth());
        int height = Math.max(1, v.getHeight());

        if (action == MotionEvent.ACTION_POINTER_DOWN || event.getPointerCount() >= 2) {
            pinchActive = true;
            if (gestureMode != GESTURE_NONE) {
                gestureMode = GESTURE_NONE;
                handler.removeCallbacks(hideGestureHudTask);
                gestureHud.setVisibility(View.GONE);
            }
            return true;
        }

        if (pinchActive) {
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                pinchActive = false;
                pinchTriggered = false;
                gestureMode = GESTURE_NONE;
            }
            return true;
        }

        if (action == MotionEvent.ACTION_DOWN) {
            gestureMode = GESTURE_NONE;
            gestureStartX = event.getX();
            gestureStartY = event.getY();
            startBrightness = readCurrentBrightness();
            startVolumePct = readCurrentVolumePct();
            return true;
        }

        if (action == MotionEvent.ACTION_MOVE) {
            float dx = event.getX() - gestureStartX;
            float dy = gestureStartY - event.getY(); // Swipe up = positive increase

            if (gestureMode == GESTURE_NONE) {
                if (Math.abs(dy) > touchSlop && Math.abs(dy) > Math.abs(dx) * 1.15f) {
                    gestureMode = (gestureStartX < width * 0.5f) ? GESTURE_BRIGHTNESS : GESTURE_VOLUME;
                }
            }

            if (gestureMode == GESTURE_BRIGHTNESS) {
                float delta = dy / (height * 0.60f);
                float nextB = Math.max(0.02f, Math.min(1.0f, startBrightness + delta));
                applyWindowBrightness(nextB);
                showGestureHud(true, nextB, Math.round(nextB * 100) + "%", "Brightness", 0xFFF59E0B);
                return true;
            } else if (gestureMode == GESTURE_VOLUME) {
                float deltaPct = (dy / (height * 0.65f)) * 200f;
                float nextPct = Math.max(0f, Math.min(200f, startVolumePct + deltaPct));
                applyVolumeAndBoost(nextPct);
                boolean boosted = nextPct > 100.5f;
                showGestureHud(false, nextPct / 200f, Math.round(nextPct) + "%",
                        boosted ? "Boost" : "Volume", boosted ? 0xFFE50914 : 0xFF38BDF8);
                return true;
            }
            return true;
        }

        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            if (gestureMode != GESTURE_NONE) {
                handler.removeCallbacks(hideGestureHudTask);
                handler.postDelayed(hideGestureHudTask, 800);
            }
            gestureMode = GESTURE_NONE;
            return true;
        }
        return false;
    }

    private void performDoubleTapSeek(int deltaSec) {
        if (player == null) return;
        int side = deltaSec < 0 ? -1 : 1;
        long now = SystemClock.elapsedRealtime();
        if (doubleTapSide == side && (now - lastDoubleTapElapsedMs) <= 1150L) {
            doubleTapAccumSec += Math.abs(deltaSec);
        } else {
            doubleTapSide = side;
            doubleTapAccumSec = Math.abs(deltaSec);
        }
        lastDoubleTapElapsedMs = now;

        long target = Math.max(0L, player.getCurrentPosition() + deltaSec * 1000L);
        long dur = player.getDuration();
        if (dur > 0 && dur != C.TIME_UNSET) target = Math.min(dur, target);
        markUserSeek();
        lastStablePosMs = target;
        player.seekTo(target);

        handler.removeCallbacks(hideDoubleTapHudTask);
        if (side < 0 && doubleTapLeftHud != null) {
            if (doubleTapRightHud != null) doubleTapRightHud.setVisibility(View.GONE);
            doubleTapLeftHud.animate().cancel();
            doubleTapLeftHud.setAlpha(1f);
            doubleTapLeftText.setText("-" + doubleTapAccumSec + "s");
            doubleTapLeftHud.setVisibility(View.VISIBLE);
        } else if (side > 0 && doubleTapRightHud != null) {
            if (doubleTapLeftHud != null) doubleTapLeftHud.setVisibility(View.GONE);
            doubleTapRightHud.animate().cancel();
            doubleTapRightHud.setAlpha(1f);
            doubleTapRightText.setText("+" + doubleTapAccumSec + "s");
            doubleTapRightHud.setVisibility(View.VISIBLE);
        }
        handler.postDelayed(hideDoubleTapHudTask, 850L);
    }

    private void showCenterToastHud(String title, String hint) {
        if (scaleHud == null) return;
        handler.removeCallbacks(hideScaleHudTask);
        scaleHud.animate().cancel();
        scaleHud.setAlpha(1f);
        scaleHudTitle.setText(title);
        scaleHudHint.setText(hint);
        scaleHud.setVisibility(View.VISIBLE);
        handler.postDelayed(hideScaleHudTask, 1000L);
    }

    private void showSpeedDialog() {
        int checked = 3; // 1.0x
        for (int i = 0; i < PLAYBACK_SPEEDS.length; i++) {
            if (Math.abs(PLAYBACK_SPEEDS[i] - playbackSpeed) < 0.01f) {
                checked = i;
                break;
            }
        }
        new AlertDialog.Builder(this)
                .setTitle("Playback Speed")
                .setSingleChoiceItems(PLAYBACK_SPEED_LABELS, checked, (d, which) -> {
                    d.dismiss();
                    applyPlaybackSpeed(PLAYBACK_SPEEDS[which], true);
                    scheduleHideControls();
                })
                .setNegativeButton("Close", null)
                .show();
    }

    private void applyPlaybackSpeed(float speed, boolean showHud) {
        playbackSpeed = Math.max(0.25f, Math.min(2.0f, speed));
        if (player != null) {
            player.setPlaybackParameters(new PlaybackParameters(playbackSpeed));
        }
        String badge = formatSpeedBadge(playbackSpeed);
        if (btnSpeed != null) {
            btnSpeed.setText(badge);
            btnSpeed.setTextColor(Math.abs(playbackSpeed - 1.0f) < 0.01f ? 0xFFFFFFFF : 0xFFFCA5A5);
        }
        if (showHud) {
            showCenterToastHud("Speed · " + badge, "Long-press speed button to reset to 1x");
        }
    }

    public static String formatSpeedBadge(float speed) {
        if (Math.abs(speed - Math.round(speed)) < 0.01f) {
            return Math.round(speed) + "x";
        }
        String s = String.format(Locale.US, "%.2f", speed).replaceAll("0+$", "");
        return s + "x";
    }

    private float readCurrentBrightness() {
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        if (lp.screenBrightness >= 0f && lp.screenBrightness <= 1f) {
            return lp.screenBrightness;
        }
        try {
            int sys = Settings.System.getInt(getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, 128);
            return Math.max(0.05f, Math.min(1f, sys / 255f));
        } catch (Exception e) {
            return 0.5f;
        }
    }

    private void applyWindowBrightness(float level) {
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.screenBrightness = Math.max(0.02f, Math.min(1.0f, level));
        getWindow().setAttributes(lp);
    }

    private float readCurrentVolumePct() {
        if (currentVolumePct > 100f) return currentVolumePct;
        if (audioManager == null) return 50f;
        int max = Math.max(1, audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        int cur = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
        currentVolumePct = (cur / (float) max) * 100f;
        return currentVolumePct;
    }

    private void applyVolumeAndBoost(float targetPct) {
        currentVolumePct = Math.max(0f, Math.min(200f, targetPct));
        if (audioManager != null) {
            int max = Math.max(1, audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
            if (currentVolumePct <= 100f) {
                int targetVol = Math.round((currentVolumePct / 100f) * max);
                audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, targetVol, 0);
                setAudioBoostMillibels(0);
            } else {
                audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, max, 0);
                int gainMb = Math.round(((currentVolumePct - 100f) / 100f) * 1500f);
                setAudioBoostMillibels(gainMb);
            }
        }
    }

    private void attachLoudnessEnhancer(int audioSessionId) {
        releaseLoudnessEnhancer();
        // Keep LoudnessEnhancer unattached unless volume is boosted above 100% to avoid AudioTrack clock drift on tablets
        if (currentVolumePct <= 100.5f) return;
        if (audioSessionId == C.AUDIO_SESSION_ID_UNSET || audioSessionId == 0) return;
        try {
            loudnessEnhancer = new LoudnessEnhancer(audioSessionId);
            int gainMb = Math.round(((currentVolumePct - 100f) / 100f) * 1500f);
            loudnessEnhancer.setTargetGain(gainMb);
            loudnessEnhancer.setEnabled(true);
        } catch (Exception ignored) {
            loudnessEnhancer = null;
        }
    }

    private void setAudioBoostMillibels(int gainMb) {
        try {
            if (gainMb <= 0) {
                releaseLoudnessEnhancer();
                return;
            }
            if (loudnessEnhancer == null && player != null) {
                attachLoudnessEnhancer(player.getAudioSessionId());
            }
            if (loudnessEnhancer != null) {
                loudnessEnhancer.setTargetGain(gainMb);
                loudnessEnhancer.setEnabled(true);
            }
        } catch (Exception ignored) {}
    }

    private void releaseLoudnessEnhancer() {
        if (loudnessEnhancer != null) {
            try { loudnessEnhancer.release(); } catch (Exception ignored) {}
            loudnessEnhancer = null;
        }
    }

    private void showGestureHud(boolean isBrightness, float fillFraction, String pctText, String label, int barColor) {
        handler.removeCallbacks(hideGestureHudTask);
        gestureHud.animate().cancel();
        gestureHud.setAlpha(1f);
        FrameLayout.LayoutParams hlp = (FrameLayout.LayoutParams) gestureHud.getLayoutParams();
        hlp.gravity = Gravity.CENTER_VERTICAL | (isBrightness ? Gravity.START : Gravity.END);
        int sideMargin = UiHelper.dp(this, 28);
        hlp.leftMargin = isBrightness ? sideMargin : 0;
        hlp.rightMargin = isBrightness ? 0 : sideMargin;
        gestureHud.setLayoutParams(hlp);
        gestureHud.setVisibility(View.VISIBLE);

        gestureHudIcon.setImageResource(isBrightness ? R.drawable.ic_brightness : R.drawable.ic_volume);
        gestureHudPercent.setText(pctText);
        gestureHudLabel.setText(label);

        int trackH = gestureBarTrack.getHeight();
        if (trackH <= 0) trackH = UiHelper.dp(this, 120);
        int fillH = Math.max(0, Math.min(trackH, Math.round(trackH * fillFraction)));
        FrameLayout.LayoutParams flp = (FrameLayout.LayoutParams) gestureBarFill.getLayoutParams();
        flp.height = fillH;
        gestureBarFill.setLayoutParams(flp);
        gestureBarFill.setBackgroundColor(barColor);
    }

    private void loadSavedScaleMode() {
        app.ioExecutor.execute(() -> {
            String savedKey = app.repository.db.getSyncState("player_scale_mode");
            int idx = 0;
            if (savedKey != null && !savedKey.isEmpty()) {
                for (int i = 0; i < SCALE_MODES.length; i++) {
                    if (SCALE_MODES[i].key.equals(savedKey)) {
                        idx = i;
                        break;
                    }
                }
            }
            int finalIdx = idx;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                scaleModeIndex = finalIdx;
                applyVideoScaleMode(false, false);
            });
        });
    }

    private void setVideoScaleMode(int index, boolean showHud) {
        int safe = ((index % SCALE_MODES.length) + SCALE_MODES.length) % SCALE_MODES.length;
        scaleModeIndex = safe;
        applyVideoScaleMode(showHud, true);
    }

    private void applyVideoScaleMode(boolean showHud, boolean persist) {
        if (playerView == null) return;
        VideoScaleMode mode = SCALE_MODES[scaleModeIndex];
        playerView.setResizeMode(mode.resizeMode);

        AspectRatioFrameLayout contentFrame = findAspectRatioFrameLayout();
        if (contentFrame != null) {
            contentFrame.setResizeMode(mode.resizeMode);
            if (mode.forcedAspectRatio > 0f) {
                contentFrame.setAspectRatio(mode.forcedAspectRatio);
            } else if (naturalVideoAspectRatio > 0f) {
                contentFrame.setAspectRatio(naturalVideoAspectRatio);
            }
            contentFrame.requestLayout();
        }

        if (btnScale != null) {
            btnScale.setText(mode.shortLabel);
            btnScale.setTextColor(scaleModeIndex == 0 ? 0xFFFFFFFF : 0xFFFCA5A5);
        }

        if (persist) {
            String key = mode.key;
            app.ioExecutor.execute(() -> app.repository.db.setSyncState("player_scale_mode", key));
        }
        if (showHud) {
            showScaleHud(mode);
        }
    }

    private void showScaleHud(VideoScaleMode mode) {
        if (scaleHud == null) return;
        handler.removeCallbacks(hideScaleHudTask);
        scaleHud.animate().cancel();
        scaleHud.setAlpha(1f);
        scaleHudTitle.setText(mode.label);
        scaleHudHint.setText("Tap Fit to cycle · Long-press for all · Pinch to zoom");
        scaleHud.setVisibility(View.VISIBLE);
        handler.postDelayed(hideScaleHudTask, 1200);
    }

    private void showScaleModeDialog() {
        String[] labels = new String[SCALE_MODES.length];
        for (int i = 0; i < SCALE_MODES.length; i++) {
            labels[i] = SCALE_MODES[i].label;
        }
        new AlertDialog.Builder(this)
                .setTitle("Video Size / Aspect Ratio")
                .setSingleChoiceItems(labels, scaleModeIndex, (d, which) -> {
                    d.dismiss();
                    setVideoScaleMode(which, true);
                    scheduleHideControls();
                })
                .setNegativeButton("Close", null)
                .show();
    }

    private AspectRatioFrameLayout findAspectRatioFrameLayout() {
        if (playerView == null) return null;
        View direct = playerView.findViewById(androidx.media3.ui.R.id.exo_content_frame);
        if (direct instanceof AspectRatioFrameLayout) {
            return (AspectRatioFrameLayout) direct;
        }
        return findAspectRatioRecursive(playerView);
    }

    private AspectRatioFrameLayout findAspectRatioRecursive(ViewGroup group) {
        for (int i = 0; i < group.getChildCount(); i++) {
            View c = group.getChildAt(i);
            if (c instanceof AspectRatioFrameLayout) return (AspectRatioFrameLayout) c;
            if (c instanceof ViewGroup) {
                AspectRatioFrameLayout found = findAspectRatioRecursive((ViewGroup) c);
                if (found != null) return found;
            }
        }
        return null;
    }

    private void initPlayer(boolean preferSoftwareVideo) {
        releaseLoudnessEnhancer();
        if (player != null) {
            try {
                playerView.setPlayer(null);
                player.release();
            } catch (Exception ignored) {}
            player = null;
        }

        // PREFER Jellyfin FFmpeg Audio Decoder first so Dolby E-AC3 / AC3 / DTS / TrueHD never hit broken tablet OEM codecs
        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(this)
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
                .setEnableDecoderFallback(true);

        if (preferSoftwareVideo) {
            renderersFactory.setMediaCodecSelector((mimeType, requiresSecureDecoder, requiresTunnelingDecoder) -> {
                List<MediaCodecInfo> infos = MediaCodecUtil.getDecoderInfos(
                        mimeType, requiresSecureDecoder, requiresTunnelingDecoder);
                if (mimeType != null && mimeType.startsWith("video/")) {
                    List<MediaCodecInfo> sw = new ArrayList<>();
                    List<MediaCodecInfo> hw = new ArrayList<>();
                    for (MediaCodecInfo info : infos) {
                        String n = info.name != null ? info.name.toLowerCase(Locale.US) : "";
                        if (info.softwareOnly || !info.hardwareAccelerated
                                || n.startsWith("c2.android.") || n.startsWith("omx.google.")) {
                            sw.add(info);
                        } else {
                            hw.add(info);
                        }
                    }
                    sw.addAll(hw);
                    return sw;
                }
                return infos;
            });
        }

        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(20_000, 90_000, 2_500, 5_000)
                .build();

        AudioAttributes audioAttrs = new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build();

        player = new ExoPlayer.Builder(this, renderersFactory)
                .setLoadControl(loadControl)
                .setAudioAttributes(audioAttrs, true)
                .setHandleAudioBecomingNoisy(true)
                .build();
        playerView.setPlayer(player);
        player.setPlaybackParameters(new PlaybackParameters(playbackSpeed));
        applyVideoScaleMode(false, false);

        player.addListener(new Player.Listener() {
            @Override
            public void onAudioSessionIdChanged(int audioSessionId) {
                if (currentVolumePct > 100.5f) attachLoudnessEnhancer(audioSessionId);
            }

            @Override
            public void onVideoSizeChanged(@NonNull VideoSize videoSize) {
                if (videoSize.width > 0 && videoSize.height > 0) {
                    float ratio = (videoSize.width * videoSize.pixelWidthHeightRatio) / videoSize.height;
                    if (ratio > 0.1f && ratio < 10f) {
                        naturalVideoAspectRatio = ratio;
                    }
                    handler.post(() -> applyVideoScaleMode(false, false));
                }
            }

            @Override
            public void onRenderedFirstFrame() {
                handler.post(() -> applyVideoScaleMode(false, false));
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                bufferingView.setVisibility(state == Player.STATE_BUFFERING ? View.VISIBLE : View.GONE);
                if (state == Player.STATE_READY) {
                    ioRetryCount = 0;
                    if (currentVolumePct > 100.5f && loudnessEnhancer == null) {
                        attachLoudnessEnhancer(player.getAudioSessionId());
                    }
                    if (!didInitialSeek && session.startTime > 5) {
                        didInitialSeek = true;
                        long targetMs = (long) (session.startTime * 1000);
                        markUserSeek();
                        lastStablePosMs = targetMs;
                        player.seekTo(targetMs);
                    }
                }
                if (state == Player.STATE_ENDED) {
                    persistProgress();
                    if (hasNextEpisode()) switchEpisode(session.playlistIndex + 1);
                }
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                btnPlayPause.setImageResource(isPlaying ? R.drawable.ic_pause : R.drawable.ic_play);
            }

            @Override
            public void onTracksChanged(@NonNull Tracks tracks) {
                autoSelectNonForcedSubtitle(tracks);
                updateCcButtonStyle();
            }

            @Override
            public void onCues(@NonNull CueGroup cueGroup) {
                if (!subtitlesEnabled) {
                    cinemaSubText.setVisibility(View.GONE);
                    return;
                }
                StringBuilder sb = new StringBuilder();
                for (Cue cue : cueGroup.cues) {
                    if (cue.text != null && cue.text.length() > 0) {
                        if (sb.length() > 0) sb.append('\n');
                        sb.append(cue.text);
                    }
                }
                String txt = sb.toString().trim();
                long delayMs = Math.max(0L, Math.round(subDelaySec * 1000.0));
                if (delayMs == 0L) {
                    renderCueText(txt);
                } else {
                    handler.postDelayed(() -> renderCueText(txt), delayMs);
                }
            }

            @Override
            public void onPlayerError(@NonNull PlaybackException error) {
                bufferingView.setVisibility(View.GONE);
                long resumeMs = Math.max(lastStablePosMs, (long) (session.startTime * 1000));

                // 1. Hardware video decoder crashed mid-stream (e.g. ERROR_CODE_DECODING_FAILED on tablet) — seamlessly switch to Software Video Decoder
                boolean isDecoderError = error.errorCode >= 4000 && error.errorCode < 5000;
                if (isDecoderError && !useSoftwareVideoFallback) {
                    useSoftwareVideoFallback = true;
                    Toast.makeText(PlayerActivity.this,
                            "Switched to Software Video Decoder for compatibility...",
                            Toast.LENGTH_SHORT).show();
                    initPlayer(true);
                    openCurrentSessionInternal(!retriedWithoutSubs, resumeMs);
                    return;
                }

                // 2. Broken external .srt/.vtt subtitle inside MergingMediaSource must never kill the video
                if (!retriedWithoutSubs && !session.externalSubtitles.isEmpty()) {
                    retriedWithoutSubs = true;
                    Toast.makeText(PlayerActivity.this,
                            "External subtitle unavailable — playing video with embedded tracks...",
                            Toast.LENGTH_SHORT).show();
                    openCurrentSessionInternal(false, resumeMs);
                    return;
                }

                // 3. Transient BDIX network / timeout hiccup — auto-reconnect at last stable timestamp
                boolean isIoError = error.errorCode >= 2000 && error.errorCode < 3000;
                if (isIoError && ioRetryCount < 2) {
                    ioRetryCount++;
                    bufferingView.setVisibility(View.VISIBLE);
                    long finalResumeMs = resumeMs;
                    handler.postDelayed(() -> {
                        if (!isFinishing() && !isDestroyed() && player != null) {
                            openCurrentSessionInternal(!retriedWithoutSubs, finalResumeMs);
                        }
                    }, 1200L);
                    return;
                }

                // 4. Auto-failover to another working mirror / server quality if available
                failedStreamUrls.add(session.file.url);
                for (Models.QualityOption alt : session.qualityOptions) {
                    if (alt.file.online && !failedStreamUrls.contains(alt.file.url)
                            && ServerConfig.isAllowedUrl(alt.file.url)) {
                        Toast.makeText(PlayerActivity.this,
                                "Switching to backup mirror (" + alt.serverLabel + ")...",
                                Toast.LENGTH_SHORT).show();
                        double resumeSec = resumeMs / 1000.0;
                        session = new Models.PlaybackSession(
                                session.mediaId, session.title, alt.file, alt.subtitles, null,
                                session.playlist, session.playlistIndex, alt.quality, alt.serverLabel,
                                session.qualityOptions, resumeSec);
                        openCurrentSession();
                        return;
                    }
                }

                Toast.makeText(PlayerActivity.this,
                        "Playback error (" + error.getErrorCodeName() + "). Try another quality or tap VLC.",
                        Toast.LENGTH_LONG).show();
            }
        });
    }

    private void renderCueText(String txt) {
        if (!subtitlesEnabled || txt == null || txt.isEmpty()) {
            cinemaSubText.setVisibility(View.GONE);
        } else {
            cinemaSubText.setTextSize(subTextSp);
            cinemaSubText.setText(txt);
            cinemaSubText.setVisibility(View.VISIBLE);
        }
    }

    private void openCurrentSession() {
        retriedWithoutSubs = false;
        ioRetryCount = 0;
        jumpRecoveryCount = 0;
        if (useSoftwareVideoFallback) {
            useSoftwareVideoFallback = false;
            initPlayer(false);
        }
        openCurrentSessionInternal(true, (long) (session.startTime * 1000));
    }

    private void openCurrentSessionInternal(boolean includeExternalSubtitles, long resumePosMs) {
        long safeStartMs = resumePosMs > 5000L ? resumePosMs : 0L;
        didInitialSeek = true;
        didAutoSelectSub = false;
        lastSavedSec = safeStartMs / 1000.0;
        lastStablePosMs = safeStartMs;
        markUserSeek();
        cinemaSubText.setVisibility(View.GONE);
        bufferingView.setVisibility(View.VISIBLE);

        List<String> titleParts = new ArrayList<>();
        titleParts.add(session.title);
        if (session.seasonName != null && !session.seasonName.isEmpty()) titleParts.add(session.seasonName);
        if (!session.file.label.isEmpty()) titleParts.add(session.file.label);
        titleView.setText(String.join(" · ", titleParts));

        List<String> subParts = new ArrayList<>();
        if (session.qualityLabel != null && !session.qualityLabel.isEmpty()) subParts.add(session.qualityLabel);
        if (session.serverLabel != null && !session.serverLabel.isEmpty()) subParts.add(session.serverLabel);
        subParts.add(useSoftwareVideoFallback ? "SW Video + FFmpeg Audio" : "HW Video + FFmpeg Audio");
        subtitleView.setText(String.join(" · ", subParts));

        btnNextEp.setVisibility(hasNextEpisode() ? View.VISIBLE : View.GONE);
        btnQuality.setVisibility(session.qualityOptions.size() > 1 ? View.VISIBLE : View.GONE);

        boolean isLocalFile = session.file.url.startsWith("content://") || session.file.url.startsWith("file://");
        String playUrl = isLocalFile ? session.file.url : ServerConfig.sanitizeMediaUrl(session.file.url);
        DataSource.Factory dsFactory = isLocalFile
                ? new DefaultDataSource.Factory(this)
                : new OkHttpDataSource.Factory(app.streamingClient)
                        .setDefaultRequestProperties(ServerConfig.mediaHeadersFor(playUrl));

        MediaItem.Builder mb = new MediaItem.Builder().setUri(Uri.parse(playUrl));
        if (includeExternalSubtitles && !session.externalSubtitles.isEmpty()) {
            List<MediaItem.SubtitleConfiguration> subConfigs = new ArrayList<>();
            for (int i = 0; i < session.externalSubtitles.size(); i++) {
                Models.MediaFileEntry ext = session.externalSubtitles.get(i);
                if (!ServerConfig.isAllowedUrl(ext.url)) continue;
                String safeSubUrl = ServerConfig.sanitizeMediaUrl(ext.url);
                String lower = safeSubUrl.toLowerCase(Locale.US);
                String mime = lower.endsWith(".vtt") ? MimeTypes.TEXT_VTT
                        : (lower.endsWith(".ass") || lower.endsWith(".ssa") ? MimeTypes.TEXT_SSA : MimeTypes.APPLICATION_SUBRIP);
                subConfigs.add(new MediaItem.SubtitleConfiguration.Builder(Uri.parse(safeSubUrl))
                        .setMimeType(mime)
                        .setLanguage("en")
                        .setLabel(ext.name)
                        .setSelectionFlags(i == 0 ? C.SELECTION_FLAG_DEFAULT : 0)
                        .build());
            }
            if (!subConfigs.isEmpty()) mb.setSubtitleConfigurations(subConfigs);
        }

        DefaultExtractorsFactory extractorsFactory = new DefaultExtractorsFactory()
                .setConstantBitrateSeekingEnabled(true)
                .setMp4ExtractorFlags(Mp4Extractor.FLAG_WORKAROUND_IGNORE_EDIT_LISTS);
        DefaultMediaSourceFactory msFactory = new DefaultMediaSourceFactory(dsFactory, extractorsFactory)
                .setLoadErrorHandlingPolicy(new DefaultLoadErrorHandlingPolicy(6));
        player.setMediaSource(msFactory.createMediaSource(mb.build()), safeStartMs);
        player.setPlaybackParameters(new PlaybackParameters(playbackSpeed));
        player.prepare();
        player.play();
    }

    /**
     * Auto-pick full dialogue English subtitle track (never Forced/Signs-only!).
     */
    private void autoSelectNonForcedSubtitle(Tracks tracks) {
        if (didAutoSelectSub) return;
        Tracks.Group bestGroup = null;
        int bestTrackIdx = -1;
        int bestScore = -1;

        for (Tracks.Group g : tracks.getGroups()) {
            if (g.getType() != C.TRACK_TYPE_TEXT) continue;
            for (int i = 0; i < g.length; i++) {
                if (!g.isTrackSupported(i)) continue;
                Format f = g.getTrackFormat(i);
                String label = f.label != null ? f.label.toLowerCase(Locale.US) : "";
                String lang = f.language != null ? f.language.toLowerCase(Locale.US) : "";
                boolean forced = (f.selectionFlags & C.SELECTION_FLAG_FORCED) != 0
                        || label.contains("forced") || label.contains("signs");
                boolean isEng = lang.startsWith("en") || label.contains("english");
                int score = (forced ? 0 : 100) + (isEng ? 50 : 10);
                if (score > bestScore) {
                    bestScore = score;
                    bestGroup = g;
                    bestTrackIdx = i;
                }
            }
        }

        if (bestGroup != null) {
            didAutoSelectSub = true;
            subtitlesEnabled = true;
            TrackSelectionParameters params = player.getTrackSelectionParameters().buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                    .setOverrideForType(new TrackSelectionOverride(bestGroup.getMediaTrackGroup(), bestTrackIdx))
                    .build();
            player.setTrackSelectionParameters(params);
        }
    }

    private void updateCcButtonStyle() {
        btnCc.setText(subtitlesEnabled ? "CC On" : "CC");
        btnCc.setTextColor(subtitlesEnabled ? 0xFFFCA5A5 : 0xFFFFFFFF);
    }

    private void showAudioDialog() {
        List<String> labels = new ArrayList<>();
        List<Tracks.Group> groups = new ArrayList<>();
        List<Integer> indices = new ArrayList<>();
        int checked = -1;

        for (Tracks.Group g : player.getCurrentTracks().getGroups()) {
            if (g.getType() != C.TRACK_TYPE_AUDIO) continue;
            for (int i = 0; i < g.length; i++) {
                if (!g.isTrackSupported(i)) continue;
                Format f = g.getTrackFormat(i);
                List<String> parts = new ArrayList<>();
                if (f.language != null && !f.language.isEmpty()) parts.add(f.language.toUpperCase(Locale.US));
                if (f.label != null && !f.label.isEmpty()) parts.add(f.label);
                if (f.sampleMimeType != null) parts.add(f.sampleMimeType.replace("audio/", "").toUpperCase(Locale.US));
                if (f.channelCount > 0) parts.add(f.channelCount + "ch");
                labels.add(parts.isEmpty() ? "Audio Track " + (labels.size() + 1) : String.join(" · ", parts));
                groups.add(g);
                indices.add(i);
                if (g.isTrackSelected(i)) checked = labels.size() - 1;
            }
        }

        if (labels.isEmpty()) {
            Toast.makeText(this, "Default audio track active", Toast.LENGTH_SHORT).show();
            return;
        }

        new AlertDialog.Builder(this)
                .setTitle("Audio Tracks (Dual / Multi Audio)")
                .setSingleChoiceItems(labels.toArray(new String[0]), checked, (d, which) -> {
                    TrackSelectionParameters params = player.getTrackSelectionParameters().buildUpon()
                            .setOverrideForType(new TrackSelectionOverride(groups.get(which).getMediaTrackGroup(), indices.get(which)))
                            .build();
                    player.setTrackSelectionParameters(params);
                    d.dismiss();
                })
                .setNegativeButton("Close", null)
                .show();
    }

    private void showSubtitleDialog() {
        List<String> labels = new ArrayList<>();
        List<Tracks.Group> groups = new ArrayList<>();
        List<Integer> indices = new ArrayList<>();
        labels.add("Off");
        groups.add(null);
        indices.add(-1);
        int checked = subtitlesEnabled ? -1 : 0;

        for (Tracks.Group g : player.getCurrentTracks().getGroups()) {
            if (g.getType() != C.TRACK_TYPE_TEXT) continue;
            for (int i = 0; i < g.length; i++) {
                if (!g.isTrackSupported(i)) continue;
                Format f = g.getTrackFormat(i);
                List<String> parts = new ArrayList<>();
                if (f.language != null && !f.language.isEmpty()) parts.add(f.language.toUpperCase(Locale.US));
                if (f.label != null && !f.label.isEmpty()) parts.add(f.label);
                labels.add(parts.isEmpty() ? "Subtitle Track " + labels.size() : String.join(" · ", parts));
                groups.add(g);
                indices.add(i);
                if (subtitlesEnabled && g.isTrackSelected(i)) checked = labels.size() - 1;
            }
        }

        new AlertDialog.Builder(this)
                .setTitle(String.format(Locale.US, "Subtitles (Size %.0fsp · Sync %+.1fs)", subTextSp, subDelaySec))
                .setSingleChoiceItems(labels.toArray(new String[0]), checked, (d, which) -> {
                    if (which == 0) {
                        subtitlesEnabled = false;
                        cinemaSubText.setVisibility(View.GONE);
                        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build());
                    } else {
                        subtitlesEnabled = true;
                        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                                .setOverrideForType(new TrackSelectionOverride(groups.get(which).getMediaTrackGroup(), indices.get(which)))
                                .build());
                    }
                    updateCcButtonStyle();
                    d.dismiss();
                })
                .setNeutralButton("Size / Sync", (d, w) -> showSubtitleStyleDialog())
                .setNegativeButton("Close", null)
                .show();
    }

    private void showSubtitleStyleDialog() {
        String[] opts = {
                "Size: Small (16sp)",
                "Size: Medium (20sp)",
                "Size: Large (26sp)",
                "Size: Extra Large (32sp)",
                "Sync Delay: 0.0s (Reset)",
                "Sync Delay: +0.5s",
                "Sync Delay: +1.0s",
                "Sync Delay: +2.0s"
        };
        new AlertDialog.Builder(this)
                .setTitle("Subtitle Size & Timing Sync")
                .setItems(opts, (d, which) -> {
                    if (which == 0) subTextSp = 16f;
                    else if (which == 1) subTextSp = 20f;
                    else if (which == 2) subTextSp = 26f;
                    else if (which == 3) subTextSp = 32f;
                    else if (which == 4) subDelaySec = 0.0;
                    else if (which == 5) subDelaySec += 0.5;
                    else if (which == 6) subDelaySec += 1.0;
                    else if (which == 7) subDelaySec += 2.0;
                    cinemaSubText.setTextSize(subTextSp);
                    Toast.makeText(this, String.format(Locale.US, "Subtitles: %.0fsp · Sync %+.1fs", subTextSp, subDelaySec), Toast.LENGTH_SHORT).show();
                })
                .show();
    }

    private void showQualityDialog() {
        if (session.qualityOptions.isEmpty()) return;
        String[] labels = new String[session.qualityOptions.size()];
        int checked = 0;
        for (int i = 0; i < session.qualityOptions.size(); i++) {
            Models.QualityOption o = session.qualityOptions.get(i);
            labels[i] = o.label;
            if (o.file.url.equals(session.file.url)) checked = i;
        }
        new AlertDialog.Builder(this)
                .setTitle("Switch Server & Quality")
                .setSingleChoiceItems(labels, checked, (d, which) -> {
                    d.dismiss();
                    Models.QualityOption opt = session.qualityOptions.get(which);
                    if (!opt.file.url.equals(session.file.url)) switchQuality(opt);
                })
                .setNegativeButton("Close", null)
                .show();
    }

    private boolean hasNextEpisode() {
        return !session.playlist.isEmpty() && session.playlistIndex < session.playlist.size() - 1;
    }

    private void switchEpisode(int nextIdx) {
        if (nextIdx < 0 || nextIdx >= session.playlist.size()) return;
        persistProgress();
        Models.MediaFileEntry nextFile = session.playlist.get(nextIdx);
        session = new Models.PlaybackSession(
                session.mediaId, session.title, nextFile, session.externalSubtitles,
                session.seasonName, session.playlist, nextIdx,
                nextFile.quality != null ? nextFile.quality : session.qualityLabel,
                session.serverLabel, session.qualityOptions, 0);
        openCurrentSession();
    }

    private void switchQuality(Models.QualityOption opt) {
        double resumeSec = player != null ? player.getCurrentPosition() / 1000.0 : 0;
        persistProgress();
        session = new Models.PlaybackSession(
                session.mediaId, session.title, opt.file, opt.subtitles, null,
                session.playlist, session.playlistIndex, opt.quality, opt.serverLabel,
                session.qualityOptions, resumeSec);
        openCurrentSession();
    }

    private void seekRelative(int deltaSec) {
        if (player == null) return;
        long target = Math.max(0, player.getCurrentPosition() + deltaSec * 1000L);
        long dur = player.getDuration();
        if (dur > 0 && dur != C.TIME_UNSET) target = Math.min(dur, target);
        markUserSeek();
        lastStablePosMs = target;
        player.seekTo(target);
        scheduleHideControls();
    }

    private void toggleControls() {
        controlsVisible = !controlsVisible;
        controlsOverlay.setVisibility(controlsVisible ? View.VISIBLE : View.GONE);
        updateSubtitleMargin();
        if (controlsVisible) scheduleHideControls();
    }

    private void updateSubtitleMargin() {
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) cinemaSubText.getLayoutParams();
        lp.bottomMargin = UiHelper.dp(this, controlsVisible ? 96 : 26);
        cinemaSubText.setLayoutParams(lp);
    }

    private void scheduleHideControls() {
        handler.removeCallbacks(hideControlsTask);
        handler.postDelayed(hideControlsTask, isTvDevice ? 6000 : 4000);
    }

    private void persistProgress() {
        if (player == null) return;
        long rawPos = player.getCurrentPosition();
        long rawDur = player.getDuration();
        double currentSec = (rawPos == C.TIME_UNSET || rawPos < 0) ? 0.0 : (rawPos / 1000.0);
        double pos = lastStablePosMs > 5000L ? (lastStablePosMs / 1000.0) : currentSec;
        double dur = (rawDur == C.TIME_UNSET || rawDur < 0) ? 0.0 : (rawDur / 1000.0);
        if (pos < 5) return;
        Models.PlaybackSession snap = session;
        app.ioExecutor.execute(() -> app.repository.db.upsertWatchProgress(
                snap.mediaId, snap.file.url, pos, dur, snap.file.name, snap.seasonName,
                snap.file.label.isEmpty() ? null : snap.file.label));
    }

    @Override
    protected void onPause() {
        persistProgress();
        if (player != null) player.pause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        persistProgress();
        releaseLoudnessEnhancer();
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }
}
