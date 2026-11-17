# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Node.js bot that monitors Facebook pages and relays new/changed posts to Discord channels. Uses Selenium (Chrome) to scrape dynamic Facebook content, then posts text and media attachments via discord.js.

## Commands

```bash
npm start          # Run the bot
npm install        # Install dependencies
```

No test suite exists. No build step — runs directly with Node.js.

## Environment Setup

Copy `.env.sample` to `.env` and fill in:

- `PAGES` — JSON array of `[pageName, discordChannelId]` pairs, e.g. `'[["NASA", "123456789"]]'`
- `DISCORD_TOKEN` — Discord bot token
- `FB_URL` — Facebook base URL to scrape
- `CHECK_INTERVAL` — cron pattern (default `*/30 * * * *`)
- `DATA_FILE` — path for post state storage (default `posts.json`)
- `MEDIA_DIR` (or legacy `IMAGE_DIR`) — directory for downloaded media (default `media`)
- `HEADLESS` — `true`/`false` for headless Chrome

**System dependencies:** Chrome/Chromium and FFmpeg must be installed.

## Architecture

All logic lives in `index.js` (ESM, single file). The main loop:

1. **Connectivity check** — pings Google/Cloudflare; if offline, retries every 5 minutes
2. **Per-page scrape** via `processWebPost(pageName)`:
   - Launches Chrome via Selenium WebDriver, navigates to the Facebook page
   - Parses HTML with Cheerio to extract post URL, text, and media
   - Follows the post URL to get the full post text
   - Runs `extractUrl()` to unwrap Facebook's redirect encoding on embedded links
   - Downloads media via axios streaming; processes video with fluent-ffmpeg
   - Computes a perceptual hash (Jimp `pHash`) per image and compares text + hashes against the page's recently sent posts
   - Returns content object if changed, `null` if unchanged
3. **Discord dispatch** via `sendDiscordMessage()` — formats and sends message with attachments (respects 25MB file / 2000-char limits)
4. **Commit** via `commitPost()` — only after a successful send: records the post's fingerprint and deletes its media files. If the send fails, nothing is saved and the post is retried next cycle.

Pages are processed sequentially (one Chrome instance at a time).

**State storage:** `posts.json` keeps, per page, a `recent` list of the last 20 sent posts (`urls`, `text`, image `hashes`, `timestamp`). Media is not kept on disk after sending. Old single-post entries are converted by `migrateStorage()` at startup.

**Change detection:** Facebook `pfbid` post URLs are not stable across loads, so a URL match is only a shortcut. A post is a duplicate if any recent entry has identical text and the same number of images, each within `HASH_DISTANCE_THRESHOLD` (0.1) pHash distance. This matters most for image-only posts, where there is no caption to compare. Video posts are skipped entirely.

## Key Patterns

- The project uses ES Modules (`"type": "module"` in package.json) — use `import`/`export`, not `require`.
- `parseCheckInterval(cronPattern)` converts the cron `CHECK_INTERVAL` env var to milliseconds for `setInterval`.
- Media files are downloaded to `MEDIA_DIR` and deleted after sending (or immediately if the post is a duplicate). An image that fails to hash never matches, so it is treated as new.
- `node-cron` is listed as a dependency but is not currently used — scheduling is done with `setInterval`.
