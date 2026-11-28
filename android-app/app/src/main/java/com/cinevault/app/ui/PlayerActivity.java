package com.cinevault.app.ui;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.drawable.Icon;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Rational;
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
import androidx.annotation.RequiresApi;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.lifecycle.Lifecycle;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.Tracks;
import androidx.media3.common.text.Cue;
import androidx.media3.common.text.CueGroup;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import com.cinevault.app.CineVaultApp;
import com.cinevault.app.R;
import com.cinevault.app.data.Models;
import com.cinevault.app.player.PlaybackManager;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * Fullscreen Cinema Video Player backed by shared PlaybackManager + MediaPlaybackService.
 * Supports YouTube Premium-style:
 * - In-app Minimize to docked live Mini-Player Drawer Bar (zero re-buffering)
 * - Native Android Picture-in-Picture (PiP) with -10s / Play-Pause / +10s RemoteActions
 * - Screen-off / Background Audio Playback with lock-screen & notification media controls
 * - Double-tap left/right +/-10s seek, playback speed (0.25x-2x), VLC brightness/200% volume boost,
 *   8 video scale/aspect modes + pinch-to-zoom, Dual/Multi-Audio, Subtitles + size/sync, Quality switcher, TV D-Pad.
 */
@OptIn(markerClass = UnstableApi.class)
public final class PlayerActivity extends AppCompatActivity {
    public static final String EXTRA_SESSION = "playback_session";
    public static final String EXTRA_RESUME_ACTIVE = "resume_active_playback";

    private static final String ACTION_PIP_CONTROL = "com.cinevault.app.PIP_CONTROL";
    private static final String EXTRA_PIP_CMD = "pip_cmd";
    private static final String PIP_CMD_REW = "rew";
    private static final String PIP_CMD_PLAY_PAUSE = "play_pause";
    private static final String PIP_CMD_FWD = "fwd";

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
    private PlaybackManager pm;
    private PlayerView playerView;
    private AudioManager audioManager;
    private ScaleGestureDetector scaleGestureDetector;
    private GestureDetector tapGestureDetector;

    private View gestureLayer, gestureHud, gestureBarTrack, gestureBarFill;
    private View scaleHud, doubleTapLeftHud, doubleTapRightHud;
    private ImageView gestureHudIcon;
    private TextView gestureHudPercent, gestureHudLabel, scaleHudTitle, scaleHudHint;
    private TextView doubleTapLeftText, doubleTapRightText;

    private TextView cinemaSubText, titleView, subtitleView, posTimeView, durTimeView;
    private TextView btnNextEp, btnBgPlay, btnSpeed, btnScale, btnAudio, btnCc, btnQuality, btnExternal;
    private ImageButton btnPlayPause;
    private View btnMinimize, btnPip, btnRotate, btnRew, btnFwd;
    private SeekBar seekBar;
    private View bufferingView, controlsOverlay;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean isTvDevice = false;
    private boolean pipSupported = false;
    private boolean controlsVisible = true;
    private boolean isLandscape = true;
    private boolean isSeeking = false;
    private boolean minimizingToDrawer = false;
    private boolean explicitClose = false;
    private boolean pipReceiverRegistered = false;

    // VLC-style Video Size / Aspect Ratio & Double-Tap state
    private int scaleModeIndex = 0;
    private int doubleTapSide = 0;
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

    private final BroadcastReceiver pipActionReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || !ACTION_PIP_CONTROL.equals(intent.getAction())) return;
            String cmd = intent.getStringExtra(EXTRA_PIP_CMD);
            if (PIP_CMD_REW.equals(cmd)) {
                pm.seekRelative(-10);
            } else if (PIP_CMD_FWD.equals(cmd)) {
                pm.seekRelative(10);
            } else if (PIP_CMD_PLAY_PAUSE.equals(cmd)) {
                pm.togglePlayPause();
                updatePipParamsIfSupported();
            }
        }
    };

    private final PlaybackManager.Listener playbackListener = new PlaybackManager.Listener() {
        @Override
        public void onSessionChanged(Models.PlaybackSession session) {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                bindSessionUi(session);
                updatePipParamsIfSupported();
            });
        }

        @Override
        public void onPlaybackStateChanged(int state, boolean isPlaying) {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                boolean inPip = isCurrentlyInPip();
                bufferingView.setVisibility(!inPip && state == Player.STATE_BUFFERING ? View.VISIBLE : View.GONE);
                btnPlayPause.setImageResource(isPlaying ? R.drawable.ic_pause : R.drawable.ic_play);
                updatePipParamsIfSupported();
            });
        }

        @Override
        public void onPositionUpdated(long posMs, long durMs) {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || isSeeking || durMs <= 0L) return;
                int durSec = (int) (durMs / 1000L);
                int posSecInt = (int) (posMs / 1000L);
                posTimeView.setText(Models.formatDurationSec(posMs / 1000.0));
                durTimeView.setText(Models.formatDurationSec(durMs / 1000.0));
                if (seekBar.getMax() != durSec) seekBar.setMax(durSec);
                seekBar.setProgress(posSecInt);
            });
        }

        @Override
        public void onVideoSizeChanged(float aspectRatio) {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                applyVideoScaleMode(false, false);
                updatePipParamsIfSupported();
            });
        }

        @Override
        public void onTracksChanged(Tracks tracks) {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                updateCcButtonStyle();
            });
        }

        @Override
        public void onCues(CueGroup cueGroup) {
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (!pm.isSubtitlesEnabled()) {
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
                long delayMs = Math.max(0L, Math.round(pm.getSubDelaySec() * 1000.0));
                if (delayMs == 0L) renderCueText(txt);
                else handler.postDelayed(() -> renderCueText(txt), delayMs);
            });
        }

        @Override
        public void onStatusMessage(String message) {
            runOnUiThread(() -> {
                if (!isFinishing() && !isDestroyed() && message != null && !message.isEmpty()) {
                    Toast.makeText(PlayerActivity.this, message, Toast.LENGTH_SHORT).show();
                    Models.PlaybackSession s = pm.getSession();
                    if (s != null) bindSessionUi(s);
                }
            });
        }

        @Override
        public void onSessionStopped() {
            runOnUiThread(() -> {
                if (!isFinishing() && !isDestroyed()) {
                    explicitClose = true;
                    finish();
                }
            });
        }
    };

    private final Runnable hideControlsTask = () -> {
        if (pm != null && pm.isPlaying() && !isCurrentlyInPip()) {
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_player);
        app = CineVaultApp.get();
        pm = app.playbackManager;
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        touchSlop = ViewConfiguration.get(this).getScaledTouchSlop();

        isTvDevice = UiHelper.isAndroidTv(this);
        pipSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !isTvDevice
                && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);

        pm.setSubTextSp(isTvDevice ? 26f : (UiHelper.isTablet(this) ? 23f : 20f));

        enterImmersive();
        bindViews();

        if (!handleIncomingIntent(getIntent())) {
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
                handleBackOrCloseAction();
            }
        });

        registerPipReceiver();
        pm.addListener(playbackListener);
        pm.setFullscreenActive(true);
        pm.setMinimizedInApp(false);
        pm.attachPlayerView(playerView);

        loadSavedScaleMode();
        Models.PlaybackSession cur = pm.getSession();
        if (cur != null) bindSessionUi(cur);
        syncUiWithCurrentPlayerState();
        updatePipParamsIfSupported();
        requestNotificationPermissionOnce();
        scheduleHideControls();

        if (isTvDevice && btnPlayPause != null) {
            btnPlayPause.post(() -> btnPlayPause.requestFocus());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        minimizingToDrawer = false;
        explicitClose = false;
        pm.setFullscreenActive(true);
        pm.setMinimizedInApp(false);
        if (handleIncomingIntent(intent)) {
            pm.attachPlayerView(playerView);
            Models.PlaybackSession cur = pm.getSession();
            if (cur != null) bindSessionUi(cur);
            syncUiWithCurrentPlayerState();
            updatePipParamsIfSupported();
            scheduleHideControls();
        }
    }

    private boolean handleIncomingIntent(Intent intent) {
        if (intent != null) {
            boolean resumeActive = intent.getBooleanExtra(EXTRA_RESUME_ACTIVE, false);
            if (resumeActive && pm.hasActiveSession()) {
                pm.setMinimizedInApp(false);
                return true;
            }
            Object extra = intent.getSerializableExtra(EXTRA_SESSION);
            if (extra instanceof Models.PlaybackSession) {
                Models.PlaybackSession incoming = (Models.PlaybackSession) extra;
                if (!pm.openSession(this, incoming, false)) {
                    Toast.makeText(this, "Blocked untrusted stream URL.", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        }
        return pm.hasActiveSession();
    }

    private void requestNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        app.ioExecutor.execute(() -> {
            if ("1".equals(app.repository.db.getSyncState("notif_perm_asked"))) return;
            app.repository.db.setSyncState("notif_perm_asked", "1");
            runOnUiThread(() -> {
                if (!isFinishing() && !isDestroyed()) {
                    ActivityCompat.requestPermissions(
                            PlayerActivity.this,
                            new String[]{Manifest.permission.POST_NOTIFICATIONS},
                            4102
                    );
                }
            });
        });
    }

    private void registerPipReceiver() {
        if (pipReceiverRegistered || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        IntentFilter filter = new IntentFilter(ACTION_PIP_CONTROL);
        ContextCompat.registerReceiver(this, pipActionReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        pipReceiverRegistered = true;
    }

    private void handleBackOrCloseAction() {
        pm.persistProgress();
        if (!isTvDevice && pm.isPlaying() && pm.isBackgroundPlayEnabled()) {
            minimizeToInAppDrawer(false);
        } else {
            explicitClose = true;
            pm.stopAndRelease();
            finish();
        }
    }

    private void minimizeToInAppDrawer(boolean openMainActivity) {
        minimizingToDrawer = true;
        pm.persistProgress();
        pm.setFullscreenActive(false);
        pm.setMinimizedInApp(true);
        pm.detachPlayerView(playerView);
        if (openMainActivity) {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
        }
        finish();
    }

    private boolean isCurrentlyInPip() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode();
    }

    private void enterPipModeSafely() {
        if (!pipSupported || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            minimizeToInAppDrawer(true);
            return;
        }
        if (isCurrentlyInPip() || isFinishing() || isDestroyed()) return;
        try {
            PictureInPictureParams params = buildPipParams();
            pm.setInPipMode(true);
            controlsOverlay.setVisibility(View.GONE);
            enterPictureInPictureMode(params);
        } catch (Exception e) {
            pm.setInPipMode(false);
            minimizeToInAppDrawer(true);
        }
    }

    private void updatePipParamsIfSupported() {
        if (!pipSupported || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (isFinishing() || isDestroyed()) return;
        try {
            setPictureInPictureParams(buildPipParams());
        } catch (Exception ignored) {}
    }

    @RequiresApi(api = Build.VERSION_CODES.O)
    private PictureInPictureParams buildPipParams() {
        float ratio = pm.getNaturalVideoAspectRatio();
        // Android strictly enforces aspect ratio between ~0.42 (1/2.39) and 2.39
        float clamped = Math.max(0.45f, Math.min(2.35f, ratio));
        int num = Math.round(clamped * 100f);
        Rational aspect = new Rational(Math.max(45, num), 100);

        boolean playing = pm.isPlaying();
        RemoteAction rew = buildPipAction(R.drawable.ic_replay_10, "Rewind 10s", PIP_CMD_REW, 201);
        RemoteAction playPause = buildPipAction(
                playing ? R.drawable.ic_pause : R.drawable.ic_play,
                playing ? "Pause" : "Play",
                PIP_CMD_PLAY_PAUSE, 202);
        RemoteAction fwd = buildPipAction(R.drawable.ic_forward_10, "Forward 10s", PIP_CMD_FWD, 203);

        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder()
                .setAspectRatio(aspect)
                .setActions(Arrays.asList(rew, playPause, fwd));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            b.setSeamlessResizeEnabled(true);
            b.setAutoEnterEnabled(pm.isPlaying() && pm.isBackgroundPlayEnabled());
        }
        return b.build();
    }

    @RequiresApi(api = Build.VERSION_CODES.O)
    private RemoteAction buildPipAction(int iconRes, String label, String cmd, int reqCode) {
        Intent i = new Intent(ACTION_PIP_CONTROL).setPackage(getPackageName());
        i.putExtra(EXTRA_PIP_CMD, cmd);
        PendingIntent pi = PendingIntent.getBroadcast(
                this, reqCode, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new RemoteAction(Icon.createWithResource(this, iconRes), label, label, pi);
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (pipSupported && !minimizingToDrawer && !explicitClose && !isCurrentlyInPip()
                && pm.isPlaying() && pm.isBackgroundPlayEnabled()) {
            enterPipModeSafely();
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, @NonNull Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        pm.setInPipMode(isInPictureInPictureMode);
        if (isInPictureInPictureMode) {
            controlsVisible = false;
            controlsOverlay.setVisibility(View.GONE);
            gestureHud.setVisibility(View.GONE);
            scaleHud.setVisibility(View.GONE);
            doubleTapLeftHud.setVisibility(View.GONE);
            doubleTapRightHud.setVisibility(View.GONE);
            bufferingView.setVisibility(View.GONE);
            updateSubtitleMargin();
        } else {
            // If lifecycle is STOPPED/CREATED right as PiP ends, the user tapped X on the PiP window
            if (getLifecycle().getCurrentState() == Lifecycle.State.CREATED) {
                pm.persistProgress();
                if (!pm.isBackgroundPlayEnabled()) {
                    explicitClose = true;
                    pm.stopAndRelease();
                } else {
                    pm.pause();
                }
                return;
            }
            enterImmersive();
            controlsVisible = true;
            controlsOverlay.setVisibility(View.VISIBLE);
            updateSubtitleMargin();
            syncUiWithCurrentPlayerState();
            scheduleHideControls();
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            int code = event.getKeyCode();
            if (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_SPACE) {
                pm.togglePlayPause();
                showControlsAndFocus(btnPlayPause);
                return true;
            }
            if (code == KeyEvent.KEYCODE_MEDIA_PLAY) {
                pm.play();
                showControlsAndFocus(btnPlayPause);
                return true;
            }
            if (code == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                pm.pause();
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
            if (code == KeyEvent.KEYCODE_MEDIA_NEXT && pm.hasNextEpisode()) {
                pm.switchEpisode(pm.getSession().playlistIndex + 1);
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
                    pm.togglePlayPause();
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

    private void showControlsAndFocus(View target) {
        if (isCurrentlyInPip()) return;
        controlsVisible = true;
        controlsOverlay.setVisibility(View.VISIBLE);
        updateSubtitleMargin();
        if (target != null && target.getVisibility() == View.VISIBLE) {
            target.post(target::requestFocus);
        }
        scheduleHideControls();
    }

    private void seekRelativeWithHud(int deltaSec) {
        long target = pm.seekRelative(deltaSec);
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
        btnMinimize = findViewById(R.id.btn_player_minimize);
        btnPip = findViewById(R.id.btn_player_pip);
        btnRotate = findViewById(R.id.btn_player_rotate);
        btnRew = findViewById(R.id.btn_player_rew);
        btnFwd = findViewById(R.id.btn_player_fwd);
        btnNextEp = findViewById(R.id.btn_player_next_ep);
        btnBgPlay = findViewById(R.id.btn_player_bg_play);
        btnSpeed = findViewById(R.id.btn_player_speed);
        btnScale = findViewById(R.id.btn_player_scale);
        btnAudio = findViewById(R.id.btn_player_audio);
        btnCc = findViewById(R.id.btn_player_cc);
        btnQuality = findViewById(R.id.btn_player_quality);
        btnExternal = findViewById(R.id.btn_player_external);

        seekBar.setKeyProgressIncrement(15);
        UiHelper.applyTvFocusEffect(btnMinimize, 1.08f);
        UiHelper.applyTvFocusEffect(btnPip, 1.08f);
        UiHelper.applyTvFocusEffect(btnRew, 1.12f);
        UiHelper.applyTvFocusEffect(btnPlayPause, 1.12f);
        UiHelper.applyTvFocusEffect(btnFwd, 1.12f);
        UiHelper.applyTvFocusEffect(btnNextEp, 1.06f);
        UiHelper.applyTvFocusEffect(btnBgPlay, 1.06f);
        UiHelper.applyTvFocusEffect(btnSpeed, 1.06f);
        UiHelper.applyTvFocusEffect(btnScale, 1.06f);
        UiHelper.applyTvFocusEffect(btnAudio, 1.06f);
        UiHelper.applyTvFocusEffect(btnCc, 1.06f);
        UiHelper.applyTvFocusEffect(btnQuality, 1.06f);
        UiHelper.applyTvFocusEffect(btnExternal, 1.06f);

        btnPip.setVisibility(pipSupported ? View.VISIBLE : View.GONE);
        if (isTvDevice) {
            btnRotate.setVisibility(View.GONE);
            btnPip.setVisibility(View.GONE);
            titleView.setTextSize(20f);
            subtitleView.setTextSize(13.5f);
            posTimeView.setTextSize(14f);
            durTimeView.setTextSize(14f);
            btnNextEp.setTextSize(14.5f);
            btnBgPlay.setTextSize(14.5f);
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
            public boolean onDown(@NonNull MotionEvent e) { return true; }

            @Override
            public boolean onSingleTapConfirmed(@NonNull MotionEvent e) {
                if (gestureMode == GESTURE_NONE && !pinchActive && !isCurrentlyInPip()) {
                    toggleControls();
                    return true;
                }
                return false;
            }

            @Override
            public boolean onDoubleTap(@NonNull MotionEvent e) {
                if (gestureMode != GESTURE_NONE || pinchActive || isCurrentlyInPip()) return false;
                int width = Math.max(1, gestureLayer.getWidth());
                float x = e.getX();
                if (x < width * 0.42f) {
                    performDoubleTapSeek(-10);
                } else if (x > width * 0.58f) {
                    performDoubleTapSeek(10);
                } else {
                    pm.togglePlayPause();
                    showCenterToastHud(
                            pm.isPlaying() ? "Playing" : "Paused",
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
                        setVideoScaleMode(1, true);
                    } else if (pinchSpanFactor <= 0.86f) {
                        pinchTriggered = true;
                        setVideoScaleMode(0, true);
                    }
                }
                return true;
            }
        });

        gestureLayer.setOnTouchListener(this::handleGestureTouch);

        findViewById(R.id.btn_player_back).setOnClickListener(v -> handleBackOrCloseAction());
        btnMinimize.setOnClickListener(v -> minimizeToInAppDrawer(true));
        btnPip.setOnClickListener(v -> enterPipModeSafely());
        btnRotate.setOnClickListener(v -> {
            isLandscape = !isLandscape;
            setRequestedOrientation(isLandscape
                    ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            scheduleHideControls();
        });

        btnRew.setOnClickListener(v -> { pm.seekRelative(-10); scheduleHideControls(); });
        btnFwd.setOnClickListener(v -> { pm.seekRelative(10); scheduleHideControls(); });
        btnPlayPause.setOnClickListener(v -> {
            pm.togglePlayPause();
            scheduleHideControls();
        });

        btnNextEp.setOnClickListener(v -> {
            Models.PlaybackSession s = pm.getSession();
            if (s != null) pm.switchEpisode(s.playlistIndex + 1);
        });
        btnBgPlay.setOnClickListener(v -> {
            boolean next = !pm.isBackgroundPlayEnabled();
            pm.setBackgroundPlayEnabled(next);
            updateBgPlayButtonStyle();
            updatePipParamsIfSupported();
            showCenterToastHud(
                    next ? "Background Play: ON" : "Background Play: OFF",
                    next ? "Audio & PiP continue when minimized or screen turns off" : "Playback will pause when leaving player"
            );
            scheduleHideControls();
        });
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
            Models.PlaybackSession s = pm.getSession();
            if (s == null) return;
            pm.persistProgress();
            pm.pause();
            UiHelper.openInExternalPlayer(this, s.file.url, s.title);
        });

        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (fromUser) {
                    posTimeView.setText(Models.formatDurationSec(progress));
                    if (!isSeeking && !sb.isInTouchMode()) {
                        pm.seekTo(progress * 1000L);
                        scheduleHideControls();
                    }
                }
            }
            @Override
            public void onStartTrackingTouch(SeekBar sb) {
                isSeeking = true;
                pm.setUserSeeking(true);
            }
            @Override
            public void onStopTrackingTouch(SeekBar sb) {
                isSeeking = false;
                pm.setUserSeeking(false);
                pm.seekTo(sb.getProgress() * 1000L);
                scheduleHideControls();
            }
        });
    }

    private void bindSessionUi(Models.PlaybackSession s) {
        if (s == null) return;
        titleView.setText(pm.formatSessionTitle());
        List<String> subParts = new ArrayList<>();
        String baseSub = pm.formatSessionSubtitle();
        if (!baseSub.isEmpty()) subParts.add(baseSub);
        subParts.add(pm.isUsingSoftwareVideoFallback() ? "SW Video + FFmpeg Audio" : "HW Video + FFmpeg Audio");
        subtitleView.setText(String.join(" · ", subParts));
        btnNextEp.setVisibility(pm.hasNextEpisode() ? View.VISIBLE : View.GONE);
        btnQuality.setVisibility(s.qualityOptions.size() > 1 ? View.VISIBLE : View.GONE);
        updateBgPlayButtonStyle();
        updateSpeedButtonStyle();
        updateCcButtonStyle();
    }

    private void syncUiWithCurrentPlayerState() {
        int st = pm.getPlaybackState();
        boolean playing = pm.isPlaying();
        bufferingView.setVisibility(!isCurrentlyInPip() && st == Player.STATE_BUFFERING ? View.VISIBLE : View.GONE);
        btnPlayPause.setImageResource(playing ? R.drawable.ic_pause : R.drawable.ic_play);
        long posMs = pm.getCurrentPositionMs();
        long durMs = pm.getDurationMs();
        if (durMs > 0L) {
            posTimeView.setText(Models.formatDurationSec(posMs / 1000.0));
            durTimeView.setText(Models.formatDurationSec(durMs / 1000.0));
            seekBar.setMax((int) (durMs / 1000L));
            seekBar.setProgress((int) (posMs / 1000L));
        }
        updateBgPlayButtonStyle();
        updateSpeedButtonStyle();
        updateCcButtonStyle();
    }

    private void updateBgPlayButtonStyle() {
        if (btnBgPlay == null) return;
        boolean on = pm.isBackgroundPlayEnabled();
        btnBgPlay.setText(on ? "BG On" : "BG Off");
        btnBgPlay.setTextColor(on ? 0xFF22C55E : 0xFF94A3B8);
    }

    private void updateSpeedButtonStyle() {
        if (btnSpeed == null) return;
        float speed = pm.getPlaybackSpeed();
        btnSpeed.setText(formatSpeedBadge(speed));
        btnSpeed.setTextColor(Math.abs(speed - 1.0f) < 0.01f ? 0xFFFFFFFF : 0xFFFCA5A5);
    }

    private boolean handleGestureTouch(View v, MotionEvent event) {
        if (isCurrentlyInPip()) return false;
        if (scaleGestureDetector != null) scaleGestureDetector.onTouchEvent(event);
        if (tapGestureDetector != null && !pinchActive) tapGestureDetector.onTouchEvent(event);
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
            startVolumePct = pm.readCurrentVolumePct(audioManager);
            return true;
        }
        if (action == MotionEvent.ACTION_MOVE) {
            float dx = event.getX() - gestureStartX;
            float dy = gestureStartY - event.getY();
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
                pm.applyVolumeAndBoost(audioManager, nextPct);
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
        int side = deltaSec < 0 ? -1 : 1;
        long now = SystemClock.elapsedRealtime();
        if (doubleTapSide == side && (now - lastDoubleTapElapsedMs) <= 1150L) {
            doubleTapAccumSec += Math.abs(deltaSec);
        } else {
            doubleTapSide = side;
            doubleTapAccumSec = Math.abs(deltaSec);
        }
        lastDoubleTapElapsedMs = now;
        pm.seekRelative(deltaSec);

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
        if (scaleHud == null || isCurrentlyInPip()) return;
        handler.removeCallbacks(hideScaleHudTask);
        scaleHud.animate().cancel();
        scaleHud.setAlpha(1f);
        scaleHudTitle.setText(title);
        scaleHudHint.setText(hint);
        scaleHud.setVisibility(View.VISIBLE);
        handler.postDelayed(hideScaleHudTask, 1100);
    }

    private void showSpeedDialog() {
        int checked = 3;
        float cur = pm.getPlaybackSpeed();
        for (int i = 0; i < PLAYBACK_SPEEDS.length; i++) {
            if (Math.abs(PLAYBACK_SPEEDS[i] - cur) < 0.01f) { checked = i; break; }
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
        pm.setPlaybackSpeed(speed);
        updateSpeedButtonStyle();
        if (showHud) {
            showCenterToastHud("Speed · " + formatSpeedBadge(pm.getPlaybackSpeed()),
                    "Long-press speed button to reset to 1x");
        }
    }

    public static String formatSpeedBadge(float speed) {
        if (Math.abs(speed - Math.round(speed)) < 0.01f) return Math.round(speed) + "x";
        String s = String.format(Locale.US, "%.2f", speed).replaceAll("0+$", "");
        return s + "x";
    }

    private float readCurrentBrightness() {
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        if (lp.screenBrightness >= 0f && lp.screenBrightness <= 1f) return lp.screenBrightness;
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
                    if (SCALE_MODES[i].key.equals(savedKey)) { idx = i; break; }
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
        scaleModeIndex = ((index % SCALE_MODES.length) + SCALE_MODES.length) % SCALE_MODES.length;
        applyVideoScaleMode(showHud, true);
    }

    private void applyVideoScaleMode(boolean showHud, boolean persist) {
        if (playerView == null) return;
        VideoScaleMode mode = SCALE_MODES[scaleModeIndex];
        playerView.setResizeMode(mode.resizeMode);
        AspectRatioFrameLayout contentFrame = findAspectRatioFrameLayout();
        if (contentFrame != null) {
            contentFrame.setResizeMode(mode.resizeMode);
            if (mode.forcedAspectRatio > 0f) contentFrame.setAspectRatio(mode.forcedAspectRatio);
            else if (pm.getNaturalVideoAspectRatio() > 0f) contentFrame.setAspectRatio(pm.getNaturalVideoAspectRatio());
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
            showCenterToastHud(mode.label, "Tap Fit to cycle · Long-press for all · Pinch to zoom");
        }
    }

    private void showScaleModeDialog() {
        String[] labels = new String[SCALE_MODES.length];
        for (int i = 0; i < SCALE_MODES.length; i++) labels[i] = SCALE_MODES[i].label;
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
        if (direct instanceof AspectRatioFrameLayout) return (AspectRatioFrameLayout) direct;
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

    private void renderCueText(String txt) {
        if (!pm.isSubtitlesEnabled() || txt == null || txt.isEmpty()) {
            cinemaSubText.setVisibility(View.GONE);
        } else {
            cinemaSubText.setTextSize(isCurrentlyInPip() ? 11f : pm.getSubTextSp());
            cinemaSubText.setText(txt);
            cinemaSubText.setVisibility(View.VISIBLE);
        }
    }

    private void updateCcButtonStyle() {
        if (btnCc == null) return;
        boolean on = pm.isSubtitlesEnabled();
        btnCc.setText(on ? "CC On" : "CC");
        btnCc.setTextColor(on ? 0xFFFCA5A5 : 0xFFFFFFFF);
    }

    private void showAudioDialog() {
        ExoPlayer player = pm.getPlayer();
        if (player == null) return;
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
        ExoPlayer player = pm.getPlayer();
        if (player == null) return;
        List<String> labels = new ArrayList<>();
        List<Tracks.Group> groups = new ArrayList<>();
        List<Integer> indices = new ArrayList<>();
        labels.add("Off");
        groups.add(null);
        indices.add(-1);
        int checked = pm.isSubtitlesEnabled() ? -1 : 0;

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
                if (pm.isSubtitlesEnabled() && g.isTrackSelected(i)) checked = labels.size() - 1;
            }
        }
        new AlertDialog.Builder(this)
                .setTitle(String.format(Locale.US, "Subtitles (Size %.0fsp · Sync %+.1fs)", pm.getSubTextSp(), pm.getSubDelaySec()))
                .setSingleChoiceItems(labels.toArray(new String[0]), checked, (d, which) -> {
                    if (which == 0) {
                        pm.setSubtitlesEnabled(false);
                        cinemaSubText.setVisibility(View.GONE);
                        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build());
                    } else {
                        pm.setSubtitlesEnabled(true);
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
                    if (which == 0) pm.setSubTextSp(16f);
                    else if (which == 1) pm.setSubTextSp(20f);
                    else if (which == 2) pm.setSubTextSp(26f);
                    else if (which == 3) pm.setSubTextSp(32f);
                    else if (which == 4) pm.setSubDelaySec(0.0);
                    else if (which == 5) pm.setSubDelaySec(pm.getSubDelaySec() + 0.5);
                    else if (which == 6) pm.setSubDelaySec(pm.getSubDelaySec() + 1.0);
                    else if (which == 7) pm.setSubDelaySec(pm.getSubDelaySec() + 2.0);
                    cinemaSubText.setTextSize(pm.getSubTextSp());
                    Toast.makeText(this,
                            String.format(Locale.US, "Subtitles: %.0fsp · Sync %+.1fs", pm.getSubTextSp(), pm.getSubDelaySec()),
                            Toast.LENGTH_SHORT).show();
                })
                .show();
    }

    private void showQualityDialog() {
        Models.PlaybackSession s = pm.getSession();
        if (s == null || s.qualityOptions.isEmpty()) return;
        String[] labels = new String[s.qualityOptions.size()];
        int checked = 0;
        for (int i = 0; i < s.qualityOptions.size(); i++) {
            Models.QualityOption o = s.qualityOptions.get(i);
            labels[i] = o.label;
            if (o.file.url.equals(s.file.url)) checked = i;
        }
        new AlertDialog.Builder(this)
                .setTitle("Switch Server & Quality")
                .setSingleChoiceItems(labels, checked, (d, which) -> {
                    d.dismiss();
                    Models.QualityOption opt = s.qualityOptions.get(which);
                    if (!opt.file.url.equals(s.file.url)) pm.switchQuality(opt);
                })
                .setNegativeButton("Close", null)
                .show();
    }

    private void toggleControls() {
        controlsVisible = !controlsVisible;
        controlsOverlay.setVisibility(controlsVisible ? View.VISIBLE : View.GONE);
        updateSubtitleMargin();
        if (controlsVisible) scheduleHideControls();
    }

    private void updateSubtitleMargin() {
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) cinemaSubText.getLayoutParams();
        lp.bottomMargin = UiHelper.dp(this, isCurrentlyInPip() ? 8 : (controlsVisible ? 96 : 26));
        cinemaSubText.setLayoutParams(lp);
    }

    private void scheduleHideControls() {
        handler.removeCallbacks(hideControlsTask);
        handler.postDelayed(hideControlsTask, isTvDevice ? 6000 : 4000);
    }

    @Override
    protected void onResume() {
        super.onResume();
        minimizingToDrawer = false;
        pm.setFullscreenActive(true);
        pm.setMinimizedInApp(false);
        pm.attachPlayerView(playerView);
        syncUiWithCurrentPlayerState();
    }

    @Override
    protected void onPause() {
        pm.persistProgress();
        // Do NOT pause ExoPlayer here when Background Play, PiP, or In-App Minimize is active!
        if (!isChangingConfigurations() && !isCurrentlyInPip() && !minimizingToDrawer
                && !explicitClose && !pm.isBackgroundPlayEnabled()) {
            pm.pause();
        }
        super.onPause();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (isChangingConfigurations()) return;
        if (!isCurrentlyInPip()) {
            pm.setFullscreenActive(false);
            pm.detachPlayerView(playerView);
            if (!minimizingToDrawer && !explicitClose && !pm.isBackgroundPlayEnabled()) {
                pm.pause();
            }
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        pm.removeListener(playbackListener);
        if (pipReceiverRegistered) {
            try { unregisterReceiver(pipActionReceiver); } catch (Exception ignored) {}
            pipReceiverRegistered = false;
        }
        if (!isChangingConfigurations()) {
            pm.setFullscreenActive(false);
            pm.setInPipMode(false);
            pm.detachPlayerView(playerView);
            if (explicitClose) {
                pm.stopAndRelease();
            }
        }
        super.onDestroy();
    }
}
