package com.cinevault.app;

import android.app.Application;
import android.os.Handler;
import android.os.Looper;

import com.cinevault.app.data.AppDatabase;
import com.cinevault.app.data.CircleFtpService;
import com.cinevault.app.data.H5aiService;
import com.cinevault.app.data.IccService;
import com.cinevault.app.data.MediaRepository;
import com.cinevault.app.data.MetadataService;
import com.cinevault.app.data.UpdateService;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;

/**
 * Application singleton holding the shared SQLite DB, OkHttp pool, background executors, and Repository.
 */
public final class CineVaultApp extends Application {
    private static CineVaultApp instance;

    public OkHttpClient httpClient;
    public OkHttpClient streamingClient;
    public MediaRepository repository;
    public final ExecutorService ioExecutor = Executors.newCachedThreadPool();
    public final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        httpClient = new OkHttpClient.Builder()
                .connectTimeout(12, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .writeTimeout(12, TimeUnit.SECONDS)
                .followRedirects(true)
                .followSslRedirects(true)
                .retryOnConnectionFailure(true)
                .addInterceptor(chain -> {
                    Request orig = chain.request();
                    if (orig.header("User-Agent") != null) return chain.proceed(orig);
                    Request withUa = orig.newBuilder()
                            .header("User-Agent", "Mozilla/5.0 (Linux; Android 15) CineVault/" + BuildConfig.VERSION_NAME)
                            .build();
                    return chain.proceed(withUa);
                })
                .build();

        streamingClient = httpClient.newBuilder()
                .connectTimeout(20, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(20, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build();

        AppDatabase db = new AppDatabase(this);
        H5aiService h5ai = new H5aiService(httpClient);
        IccService icc = new IccService(httpClient);
        CircleFtpService circle = new CircleFtpService(httpClient);
        MetadataService meta = new MetadataService(db, h5ai, icc, circle, httpClient);
        UpdateService updater = new UpdateService(httpClient);
        repository = new MediaRepository(db, h5ai, icc, circle, meta, updater);
    }

    public static CineVaultApp get() {
        return instance;
    }
}
