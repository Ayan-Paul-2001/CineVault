package com.cinevault.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import com.cinevault.app.data.H5aiService;
import com.cinevault.app.data.IccService;
import com.cinevault.app.data.MediaDownloadManager;
import com.cinevault.app.data.MediaParser;
import com.cinevault.app.data.Models;
import com.cinevault.app.data.ServerConfig;
import com.cinevault.app.data.UpdateService;

import okhttp3.OkHttpClient;
import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

public class CineVaultUnitTest {
    @Test
    public void parserRanks4kAbove1080pAndCamRip() {
        MediaParser.ParsedMediaMeta uhd = MediaParser.parseFolderName(
                "Dune Part Two (2024) 2160p BluRay [Dual Audio]", null, null, "icc");
        MediaParser.ParsedMediaMeta hd = MediaParser.parseFolderName(
                "Dune Part Two (2024) 1080p WEB-DL", null, null, "dhakaflix");
        MediaParser.ParsedMediaMeta cam = MediaParser.parseFolderName(
                "Dune Part Two (2024) 1080p CAMRip", null, null, "circleftp");

        assertEquals("Dune Part Two", uhd.title);
        assertEquals(Integer.valueOf(2024), uhd.year);
        assertEquals("4K", uhd.quality);
        assertTrue(uhd.audioTags != null && uhd.audioTags.contains("Dual Audio"));
        assertTrue(uhd.qualityScore > hd.qualityScore);
        assertTrue(hd.qualityScore > cam.qualityScore);
    }

    @Test
    public void parserCleansBareYearAndReleaseTags() {
        assertEquals("Cult",
                MediaParser.cleanReleaseTitle("Cult 2026 1080p DS4K WEB-DL [Hindi 5.1-Telugu 5.1]ESub x264"));
        assertEquals("Cult", MediaParser.cleanReleaseTitle("Cult 2026 1080p DS4K WEB-DL ESub x264"));
        assertEquals("Dulhaniya Le Aaeegi", MediaParser.cleanReleaseTitle("Dulhaniya Le Aaeegi (2026) 720p"));
    }

    @Test
    public void parserEncodesHrefCleanly() {
        assertEquals(
                "/DHAKA-FLIX-14/English%20Movies%20(1080p)/",
                MediaParser.encodeHrefPath("/DHAKA-FLIX-14/English Movies (1080p)/"));
    }

    @Test
    public void updateServiceComparesSemverAndSlugs() {
        assertTrue(UpdateService.compareSemver("1.1.0", "1.0.0") > 0);
        assertTrue(UpdateService.compareSemver("v2.0.0", "1.9.9") > 0);
        assertEquals(0, UpdateService.compareSemver("1.0.0", "1.0.0"));
        assertTrue(UpdateService.compareSemver("1.0.0", "1.0.1") < 0);

        assertTrue(UpdateService.isValidRepoSlug("octocat/cinevault"));
        assertTrue(UpdateService.isValidRepoSlug(
                "https://raw.githubusercontent.com/octocat/cinevault/main/public%20release/version.json"));
        assertFalse(UpdateService.isValidRepoSlug("your-username/cinevault"));
        assertFalse(UpdateService.isValidRepoSlug("bad slug"));
    }

    @Test
    public void updateServiceParsesPublicReleaseVersionControlManifest() throws Exception {
        String rawJson = "{\n"
                + "  \"appVersion\": \"1.2.0\",\n"
                + "  \"appDisplayVersion\": \"V1.2.0\",\n"
                + "  \"appVersionCode\": 3,\n"
                + "  \"version\": \"1.2.0\",\n"
                + "  \"displayVersion\": \"V1.2.0\",\n"
                + "  \"versionCode\": 3,\n"
                + "  \"apkPackage\": \"CineVault.apk\",\n"
                + "  \"accessControl\": {\n"
                + "    \"forceUpdateEnabled\": true,\n"
                + "    \"forceAppUpdate\": true,\n"
                + "    \"minAppVersion\": \"1.1.0\",\n"
                + "    \"minVersion\": \"1.1.0\",\n"
                + "    \"lockTitle\": \"Mandatory Update Required\",\n"
                + "    \"lockMessage\": \"Please update CineVault to continue.\"\n"
                + "  },\n"
                + "  \"otaGatewayOverrides\": {},\n"
                + "  \"updatedAt\": \"2026-11-21T04:00:00.000Z\"\n"
                + "}";
        JSONObject obj = new JSONObject(rawJson);

        Models.AppUpdateInfo forced = UpdateService.parseVersionControlManifest(obj, "octocat/cinevault", "1.0.1", 2);
        assertNotNull(forced);
        assertTrue(forced.hasUpdate);
        assertTrue(forced.forceUpdate);
        assertEquals("V1.2.0", forced.displayVersion);
        assertEquals(3, forced.latestVersionCode);
        assertEquals("CineVault.apk", forced.apkPackage);
        assertEquals("https://raw.githubusercontent.com/octocat/cinevault/main/CineVault.apk",
                forced.downloadUrl);
        assertEquals(60L * 60L * 1000L, UpdateService.AUTO_CHECK_INTERVAL_MS);
        assertEquals("Mandatory Update Required", forced.lockTitle);

        Models.AppUpdateInfo upToDate = UpdateService.parseVersionControlManifest(obj, "octocat/cinevault", "1.2.0", 3);
        assertNotNull(upToDate);
        assertFalse(upToDate.hasUpdate);
        assertFalse(upToDate.forceUpdate);
    }

    @Test
    public void serverConfigEnforcesStrictAllowlistsAndSanitizesMediaUrls() {
        assertTrue(ServerConfig.isAllowedUrl("http://172.16.50.14/DHAKA-FLIX-14/Movie [Dual Audio].mkv"));
        assertTrue(ServerConfig.isAllowedUrl("http://10.16.100.214/Movies/Movie 2026.mkv"));
        assertTrue(ServerConfig.isAllowedUrl("http://ftp16.circleftp.net/FILE/Cult 2026 [Hindi-Telugu].mkv"));
        assertTrue(ServerConfig.isAllowedUrl("https://cdn1.discoveryftp.net/Movies/Hindi/"));
        assertFalse(ServerConfig.isAllowedUrl("http://evil.example.com/payload.apk"));
        assertFalse(ServerConfig.isAllowedUrl("file:///etc/passwd"));

        String sanitized = ServerConfig.sanitizeMediaUrl("http://ftp16.circleftp.net/FILE/Cult 2026 [Hindi].mkv");
        assertEquals("http://ftp16.circleftp.net/FILE/Cult%202026%20%5BHindi%5D.mkv", sanitized);

        String hashFile = ServerConfig.sanitizeMediaUrl("http://172.16.50.14/DHAKA-FLIX-14/Movies/#Alive (2020)/#Alive 100% HD.mkv");
        assertEquals("http://172.16.50.14/DHAKA-FLIX-14/Movies/%23Alive%20(2020)/%23Alive%20100%25%20HD.mkv", hashFile);

        String mixedPct = ServerConfig.sanitizeMediaUrl("http://ftp8.circleftp.net/FILE/100% Love%20(2019).mkv");
        assertEquals("http://ftp8.circleftp.net/FILE/100%25%20Love%20(2019).mkv", mixedPct);

        assertEquals("identity", ServerConfig.mediaHeadersFor("http://172.16.50.14/movie.mkv").get("Accept-Encoding"));
        assertEquals("http://10.16.100.244/", ServerConfig.mediaHeadersFor("http://10.16.100.214/m.mkv").get("Referer"));

        assertTrue(ServerConfig
                .isTrustedUpdateUrl("https://github.com/user/repo/raw/main/public%20release/CineVault.apk"));
        assertTrue(ServerConfig
                .isTrustedUpdateUrl("https://raw.githubusercontent.com/user/repo/main/public%20release/version.json"));
        assertFalse(
                ServerConfig.isTrustedUpdateUrl("http://github.com/user/repo/raw/main/public%20release/CineVault.apk"));
        assertFalse(ServerConfig.isTrustedUpdateUrl("https://untrusted.example.org/app.apk"));
    }

    @Test
    public void iccServiceParsesCardsAndSanitizesPosters() {
        IccService icc = new IccService(new OkHttpClient());
        String html = "<div class=\"news-content\">"
                + "<div class=\"post\" data-publish-date=\"15.11.2026\">"
                + "<a href=\"player.php?play=998877\"><img src=\"files/Poster [4K] 2026.jpg\"></a>"
                + "<div class=\"title\">Dune Part Two (2024) 2160p</div>"
                + "</div></div>";
        List<IccService.IccCard> cards = icc.parseCardsHtml(html);
        assertEquals(1, cards.size());
        assertEquals("998877", cards.get(0).playId);
        assertEquals("http://10.16.100.244/player.php?play=998877", cards.get(0).url);
        assertEquals("http://10.16.100.244/files/Poster%20%5B4K%5D%202026.jpg", cards.get(0).posterUrl);
    }

    @Test
    public void downloadManagerSanitizesFileNamesAndInfersMime() {
        assertEquals("Dune Part Two (2024) 4K.mkv",
                MediaDownloadManager.sanitizeDownloadFileName("/Movies/Dune: Part Two? (2024) 4K.mkv", "fallback.mkv"));
        assertEquals("video/x-matroska", MediaDownloadManager.inferMimeType("Movie.MKV"));
        assertEquals("video/mp4", MediaDownloadManager.inferMimeType("Episode.mp4"));
        assertEquals("application/x-subrip", MediaDownloadManager.inferMimeType("English.srt"));
    }

    @Test
    public void browseFilterAndSearchFacetsPreserveDynamicFilterState() {
        Models.BrowseFilter f = new Models.BrowseFilter();
        f.query = "game of thrones";
        f.category = "tv-series";
        f.skipCount = true;
        f.limit = 36;
        Models.BrowseFilter copy = f.copy();
        assertEquals("game of thrones", copy.query);
        assertEquals("tv-series", copy.category);
        assertTrue(copy.skipCount);
        assertEquals(36, copy.limit);
        assertEquals(1, copy.activeFilterCount());

        java.util.Map<String, Integer> byCat = new java.util.HashMap<>();
        byCat.put("tv-series", 3);
        byCat.put("documentary", 1);
        Models.SearchFacets facets = new Models.SearchFacets(
                6, false, byCat, java.util.Arrays.asList(2019, 2011),
                java.util.Collections.singletonMap(2019, 2),
                java.util.Collections.singletonMap("1080p", 3),
                java.util.Collections.singletonMap("dual", 1),
                java.util.Collections.emptyList(),
                java.util.Collections.singletonMap("circleftp", 2)
        );
        Models.BrowsePageResult page = new Models.BrowsePageResult(java.util.Collections.emptyList(), 6, 1, 1, facets);
        assertNotNull(page.facets);
        assertEquals(6, page.facets.totalUnfiltered);
        assertEquals(Integer.valueOf(3), page.facets.byCategory.get("tv-series"));
        assertEquals(Integer.valueOf(3), page.facets.qualities.get("1080p"));
    }

    @Test
    public void dynamicServerRegistryAllowsCustomServersAndBlocksLoopback() {
        assertFalse(ServerConfig.isSafeServerUrl("http://127.0.0.1/movies/"));
        assertFalse(ServerConfig.isSafeServerUrl("http://localhost:8080/"));
        assertFalse(ServerConfig.isSafeServerUrl("http://169.254.169.254/latest/meta-data/"));
        assertFalse(ServerConfig.isSafeServerUrl("ftp://192.168.1.50/movies/"));
        assertTrue(ServerConfig.isSafeServerUrl("http://192.168.1.50:8080/Movies/"));

        try {
            Models.ManagedServer custom = new Models.ManagedServer(
                    "custom-myisp-1a2b", "custom-myisp-1a2b", "My ISP FTP", "directory",
                    "http://192.168.1.50:8080", "/Movies/", null, true, false, false, 5500, "[]", 0, 0L);
            Models.ManagedServer disabledBuiltin = new Models.ManagedServer(
                    "icc-main", "icc", "ICC FTP", "icc",
                    ServerConfig.ICC_ORIGIN, "/command.php", null, false, true, false, 5500, null, 0, 0L);
            ServerConfig.setDynamicServerRegistry(java.util.Arrays.asList(custom, disabledBuiltin));

            assertTrue(ServerConfig.isAllowedUrl("http://192.168.1.50:8080/Movies/Dune.2024.mkv"));
            assertFalse(ServerConfig.isAllowedUrl("http://10.16.100.244/player.php?play=1"));
            assertFalse(ServerConfig.isAllowedUrl("http://127.0.0.1:8080/secret.mkv"));
            assertEquals("My ISP FTP", ServerConfig.serverDisplayName("custom-myisp-1a2b", "http://192.168.1.50:8080"));
        } finally {
            ServerConfig.setDynamicServerRegistry(null);
        }
    }

    @Test
    public void universalAutoindexParserExtractsApacheAndNginxListings() {
        String html = "<html><body><h1>Index of /Movies/</h1><pre>"
                + "<a href=\"../\">Parent Directory</a>\n"
                + "<a href=\"Hindi%20Movies/\">Hindi Movies/</a> 2026-11-20 12:00 -\n"
                + "<a href=\"PC%20Games/\">PC Games/</a> 2026-11-20 12:00 -\n"
                + "<a href=\"Inception%20(2010)%201080p.mkv\">Inception (2010) 1080p.mkv</a> 2026-11-21 10:00 4.2 GB\n"
                + "<a href=\"?C=N;O=D\">Name</a>\n"
                + "</pre></body></html>";

        List<H5aiService.H5aiEntry> entries = H5aiService.parseGenericAutoindexHtml(
                "http://ftp.example.net", "/Movies/", html);
        assertEquals(3, entries.size());
        assertEquals("Hindi Movies", entries.get(0).name);
        assertTrue(entries.get(0).isDir);
        assertEquals("Inception (2010) 1080p.mkv", entries.get(2).name);
        assertFalse(entries.get(2).isDir);
        assertEquals("video", entries.get(2).kind);
        assertTrue(entries.get(2).size > 4_000_000_000L);

        H5aiService.FolderClassification hindiCls = H5aiService.classifyDiscoveredFolder("Hindi Movies");
        assertEquals("hindi", hindiCls.category);
        assertEquals("movie", hindiCls.mediaType);
        assertFalse(hindiCls.skipDefault);

        H5aiService.FolderClassification gamesCls = H5aiService.classifyDiscoveredFolder("PC Games");
        assertTrue(gamesCls.skipDefault);

        assertTrue(H5aiService.isContainerWrapperName("Movies"));
        assertTrue(H5aiService.isContainerWrapperName("DHAKA-FLIX-14"));
        assertTrue(H5aiService.isContainerWrapperName("SOUTH INDIAN MOVIES"));
        assertTrue(H5aiService.isBucketLikeFolderName("2026"));
        assertTrue(H5aiService.isBucketLikeFolderName("(2026)"));
        assertTrue(H5aiService.isBucketLikeFolderName("(2026) 1080p"));
        assertTrue(H5aiService.isBucketLikeFolderName("(1995) 1080p & Before"));
        assertTrue(H5aiService.isBucketLikeFolderName("(1995 & Before)"));
        assertTrue(H5aiService.isBucketLikeFolderName("(A-L)"));
        assertFalse(H5aiService.isBucketLikeFolderName("1917 (2019) 1080p"));
        assertFalse(H5aiService.isTitleLikeFolderName("(2026)"));
        assertFalse(H5aiService.isTitleLikeFolderName("(2026) 1080p"));
        assertFalse(H5aiService.isTitleLikeFolderName("English Movies (1080p)"));
        assertFalse(H5aiService.isTitleLikeFolderName("Animation Movies (1080p)"));
        assertTrue(H5aiService.isTitleLikeFolderName("Dune Part Two (2024) 1080p WEB-DL"));
        assertEquals("english-1080p", H5aiService.classifyDiscoveredFolder("English Movies (1080p)").category);
        assertEquals("animation-1080p", H5aiService.classifyDiscoveredFolder("Animation Movies (1080p)").category);
    }

    @Test
    public void automaticServerUrlNormalizationPortalLinksAndDirectVideoMergeParsing() {
        // Scheme-less URLs auto-normalize to http://; loopback & non-HTTP schemes stay blocked
        assertEquals("http://10.16.100.244/dashboard.php", ServerConfig.normalizeServerInputUrl("10.16.100.244/dashboard.php"));
        assertEquals("http://172.16.50.14", ServerConfig.normalizeServerInputUrl("172.16.50.14"));
        assertTrue(ServerConfig.isSafeServerUrl("172.16.50.14"));
        assertTrue(ServerConfig.isSafeServerUrl("10.16.100.244/dashboard.php"));
        assertFalse(ServerConfig.isSafeServerUrl("127.0.0.1/movies"));
        assertFalse(ServerConfig.isSafeServerUrl("ftp://192.168.1.50/movies/"));

        // Never append trailing slash to .php / .html files
        assertEquals("/", H5aiService.normalizeServerRootHref("/dashboard.php"));
        assertEquals("/portal/", H5aiService.normalizeServerRootHref("/portal/index.html"));
        assertEquals("/DHAKA-FLIX-14/", H5aiService.normalizeServerRootHref("/DHAKA-FLIX-14"));

        // Portal HTML link extractor handles multi-segment directories & ignores static assets/login
        String portalHtml = "<html><body>"
                + "<a href=\"/login\">Login</a>"
                + "<a href=\"/assets/style.css\">CSS</a>"
                + "<a href=\"http://172.16.50.14/DHAKA-FLIX-14/Hindi%20Movies/\">Hindi</a>"
                + "<a href=\"/DHAKA-FLIX-14/English%20Movies%20(1080p)/\">English</a>"
                + "</body></html>";
        H5aiService.PortalLinksResult pRes = H5aiService.extractPortalDirectoryLinks("http://172.16.50.14", portalHtml);
        assertEquals("http://172.16.50.14", pRes.origin);
        assertEquals(2, pRes.entries.size());
        assertEquals("Hindi Movies", pRes.entries.get(0).name);

        // Direct scene-named .mkv video file parses cleanly to merge with DhakaFlix/ICC/CircleFTP
        MediaParser.ParsedMediaMeta parsed = MediaParser.parseFolderName(
                "Inception.2010.1080p.BluRay.x264.mkv", null, "2010", "custom-isp");
        assertEquals("Inception.2010.1080p.BluRay.x264.mkv", parsed.rawName);
        assertEquals("Inception", parsed.title);
        assertEquals("inception", parsed.cleanTitle);
        assertEquals(Integer.valueOf(2010), parsed.year);
        assertEquals("1080p", parsed.quality);
        assertEquals("BLURAY", parsed.sourceTag);

        // Subdomain & alternate-port allowlisting for enabled custom FTP servers
        try {
            Models.ManagedServer isp = new Models.ManagedServer(
                    "custom-isp-1", "custom-isp-1", "ISP FTP", "directory",
                    "http://ftp.myisp.net", "/Movies/", null, true, false, false, 5500, "[]", 0, 0L);
            ServerConfig.setDynamicServerRegistry(java.util.Collections.singletonList(isp));
            assertTrue(ServerConfig.isAllowedUrl("http://ftp.myisp.net:8080/Movies/Inception.mkv"));
            assertTrue(ServerConfig.isAllowedUrl("http://cdn2.myisp.net/Movies/Inception.mkv"));
            assertFalse(ServerConfig.isAllowedUrl("http://evil.otherdomain.com/secret.mkv"));
        } finally {
            ServerConfig.setDynamicServerRegistry(null);
        }
    }

    @Test
    public void v142OneTimeServerFeaturePopupStrictlyScopedToV142() {
        assertEquals("1.4.2", BuildConfig.VERSION_NAME);
        assertEquals(12, BuildConfig.VERSION_CODE);
        assertEquals(5000L, UpdateService.V142_FEATURE_POPUP_DURATION_MS);

        // Shows once on V1.4.2 when unseen
        assertTrue(UpdateService.shouldShowV142ServerFeaturePopup("1.4.2", false));
        // Never shows again on further launches of V1.4.2
        assertFalse(UpdateService.shouldShowV142ServerFeaturePopup("1.4.2", true));
        // Strictly excluded from every future or older release version
        assertFalse(UpdateService.shouldShowV142ServerFeaturePopup("1.4.3", false));
        assertFalse(UpdateService.shouldShowV142ServerFeaturePopup("1.5.0", false));
        assertFalse(UpdateService.shouldShowV142ServerFeaturePopup("2.0.0", false));
        assertFalse(UpdateService.shouldShowV142ServerFeaturePopup("1.4.0", false));
        assertFalse(UpdateService.shouldShowV142ServerFeaturePopup(null, false));
    }
}
