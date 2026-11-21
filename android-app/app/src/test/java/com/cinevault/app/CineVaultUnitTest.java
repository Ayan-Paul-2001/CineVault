package com.cinevault.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import com.cinevault.app.data.MediaParser;
import com.cinevault.app.data.Models;
import com.cinevault.app.data.ServerConfig;
import com.cinevault.app.data.UpdateService;

import org.json.JSONObject;
import org.junit.Test;

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
        assertEquals("https://github.com/octocat/cinevault/raw/main/public%20release/CineVault.apk",
                forced.downloadUrl);
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

        assertTrue(ServerConfig
                .isTrustedUpdateUrl("https://github.com/user/repo/raw/main/public%20release/CineVault.apk"));
        assertTrue(ServerConfig
                .isTrustedUpdateUrl("https://raw.githubusercontent.com/user/repo/main/public%20release/version.json"));
        assertFalse(
                ServerConfig.isTrustedUpdateUrl("http://github.com/user/repo/raw/main/public%20release/CineVault.apk"));
        assertFalse(ServerConfig.isTrustedUpdateUrl("https://untrusted.example.org/app.apk"));
    }
}
