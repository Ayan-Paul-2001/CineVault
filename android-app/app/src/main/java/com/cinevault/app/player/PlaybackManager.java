package com.cinevault.app.player;

import android.content.Context;
import android.media.AudioManager;
import android.media.audiofx.LoudnessEnhancer;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
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
import androidx.media3.ui.PlayerView;

import com.cinevault.app.CineVaultApp;
import com.cinevault.app.data.MediaDownloadManager;
import com.cinevault.app.data.Models;
import com.cinevault.app.data.ServerConfig;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Shared application-scoped ExoPlayer controller enabling YouTube Premium-style:
 * - Seamless handoff between Fullscreen PlayerActivity and in-app Mini-Player Bar (zero re-buffering)
 * - Screen-off / background audio playback via MediaPlaybackService foreground service
 * - Native Picture-in-Picture (PiP) continuity
 * - Automatic hardware->software video fallback, external subtitle fallback, transient IO reconnect & mirror failover
 */
@OptIn(markerClass = UnstableApi.class)
public final class PlaybackManager {

    public interface Listener {
        default void onSessionChanged(Models.PlaybackSession session) {}
        default void onPlaybackStateChanged(int playbackState, boolean isPlaying) {}
        default void onPositionUpdated(long posMs, long durMs) {}
        default void onVideoSizeChanged(float aspectRatio) {}
        default void onTracksChanged(Tracks tracks) {}
        default void onCues(CueGroup cueGroup) {}
        default void onStatusMessage(String message) {}
        default void onSessionStopped() {}
    }

    private final CineVaultApp app;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();

    private ExoPlayer player;
    private PlayerView attachedView;
    private Models.PlaybackSession session;
    private LoudnessEnhancer loudnessEnhancer;

    private boolean backgroundPlayEnabled = true;
    private boolean minimizedInApp = false;
    private boolean inPipMode = false;
    private boolean fullscreenActive = false;

    private float playbackSpeed = 1.0f;
    private float currentVolumePct = -1f;
    private float naturalVideoAspectRatio = 16f / 9f;

    private boolean subtitlesEnabled = true;
    private float subTextSp = 20f;
    private double subDelaySec = 0.0;
    private boolean didAutoSelectSub = false;

    // Anti-time-jump watchdog & playback error recovery state
    private long lastStablePosMs = 0L;
    private long lastUserSeekElapsedMs = 0L;
    private double lastSavedSec = 0.0;
    private boolean isUserSeeking = false;
    private int jumpRecoveryCount = 0;
    private boolean retriedWithoutSubs = false;
    private boolean useSoftwareVideoFallback = false;
    private int ioRetryCount = 0;
    private final Set<String> failedStreamUrls = new HashSet<>();

    private final Runnable progressWatchdog = new Runnable() {
        @Override
        public void run() {
            if (player == null || session == null) return;
            long rawPos = player.getCurrentPosition();
            long rawDur = player.getDuration();
            long posMs = rawPos == C.TIME_UNSET ? 0L : Math.max(0L, rawPos);
            long durMs = rawDur == C.TIME_UNSET ? 0L : Math.max(0L, rawDur);

            boolean userRecentlySought = (SystemClock.elapsedRealtime() - lastUserSeekElapsedMs) <= 3000L;
            if (player.getPlaybackState() == Player.STATE_READY && player.isPlaying() && !isUserSeeking) {
                if (!userRecentlySought && lastStablePosMs > 1000L && durMs > 0L) {
                    long deltaMs = posMs - lastStablePosMs;
                    boolean suddenForwardJump = deltaMs > 120_000L && posMs < (durMs - 5_000L);
                    boolean suddenBackwardJump = deltaMs < -30_000L;
                    if ((suddenForwardJump || suddenBackwardJump) && jumpRecoveryCount < 4) {
                        jumpRecoveryCount++;
                        long recoverMs = Math.min(durMs - 1000L, lastStablePosMs + 1000L);
                        markUserSeek();
                        player.seekTo(Math.max(0L, recoverMs));
                        mainHandler.postDelayed(this, 500L);
                        return;
                    }
                }
                if (userRecentlySought || lastStablePosMs == 0L || Math.abs(posMs - lastStablePosMs) <= 15_000L) {
                    lastStablePosMs = posMs;
                }
            } else if (userRecentlySought && posMs > 0L) {
                lastStablePosMs = posMs;
            }

            for (Listener l : listeners) l.onPositionUpdated(posMs, durMs);

            double posSec = lastStablePosMs > 0L ? (lastStablePosMs / 1000.0) : (posMs / 1000.0);
            if (posSec >= 5.0 && Math.abs(posSec - lastSavedSec) >= 8.0) {
                lastSavedSec = posSec;
                persistProgress();
            }
            mainHandler.postDelayed(this, 500L);
        }
    };

    public PlaybackManager(CineVaultApp app) {
        this.app = app;
        app.ioExecutor.execute(() -> {
            try {
                String saved = app.repository.db.getSyncState("bg_play_enabled");
                if (saved != null) {
                    backgroundPlayEnabled = !"false".equalsIgnoreCase(saved.trim());
                }
            } catch (Exception ignored) {}
        });
    }

    public void addListener(Listener l) {
        if (l != null) listeners.addIfAbsent(l);
    }

    public void removeListener(Listener l) {
        listeners.remove(l);
    }

    public ExoPlayer getPlayer() { return player; }
    public Models.PlaybackSession getSession() { return session; }
    public boolean hasActiveSession() { return session != null && player != null; }
    public boolean isPlaying() { return player != null && player.isPlaying(); }
    public int getPlaybackState() { return player != null ? player.getPlaybackState() : Player.STATE_IDLE; }
    public long getCurrentPositionMs() {
        if (player == null) return 0L;
        long p = player.getCurrentPosition();
        return p == C.TIME_UNSET ? 0L : Math.max(0L, p);
    }
    public long getDurationMs() {
        if (player == null) return 0L;
        long d = player.getDuration();
        return d == C.TIME_UNSET ? 0L : Math.max(0L, d);
    }
    public float getNaturalVideoAspectRatio() { return naturalVideoAspectRatio; }
    public float getPlaybackSpeed() { return playbackSpeed; }
    public boolean isUsingSoftwareVideoFallback() { return useSoftwareVideoFallback; }
    public boolean isBackgroundPlayEnabled() { return backgroundPlayEnabled; }
    public boolean isMinimizedInApp() { return minimizedInApp; }
    public boolean isInPipMode() { return inPipMode; }
    public boolean isFullscreenActive() { return fullscreenActive; }
    public boolean isSubtitlesEnabled() { return subtitlesEnabled; }
    public float getSubTextSp() { return subTextSp; }
    public double getSubDelaySec() { return subDelaySec; }
    public float getCurrentVolumePct() { return currentVolumePct; }

    public void setSubtitlesEnabled(boolean enabled) { this.subtitlesEnabled = enabled; }
    public void setSubTextSp(float sp) { this.subTextSp = sp; }
    public void setSubDelaySec(double sec) { this.subDelaySec = sec; }
    public void setUserSeeking(boolean seeking) {
        this.isUserSeeking = seeking;
        if (seeking) markUserSeek();
    }
    public void setFullscreenActive(boolean active) { this.fullscreenActive = active; }
    public void setInPipMode(boolean inPip) { this.inPipMode = inPip; }
    public void setMinimizedInApp(boolean minimized) {
        this.minimizedInApp = minimized;
        if (session != null) {
            for (Listener l : listeners) l.onSessionChanged(session);
        }
    }

    public void setBackgroundPlayEnabled(boolean enabled) {
        this.backgroundPlayEnabled = enabled;
        app.ioExecutor.execute(() -> app.repository.db.setSyncState("bg_play_enabled", String.valueOf(enabled)));
    }

    public void markUserSeek() {
        lastUserSeekElapsedMs = SystemClock.elapsedRealtime();
    }

    public boolean isSessionUrlAllowed(Context ctx, Models.PlaybackSession s) {
        if (s == null || s.file == null || s.file.url == null || s.file.url.isEmpty()) return false;
        if (ServerConfig.isAllowedUrl(s.file.url)) return true;
        return MediaDownloadManager.isVerifiedLocalDownloadUri(ctx, app.repository.db, s.file.url);
    }

    public boolean openSession(Context ctx, Models.PlaybackSession newSession, boolean forceReload) {
        if (!isSessionUrlAllowed(ctx, newSession)) return false;

        // If already playing this exact file URL, resume seamlessly with ZERO re-buffering!
        if (!forceReload && session != null && player != null
                && session.file.url.equals(newSession.file.url)) {
            minimizedInApp = false;
            for (Listener l : listeners) l.onSessionChanged(session);
            MediaPlaybackService.startOrUpdate(app);
            return true;
        }

        persistProgress();
        session = newSession;
        minimizedInApp = false;
        retriedWithoutSubs = false;
        ioRetryCount = 0;
        jumpRecoveryCount = 0;
        failedStreamUrls.clear();

        if (player == null || useSoftwareVideoFallback) {
            useSoftwareVideoFallback = false;
            initPlayerInternal(false);
        }

        openCurrentSessionInternal(true, (long) (session.startTime * 1000.0));
        mainHandler.removeCallbacks(progressWatchdog);
        mainHandler.post(progressWatchdog);
        MediaPlaybackService.startOrUpdate(app);
        return true;
    }

    public void attachPlayerView(PlayerView view) {
        if (attachedView != null && attachedView != view) {
            attachedView.setPlayer(null);
        }
        attachedView = view;
        if (attachedView != null) {
            attachedView.setPlayer(player);
        }
    }

    public void detachPlayerView(PlayerView view) {
        if (attachedView == view && attachedView != null) {
            attachedView.setPlayer(null);
            attachedView = null;
        }
    }

    private void initPlayerInternal(boolean preferSoftwareVideo) {
        releaseLoudnessEnhancer();
        if (player != null) {
            try {
                if (attachedView != null) attachedView.setPlayer(null);
                player.release();
            } catch (Exception ignored) {}
            player = null;
        }

        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(app)
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

        player = new ExoPlayer.Builder(app, renderersFactory)
                .setLoadControl(loadControl)
                .setAudioAttributes(audioAttrs, true)
                .setHandleAudioBecomingNoisy(true)
                .build();
        player.setPlaybackParameters(new PlaybackParameters(playbackSpeed));
        if (attachedView != null) attachedView.setPlayer(player);

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
                    for (Listener l : listeners) l.onVideoSizeChanged(naturalVideoAspectRatio);
                }
            }

            @Override
            public void onRenderedFirstFrame() {
                for (Listener l : listeners) l.onVideoSizeChanged(naturalVideoAspectRatio);
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) {
                    ioRetryCount = 0;
                    if (currentVolumePct > 100.5f && loudnessEnhancer == null && player != null) {
                        attachLoudnessEnhancer(player.getAudioSessionId());
                    }
                    MediaPlaybackService.startOrUpdate(app);
                }
                for (Listener l : listeners) l.onPlaybackStateChanged(state, player != null && player.isPlaying());
                if (state == Player.STATE_ENDED) {
                    persistProgress();
                    if (hasNextEpisode()) {
                        switchEpisode(session.playlistIndex + 1);
                    } else {
                        MediaPlaybackService.startOrUpdate(app);
                    }
                }
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                for (Listener l : listeners) {
                    l.onPlaybackStateChanged(player != null ? player.getPlaybackState() : Player.STATE_IDLE, isPlaying);
                }
                if (session != null) MediaPlaybackService.startOrUpdate(app);
            }

            @Override
            public void onTracksChanged(@NonNull Tracks tracks) {
                autoSelectNonForcedSubtitle(tracks);
                for (Listener l : listeners) l.onTracksChanged(tracks);
            }

            @Override
            public void onCues(@NonNull CueGroup cueGroup) {
                for (Listener l : listeners) l.onCues(cueGroup);
            }

            @Override
            public void onPlayerError(@NonNull PlaybackException error) {
                if (session == null) return;
                long resumeMs = Math.max(lastStablePosMs, (long) (session.startTime * 1000.0));

                // 1. Hardware video decoder crashed — switch seamlessly to Software Video Decoder
                boolean isDecoderError = error.errorCode >= 4000 && error.errorCode < 5000;
                if (isDecoderError && !useSoftwareVideoFallback) {
                    useSoftwareVideoFallback = true;
                    emitMessage("Switched to Software Video Decoder for compatibility...");
                    initPlayerInternal(true);
                    openCurrentSessionInternal(!retriedWithoutSubs, resumeMs);
                    return;
                }

                // 2. Broken external subtitle must never kill video playback
                if (!retriedWithoutSubs && !session.externalSubtitles.isEmpty()) {
                    retriedWithoutSubs = true;
                    emitMessage("External subtitle unavailable — playing video with embedded tracks...");
                    openCurrentSessionInternal(false, resumeMs);
                    return;
                }

                // 3. Transient BDIX network / timeout hiccup — auto-reconnect at last timestamp
                boolean isIoError = error.errorCode >= 2000 && error.errorCode < 3000;
                if (isIoError && ioRetryCount < 2) {
                    ioRetryCount++;
                    long finalResumeMs = resumeMs;
                    mainHandler.postDelayed(() -> {
                        if (player != null && session != null) {
                            openCurrentSessionInternal(!retriedWithoutSubs, finalResumeMs);
                        }
                    }, 1200L);
                    return;
                }

                // 4. Auto-failover to another working mirror / quality if available
                failedStreamUrls.add(session.file.url);
                for (Models.QualityOption alt : session.qualityOptions) {
                    if (alt.file.online && !failedStreamUrls.contains(alt.file.url)
                            && ServerConfig.isAllowedUrl(alt.file.url)) {
                        emitMessage("Switching to backup mirror (" + alt.serverLabel + ")...");
                        double resumeSec = resumeMs / 1000.0;
                        session = new Models.PlaybackSession(
                                session.mediaId, session.title, alt.file, alt.subtitles, null,
                                session.playlist, session.playlistIndex, alt.quality, alt.serverLabel,
                                session.qualityOptions, resumeSec);
                        openCurrentSessionInternal(true, resumeMs);
                        return;
                    }
                }

                emitMessage("Playback error (" + error.getErrorCodeName() + "). Try another quality or tap VLC.");
            }
        });
    }

    private void openCurrentSessionInternal(boolean includeExternalSubtitles, long resumePosMs) {
        if (player == null || session == null) return;
        long safeStartMs = resumePosMs > 5000L ? resumePosMs : 0L;
        didAutoSelectSub = false;
        lastSavedSec = safeStartMs / 1000.0;
        lastStablePosMs = safeStartMs;
        markUserSeek();

        boolean isLocalFile = session.file.url.startsWith("content://") || session.file.url.startsWith("file://");
        String playUrl = isLocalFile ? session.file.url : ServerConfig.sanitizeMediaUrl(session.file.url);
        DataSource.Factory dsFactory = isLocalFile
                ? new DefaultDataSource.Factory(app)
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

        for (Listener l : listeners) l.onSessionChanged(session);
        MediaPlaybackService.startOrUpdate(app);
    }

    private void autoSelectNonForcedSubtitle(Tracks tracks) {
        if (didAutoSelectSub || player == null) return;
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

    public void togglePlayPause() {
        if (player == null) return;
        if (player.isPlaying()) player.pause();
        else player.play();
    }

    public void play() {
        if (player != null) player.play();
    }

    public void pause() {
        if (player != null) player.pause();
    }

    public long seekTo(long targetMs) {
        if (player == null) return 0L;
        long dur = player.getDuration();
        long clamped = Math.max(0L, targetMs);
        if (dur > 0 && dur != C.TIME_UNSET) clamped = Math.min(dur, clamped);
        markUserSeek();
        lastStablePosMs = clamped;
        player.seekTo(clamped);
        return clamped;
    }

    public long seekRelative(int deltaSec) {
        if (player == null) return 0L;
        return seekTo(player.getCurrentPosition() + deltaSec * 1000L);
    }

    public void setPlaybackSpeed(float speed) {
        playbackSpeed = Math.max(0.25f, Math.min(2.0f, speed));
        if (player != null) {
            player.setPlaybackParameters(new PlaybackParameters(playbackSpeed));
        }
    }

    public boolean hasNextEpisode() {
        return session != null && !session.playlist.isEmpty() && session.playlistIndex < session.playlist.size() - 1;
    }

    public void switchEpisode(int nextIdx) {
        if (session == null || nextIdx < 0 || nextIdx >= session.playlist.size()) return;
        persistProgress();
        Models.MediaFileEntry nextFile = session.playlist.get(nextIdx);
        session = new Models.PlaybackSession(
                session.mediaId, session.title, nextFile, session.externalSubtitles,
                session.seasonName, session.playlist, nextIdx,
                nextFile.quality != null ? nextFile.quality : session.qualityLabel,
                session.serverLabel, session.qualityOptions, 0);
        retriedWithoutSubs = false;
        ioRetryCount = 0;
        jumpRecoveryCount = 0;
        openCurrentSessionInternal(true, 0L);
    }

    public void switchQuality(Models.QualityOption opt) {
        if (session == null || opt == null) return;
        long resumeMs = getCurrentPositionMs();
        persistProgress();
        session = new Models.PlaybackSession(
                session.mediaId, session.title, opt.file, opt.subtitles, null,
                session.playlist, session.playlistIndex, opt.quality, opt.serverLabel,
                session.qualityOptions, resumeMs / 1000.0);
        retriedWithoutSubs = false;
        ioRetryCount = 0;
        jumpRecoveryCount = 0;
        openCurrentSessionInternal(true, resumeMs);
    }

    public float readCurrentVolumePct(AudioManager audioManager) {
        if (currentVolumePct > 100f) return currentVolumePct;
        if (audioManager == null) return 50f;
        int max = Math.max(1, audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        int cur = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
        currentVolumePct = (cur / (float) max) * 100f;
        return currentVolumePct;
    }

    public void applyVolumeAndBoost(AudioManager audioManager, float targetPct) {
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

    public void persistProgress() {
        if (player == null || session == null) return;
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

    public String formatSessionTitle() {
        if (session == null) return "CineVault";
        List<String> parts = new ArrayList<>();
        parts.add(session.title);
        if (session.seasonName != null && !session.seasonName.isEmpty()) parts.add(session.seasonName);
        if (session.file != null && !session.file.label.isEmpty()) parts.add(session.file.label);
        return String.join(" · ", parts);
    }

    public String formatSessionSubtitle() {
        if (session == null) return "";
        List<String> parts = new ArrayList<>();
        if (session.qualityLabel != null && !session.qualityLabel.isEmpty()) parts.add(session.qualityLabel);
        if (session.serverLabel != null && !session.serverLabel.isEmpty()) parts.add(session.serverLabel);
        return String.join(" · ", parts);
    }

    public void stopAndRelease() {
        mainHandler.removeCallbacks(progressWatchdog);
        persistProgress();
        releaseLoudnessEnhancer();
        if (attachedView != null) {
            attachedView.setPlayer(null);
            attachedView = null;
        }
        if (player != null) {
            try { player.release(); } catch (Exception ignored) {}
            player = null;
        }
        session = null;
        minimizedInApp = false;
        inPipMode = false;
        fullscreenActive = false;
        MediaPlaybackService.stopService(app);
        for (Listener l : listeners) l.onSessionStopped();
    }

    private void emitMessage(String msg) {
        mainHandler.post(() -> {
            for (Listener l : listeners) l.onStatusMessage(msg);
        });
    }
}
