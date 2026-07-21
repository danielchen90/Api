import axios from "axios";
import { Environment } from "../../../shared/helpers/Environment.js";

/**
 * SermonYouTubeHelper — the server-side latest-sermon fetch (MED-01).
 *
 * QUOTA DISCIPLINE — NEVER use the 100-unit YouTube query endpoint (v3 "search"). This helper
 * resolves a channel's uploads PLAYLIST and reads it via playlistItems.list (1 quota unit), so a
 * per-campus public page can render a latest-sermon block without burning the 10,000-unit/day
 * YouTube quota (the 100-unit query endpoint would exhaust it in ~100 views). YouTubeHelper.getVideoPage
 * stays on that 100-unit endpoint for its OTHER (authenticated, import) callers — do NOT reuse it
 * here, and do NOT regress THIS file to the 100-unit query endpoint. (RESEARCH Pitfall 3, MED-01.)
 *
 * KEY SAFETY: Environment.youTubeApiKey is read SERVER-SIDE and only ever appears in the
 * upstream request URL. It is NEVER placed in the returned DTO and NEVER shipped to a client.
 *
 * FILTERING: in-progress/scheduled live videos and Shorts (<= 60s) are dropped; the newest
 * remaining COMPLETED regular upload wins.
 *
 * FAILURE MODE: empty channel, invalid channel id, or any upstream error → returns null (never
 * throws to the controller) so the UI hides the sermon block gracefully (mixed empty-state rule).
 *
 * CACHING: results and channel→uploadsPlaylistId are cached in-module with a ~10-minute TTL so
 * repeated campus-page views do not re-hit the quota.
 */

export interface LatestSermonDTO {
  videoId: string;
  title: string;
  thumbnail: string;
  publishedAt: string;
}

interface CacheEntry<T> {
  value: T;
  expiry: number;
}

const SERMON_TTL_MS = 10 * 60 * 1000; // ~10 minutes — repeated campus-page views reuse this, sparing quota.

// channelId → resolved latest sermon (or null). Short TTL.
const sermonCache = new Map<string, CacheEntry<LatestSermonDTO | null>>();
// channelId → uploads playlist id. The uploads playlist rarely changes, so this can be cached too.
const uploadsPlaylistCache = new Map<string, CacheEntry<string | null>>();

const YT_BASE = "https://www.googleapis.com/youtube/v3";

export class SermonYouTubeHelper {
  /**
   * Fetch the newest COMPLETED regular upload for a channel via its uploads playlist (1 quota unit).
   * Returns null on empty/invalid/error so the sermon block hides gracefully. Key stays server-side.
   */
  public static async getLatestSermon(channelId: string): Promise<LatestSermonDTO | null> {
    if (!channelId || typeof channelId !== "string") return null;

    const cached = this.readCache(sermonCache, channelId);
    if (cached !== undefined) return cached;

    try {
      const uploadsPlaylistId = await this.resolveUploadsPlaylist(channelId);
      if (!uploadsPlaylistId) {
        this.writeCache(sermonCache, channelId, null);
        return null;
      }

      // playlistItems.list — 1 quota unit. NEVER the 100-unit query endpoint.
      const itemsUrl =
        `${YT_BASE}/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(uploadsPlaylistId)}` +
        `&maxResults=5&key=${Environment.youTubeApiKey}`;
      const itemsJson: any = (await axios.get(itemsUrl)).data;
      const items: any[] = itemsJson?.items ?? [];
      if (items.length === 0) {
        this.writeCache(sermonCache, channelId, null);
        return null;
      }

      // Candidate video ids, newest first (uploads playlist is newest-first), dropping live/upcoming.
      const candidates: { videoId: string; snippet: any }[] = [];
      for (const item of items) {
        const vid = item?.snippet?.resourceId?.videoId || item?.contentDetails?.videoId;
        if (!vid) continue;
        const live = item?.snippet?.liveBroadcastContent;
        if (live === "live" || live === "upcoming") continue;
        candidates.push({ videoId: vid, snippet: item.snippet });
      }
      if (candidates.length === 0) {
        this.writeCache(sermonCache, channelId, null);
        return null;
      }

      // For the newest candidate, one videos.list call to drop Shorts (<=60s) / still-live videos.
      for (const cand of candidates) {
        const detailsUrl = `${YT_BASE}/videos?part=contentDetails,snippet&id=${encodeURIComponent(cand.videoId)}&key=${Environment.youTubeApiKey}`;
        const detailsJson: any = (await axios.get(detailsUrl)).data;
        const video = detailsJson?.items?.[0];
        if (!video) continue;

        const live = video?.snippet?.liveBroadcastContent;
        if (live === "live" || live === "upcoming") continue;

        const durationSeconds = this.parseDuration(video?.contentDetails?.duration ?? "");
        if (durationSeconds > 0 && durationSeconds <= 60) continue; // Short — skip.

        const snippet = video.snippet ?? cand.snippet;
        const dto: LatestSermonDTO = {
          videoId: cand.videoId,
          title: snippet?.title ?? "",
          thumbnail:
            snippet?.thumbnails?.maxres?.url ||
            snippet?.thumbnails?.high?.url ||
            snippet?.thumbnails?.medium?.url ||
            snippet?.thumbnails?.default?.url ||
            "",
          publishedAt: snippet?.publishedAt ?? ""
        };
        this.writeCache(sermonCache, channelId, dto);
        return dto;
      }

      // Every candidate filtered out (all Shorts/live) — hide the block.
      this.writeCache(sermonCache, channelId, null);
      return null;
    } catch {
      // Upstream/network/quota error → null so the block hides. Never throw to the controller.
      // Do NOT cache errors as a "no sermon" result long-term beyond the short sermon TTL default.
      this.writeCache(sermonCache, channelId, null);
      return null;
    }
  }

  /**
   * Resolve channelId → uploads playlist id via channels.list(contentDetails). Tolerates a
   * missing channel (invalid id / handle miss) by returning null (no throw). Cached.
   */
  private static async resolveUploadsPlaylist(channelId: string): Promise<string | null> {
    const cached = this.readCache(uploadsPlaylistCache, channelId);
    if (cached !== undefined) return cached;

    try {
      const url = `${YT_BASE}/channels?part=contentDetails&id=${encodeURIComponent(channelId)}&key=${Environment.youTubeApiKey}`;
      const json: any = (await axios.get(url)).data;
      const uploads: string | undefined = json?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      const value = uploads ?? null;
      this.writeCache(uploadsPlaylistCache, channelId, value);
      return value;
    } catch {
      this.writeCache(uploadsPlaylistCache, channelId, null);
      return null;
    }
  }

  private static readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private static writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    cache.set(key, { value, expiry: Date.now() + SERMON_TTL_MS });
  }

  /** ISO-8601 duration (e.g. "PT1H2M3S") → seconds. Used to detect Shorts (<= 60s). */
  private static parseDuration(duration: string): number {
    if (!duration) return 0;
    const hourMatches = duration.match(/([0-9]+)H/);
    const minuteMatches = duration.match(/([0-9]+)M/);
    const secondMatches = duration.match(/([0-9]+)S/);
    const hours = hourMatches ? parseInt(hourMatches[1], 10) : 0;
    const minutes = minuteMatches ? parseInt(minuteMatches[1], 10) : 0;
    const seconds = secondMatches ? parseInt(secondMatches[1], 10) : 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
}
