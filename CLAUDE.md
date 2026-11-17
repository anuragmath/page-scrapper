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
   - Compares new content against `posts.json` state: text diff and pixel-level image comparison via `compareImages()` (pixelmatch + pngjs/jpeg-js)
   - Returns content object if changed, `null` if unchanged
3. **Discord dispatch** via `sendDiscordMessage()` — formats and sends message with attachments (respects 25MB file / 2000-char limits)
4. **Commit** via `commitPost()` — only after a successful send: saves state and deletes the *previous* post's media. If the send fails, nothing is saved and the post is retried next cycle.

Pages are processed sequentially (one Chrome instance at a time).

**State storage:** `posts.json` tracks the last-seen post per page (URL, text, media filenames relative to `MEDIA_DIR`, timestamp). The latest post's media stays on disk so the next check can pixel-compare against it.

**Change detection:** A post is considered new if the URL changed, the text changed, or `compareImages()` returns non-identical (0 diff pixels with 0.1 threshold). Video posts skip the image comparison check.

## Key Patterns

- The project uses ES Modules (`"type": "module"` in package.json) — use `import`/`export`, not `require`.
- `parseCheckInterval(cronPattern)` converts the cron `CHECK_INTERVAL` env var to milliseconds for `setInterval`.
- Media files are downloaded to `MEDIA_DIR`; the latest post's files are kept for comparison, older ones are deleted when replaced. A missing/unreadable old image is treated as "different".
- `node-cron` is listed as a dependency but is not currently used — scheduling is done with `setInterval`.
