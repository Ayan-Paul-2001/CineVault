package com.cinevault.app.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;

import com.cinevault.app.CineVaultApp;
import com.cinevault.app.R;
import com.cinevault.app.data.Models;
import com.cinevault.app.ui.PlayerActivity;

/**
 * Foreground media playback service (FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) with platform MediaSession
 * and lock-screen / notification shade transport controls (-10s, Play/Pause, +10s, Stop).
 * Keeps ExoPlayer audio alive when minimized in-app, in PiP, or when the screen is turned off.
 */
public final class MediaPlaybackService extends Service {
    public static final String CHANNEL_ID = "cinevault_playback";
    public static final int NOTIF_ID = 4101;

    public static final String ACTION_UPDATE = "com.cinevault.app.action.UPDATE";
    public static final String ACTION_PLAY_PAUSE = "com.cinevault.app.action.PLAY_PAUSE";
    public static final String ACTION_REWIND = "com.cinevault.app.action.REWIND";
    public static final String ACTION_FORWARD = "com.cinevault.app.action.FORWARD";
    public static final String ACTION_STOP = "com.cinevault.app.action.STOP";

    private MediaSession mediaSession;
    private NotificationManager notificationManager;
    private boolean foregroundStarted = false;

    public static void startOrUpdate(Context context) {
        if (context == null) return;
        CineVaultApp app = CineVaultApp.get();
        if (app == null || app.playbackManager == null || !app.playbackManager.hasActiveSession()) {
            stopService(context);
            return;
        }
        Intent intent = new Intent(context, MediaPlaybackService.class);
        intent.setAction(ACTION_UPDATE);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(context, intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception ignored) {
            try {
                context.startService(intent);
            } catch (Exception ignored2) {}
        }
    }

    public static void stopService(Context context) {
        if (context == null) return;
        try {
            context.stopService(new Intent(context, MediaPlaybackService.class));
        } catch (Exception ignored) {}
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notificationManager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        ensureNotificationChannel();
        initMediaSession();
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notificationManager != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID,
                    "CineVault Media Playback",
                    NotificationManager.IMPORTANCE_LOW
            );
            ch.setDescription("Background playback controls and lock-screen media controls");
            ch.setShowBadge(false);
            ch.setSound(null, null);
            notificationManager.createNotificationChannel(ch);
        }
    }

    private void initMediaSession() {
        mediaSession = new MediaSession(this, "CineVaultMediaSession");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                PlaybackManager pm = getPm();
                if (pm != null) pm.play();
            }

            @Override
            public void onPause() {
                PlaybackManager pm = getPm();
                if (pm != null) pm.pause();
            }

            @Override
            public void onFastForward() {
                PlaybackManager pm = getPm();
                if (pm != null) {
                    pm.seekRelative(10);
                    refreshNotificationAndSession();
                }
            }

            @Override
            public void onRewind() {
                PlaybackManager pm = getPm();
                if (pm != null) {
                    pm.seekRelative(-10);
                    refreshNotificationAndSession();
                }
            }

            @Override
            public void onSeekTo(long pos) {
                PlaybackManager pm = getPm();
                if (pm != null) {
                    pm.seekTo(pos);
                    refreshNotificationAndSession();
                }
            }

            @Override
            public void onSkipToNext() {
                PlaybackManager pm = getPm();
                if (pm != null && pm.hasNextEpisode()) {
                    pm.switchEpisode(pm.getSession().playlistIndex + 1);
                }
            }

            @Override
            public void onStop() {
                PlaybackManager pm = getPm();
                if (pm != null) pm.stopAndRelease();
                stopSelf();
            }
        });
        mediaSession.setActive(true);
    }

    private PlaybackManager getPm() {
        CineVaultApp app = CineVaultApp.get();
        return app != null ? app.playbackManager : null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        PlaybackManager pm = getPm();
        if (pm == null || !pm.hasActiveSession()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = intent != null ? intent.getAction() : ACTION_UPDATE;
        if (ACTION_PLAY_PAUSE.equals(action)) {
            pm.togglePlayPause();
        } else if (ACTION_REWIND.equals(action)) {
            pm.seekRelative(-10);
        } else if (ACTION_FORWARD.equals(action)) {
            pm.seekRelative(10);
        } else if (ACTION_STOP.equals(action)) {
            pm.stopAndRelease();
            stopSelf();
            return START_NOT_STICKY;
        }

        refreshNotificationAndSession();
        return START_NOT_STICKY;
    }

    private void refreshNotificationAndSession() {
        PlaybackManager pm = getPm();
        if (pm == null || !pm.hasActiveSession()) {
            stopSelf();
            return;
        }
        Models.PlaybackSession s = pm.getSession();
        boolean playing = pm.isPlaying();
        long posMs = pm.getCurrentPositionMs();
        long durMs = pm.getDurationMs();

        if (mediaSession != null) {
            long actions = PlaybackState.ACTION_PLAY
                    | PlaybackState.ACTION_PAUSE
                    | PlaybackState.ACTION_PLAY_PAUSE
                    | PlaybackState.ACTION_REWIND
                    | PlaybackState.ACTION_FAST_FORWARD
                    | PlaybackState.ACTION_SEEK_TO
                    | PlaybackState.ACTION_STOP;
            if (pm.hasNextEpisode()) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;

            PlaybackState state = new PlaybackState.Builder()
                    .setActions(actions)
                    .setState(
                            playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                            posMs,
                            playing ? pm.getPlaybackSpeed() : 0f
                    )
                    .build();
            mediaSession.setPlaybackState(state);

            MediaMetadata.Builder meta = new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, pm.formatSessionTitle())
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, pm.formatSessionSubtitle())
                    .putString(MediaMetadata.METADATA_KEY_ALBUM, "CineVault");
            if (durMs > 0) meta.putLong(MediaMetadata.METADATA_KEY_DURATION, durMs);
            mediaSession.setMetadata(meta.build());
        }

        Notification notif = buildNotification(pm, s, playing);
        try {
            if (!foregroundStarted || playing) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                } else {
                    startForeground(NOTIF_ID, notif);
                }
                foregroundStarted = true;
            } else if (notificationManager != null) {
                notificationManager.notify(NOTIF_ID, notif);
            }
        } catch (Exception ignored) {
            try {
                if (notificationManager != null) notificationManager.notify(NOTIF_ID, notif);
            } catch (Exception ignored2) {}
        }
    }

    private Notification buildNotification(PlaybackManager pm, Models.PlaybackSession s, boolean playing) {
        Intent openIntent = new Intent(this, PlayerActivity.class);
        openIntent.putExtra(PlayerActivity.EXTRA_RESUME_ACTIVE, true);
        openIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent contentPi = PendingIntent.getActivity(
                this, 100, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        PendingIntent rewPi = serviceActionPi(ACTION_REWIND, 101);
        PendingIntent playPausePi = serviceActionPi(ACTION_PLAY_PAUSE, 102);
        PendingIntent fwdPi = serviceActionPi(ACTION_FORWARD, 103);
        PendingIntent stopPi = serviceActionPi(ACTION_STOP, 104);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        String subtitle = pm.formatSessionSubtitle();
        if (subtitle.isEmpty()) subtitle = playing ? "Playing in background" : "Paused";

        builder.setSmallIcon(R.drawable.ic_play)
                .setContentTitle(pm.formatSessionTitle())
                .setContentText(subtitle)
                .setContentIntent(contentPi)
                .setDeleteIntent(stopPi)
                .setOnlyAlertOnce(true)
                .setOngoing(playing)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(R.drawable.ic_replay_10, "-10s", rewPi).build())
                .addAction(new Notification.Action.Builder(
                        playing ? R.drawable.ic_pause : R.drawable.ic_play,
                        playing ? "Pause" : "Play",
                        playPausePi).build())
                .addAction(new Notification.Action.Builder(R.drawable.ic_forward_10, "+10s", fwdPi).build())
                .addAction(new Notification.Action.Builder(R.drawable.ic_close, "Stop", stopPi).build());

        if (mediaSession != null) {
            builder.setStyle(new Notification.MediaStyle()
                    .setMediaSession(mediaSession.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2));
        }

        return builder.build();
    }

    private PendingIntent serviceActionPi(String action, int reqCode) {
        Intent i = new Intent(this, MediaPlaybackService.class);
        i.setAction(action);
        return PendingIntent.getService(
                this, reqCode, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        PlaybackManager pm = getPm();
        if (pm != null && (!pm.isBackgroundPlayEnabled() || !pm.isPlaying())) {
            pm.stopAndRelease();
            stopSelf();
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        foregroundStarted = false;
        if (mediaSession != null) {
            try {
                mediaSession.setActive(false);
                mediaSession.release();
            } catch (Exception ignored) {}
            mediaSession = null;
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
