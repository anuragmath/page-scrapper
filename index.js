import { Builder, By, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { readFile, writeFile, open, stat, unlink, mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { Client } from 'discord.js';
import dotenv from 'dotenv';
import ffmpeg from 'fluent-ffmpeg';
import * as cheerio from 'cheerio';
import {PNG} from 'pngjs';
import pixelmatch from 'pixelmatch';
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

// Fix #9: validate PAGES before using it
let parsedPages;
try {
  parsedPages = JSON.parse(process.env.PAGES);
  if (!Array.isArray(parsedPages) || parsedPages.length === 0) throw new Error('must be a non-empty array');
} catch (e) {
  console.error(`Invalid PAGES env var: ${e.message}. Expected format: '[["PageName","channelId"]]'`);
  process.exit(1);
}

// Configuration
const config = {
  PAGES: parsedPages,
  CHECK_INTERVAL: process.env.CHECK_INTERVAL || '*/30 * * * *',
  DATA_FILE: path.join(__dirname, process.env.DATA_FILE || 'storage.json'),
  MEDIA_DIR: path.join(__dirname, process.env.MEDIA_DIR || process.env.IMAGE_DIR || 'media'),
  HEADLESS: process.env.HEADLESS !== 'false',
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  FB_URL: process.env.FB_URL
};

// Fix #6: ensure MEDIA_DIR exists before any downloads
await mkdir(config.MEDIA_DIR, { recursive: true });

// Initialize Discord
const discordClient = new Client({
  intents: []
});
discordClient.on('error', error => console.error('Discord client error:', error));

// Storage setup
let storage = { posts: {} };
try {
  storage = JSON.parse(await readFile(config.DATA_FILE, 'utf8'));
} catch { }
if (!storage || typeof storage.posts !== 'object' || storage.posts === null) storage = { posts: {} };

async function saveStorage() {
  await writeFile(config.DATA_FILE, JSON.stringify(storage, null, 2));
}

// Media is stored in posts.json by filename only, so the project folder can move
// without breaking comparisons. Older entries with absolute paths still resolve.
function resolveMediaPath(storedPath) {
  return path.join(config.MEDIA_DIR, path.basename(storedPath));
}

async function deleteFiles(filePaths, label) {
  for (const filePath of filePaths) {
    try {
      await unlink(filePath);
      console.log(`Deleted ${label} media file: ${filePath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Failed to delete ${label} media file: ${filePath}`, error.message);
    }
  }
}

// Configure browser
const chromeOptions = new chrome.Options()
  .setChromeBinaryPath(process.env.CHROME_BINARY || '/usr/bin/chromium')
  .windowSize({ width: 1280, height: 720 })
  .addArguments('--disable-notifications');

if (config.HEADLESS) chromeOptions.addArguments('--headless');

// Connectivity check endpoints
const CONNECTIVITY_ENDPOINTS = [
  'http://www.google.com',
  'http://www.cloudflare.com'
];

// Fix #8: improved error message for unsupported cron patterns
function parseCheckInterval(cronPattern) {
  const match = cronPattern.trim().match(/^\*\/(\d+)(\s+\*){4}$/);
  if (match && parseInt(match[1], 10) > 0) {
    return parseInt(match[1], 10) * 60 * 1000;
  }
  throw new Error(
    `Unsupported CHECK_INTERVAL pattern "${cronPattern}". Only "*/N * * * *" (every-N-minutes) patterns are supported.`
  );
}

const checkIntervals = {
  online: parseCheckInterval(config.CHECK_INTERVAL),
  offline: 5 * 60 * 1000 // 5 minutes
};

async function checkInternetConnectivity() {
  for (const endpoint of CONNECTIVITY_ENDPOINTS) {
    try {
      await axios.head(endpoint, { timeout: 5000 });
      return true;
    } catch (error) {
      // Continue to next endpoint if this one fails
    }
  }
  return false;
}

// Transient network failures (e.g. flaky DNS) shouldn't skip a page for a whole cycle
const RETRYABLE_NET_ERROR = /net::ERR_(NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|CONNECTION_(RESET|CLOSED|REFUSED|TIMED_OUT)|TIMED_OUT|NETWORK_CHANGED)/;

async function navigate(driver, url, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await driver.get(url);
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE_NET_ERROR.test(error.message)) throw error;
      console.warn(`Navigation to ${url} failed (${error.message.match(RETRYABLE_NET_ERROR)[0]}), retry ${attempt}/${attempts - 1}`);
      await driver.sleep(5000 * attempt);
    }
  }
}

const RETRYABLE_HTTP_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNREFUSED']);

async function withHttpRetry(fn, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE_HTTP_CODES.has(error.code)) throw error;
      await new Promise(res => setTimeout(res, 3000 * attempt));
    }
  }
}

async function processWebPost(pageName) {
  const driver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(chromeOptions)
    .build();
  const downloadedPaths = [];

  try {
    await navigate(driver, `${config.FB_URL}/${pageName}`);
    // Wait for the first post to render instead of a fixed sleep; Facebook's load time varies a lot
    try {
      await driver.wait(until.elementLocated(By.css('div[role="article"]')), 20000);
    } catch { /* fall through; handled by the "No post found" check below */ }
    await driver.sleep(2000);

    // Scroll to trigger video loading
    await driver.executeScript('window.scrollTo(0, 500)');
    await driver.sleep(3000);

    const pageSource = await driver.getPageSource();
    const $ = cheerio.load(pageSource);

    const post = $('div[role="article"]').first();
    if (!post.length) {
      console.log(`[${pageName}] No post found on page (login wall or layout change?)`);
      return null;
    }

    // Extract post metadata
    const postUrl = post.find('a[href*="/posts/"]').attr('href')?.split('?')[0];
    const fullPostUrl = postUrl ? `${postUrl}` : null;

    // Check for existing post
    if (storage.posts[pageName]?.url === fullPostUrl) {
      console.log(`[${pageName}] No new post`);
      return null;
    }

    let fullPostText = "";

    if(fullPostUrl) {
      // Navigate to the post URL to get full expanded text
      await navigate(driver, fullPostUrl);
      await driver.sleep(5000); // Wait for the page to load fully

      const postPageSource = await driver.getPageSource();
      const $$ = cheerio.load(postPageSource);

      // The post on its own page will have full caption in this selector:
      const postText = $$('div[data-ad-preview="message"]').text().trim();

      fullPostText = postText === "" ? fullPostText : postText;
    }

    // Extract embedded link metadata
    const linkPreview = post.find([
      'div[data-lynx-uri]',
      'div.x1lq5wgf',
      'a[role="link"][target="_blank"]'
    ].join(',')).first();

    let embeddedLink = null;

    if (linkPreview.length) {
      try {
        // Fix #3: guard against undefined rawUrl before decoding
        const rawUrl = linkPreview.attr('data-lynx-uri') ??
          linkPreview.find('a').attr('href') ??
          linkPreview.closest('a').attr('href');

        if (!rawUrl) throw new Error('No URL found in link preview element');

        embeddedLink = {
          url: extractUrl(decodeURIComponent(rawUrl)),
        };

        // Fix #7: null-guard embeddedLink.url before calling startsWith
        if (embeddedLink.url && !embeddedLink.url.startsWith('http')) {
          const imgParentLink = linkPreview.find('img').closest('a').attr('href');
          if (imgParentLink) {
            embeddedLink.url = extractUrl(imgParentLink);
          }
        }
      } catch (error) {
        console.error('Link processing error:', error);
      }
    }

    // Extract content
    const content = {
      text: fullPostText,
      media: [],
      url: fullPostUrl,
      embeddedLink: embeddedLink,
      timestamp: new Date().toISOString()
    };

    if (!embeddedLink) {
      // Handle videos
      const videoElement = post.find('video');
      if (videoElement.length) {
        console.log(`[${pageName}] Latest post is a video (video posts are skipped)`);
        return null;
        // const videoSrc = videoElement.attr('src');
        // if (videoSrc) {
        //   const videoPath = await downloadMedia(pageName, videoSrc, 'video');
        //   content.media.push({ type: 'video', path: videoPath });
        // }
      }

      // Handle images
      const images = post.find('img');
      for (let imgIndex = 0; imgIndex < images.length; imgIndex++) {
        const img = images[imgIndex];
        const imageUrl = $(img).attr('src');

        if (imageUrl && imageUrl.startsWith('http')) {
          try {
            // Check image size via HEAD request
            const headResponse = await withHttpRetry(() => axios.head(imageUrl, { timeout: 15000 }));
            const contentLength = headResponse.headers['content-length'];

            if (contentLength && parseInt(contentLength) > 2048) {
              const imgPath = await downloadMedia(pageName, imageUrl, 'image', imgIndex);
              if (imgPath) {
                downloadedPaths.push(imgPath);
                content.media.push({ type: 'image', path: imgPath });
              }
            }
          } catch (error) {
            console.error(`Error checking/downloading image: ${error.message}`);
          }
        }
      }
    }

    const lastPost = storage.posts[pageName];

    let isNewText = lastPost?.text !== content.text;

    const newMediaPaths = content.media.map(m => m.path);
    const oldMedia = lastPost?.media || [];

    // Compare every image before deciding anything, so no file needed for sending gets deleted early
    let isNewImage = oldMedia.length !== content.media.length;
    for (let i = 0; !isNewImage && i < content.media.length; i++) {
      const oldPath = oldMedia[i]?.path;
      if (!oldPath || !(await compareImages(content.media[i].path, resolveMediaPath(oldPath)))) {
        isNewImage = true;
      }
    }

    if (!isNewText && !isNewImage) {
      // Same content under a new URL: remember the URL so we skip re-scraping it next time
      await deleteFiles(newMediaPaths, 'duplicate');
      if (lastPost && fullPostUrl) {
        lastPost.url = fullPostUrl;
        await saveStorage();
      }
      console.log(`[${pageName}] New URL but same content as last post, skipping`);
      return null;
    }

    if (!content.text && !content.media.length) {
      console.log(`[${pageName}] Post has no text or media, skipping`);
      return null;
    }

    // Storage is updated by commitPost() only after the Discord send succeeds
    return content;
  } catch (error) {
    // Don't leave downloaded files behind if scraping/comparison fails
    await deleteFiles(downloadedPaths, 'orphaned');
    throw error;
  } finally {
    await driver.quit();
  }
}

async function downloadMedia(pageName, url, type, index = 0) {
  const ext = type === 'video' ? 'mp4' : 'jpg';
  const filename = `${pageName}_${Date.now()}_${index}.${ext}`;
  const filePath = path.join(config.MEDIA_DIR, filename);
  const fileHandle = await open(filePath, 'w');

  try {
    const response = await withHttpRetry(() => axios.get(url, { responseType: 'stream', timeout: 30000 }));
    const writer = fileHandle.createWriteStream();

    // Stream the download
    await pipeline(response.data, writer);

    // Process video if needed
    if (type === 'video') {
      await new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .format('mp4')
          .on('end', resolve)
          .on('error', reject)
          .save(filePath);
      });
    }

    return filePath;
  } catch (error) {
    console.error(`Failed to download ${type}:`, error.message);
    await fileHandle.close().catch(() => {});
    await unlink(filePath).catch(() => {});
    return null;
  } finally {
    await fileHandle.close().catch(() => {});
  }
}

function extractUrl(url) {
  try {
    let currentUrl = url;

    const urlParams = new URL(currentUrl).searchParams;
    if (urlParams.has('u')) {
      currentUrl = decodeURIComponent(urlParams.get('u'));
    }
    if (urlParams.has('url')) {
      currentUrl = decodeURIComponent(urlParams.get('url'));
    }

    // Handle multiple encoding layers
    let previousUrl;
    do {
      previousUrl = currentUrl;
      const decoded = decodeURIComponent(currentUrl);
      currentUrl = decoded.startsWith('http') ? decoded : currentUrl;
    } while (currentUrl !== previousUrl);

    return currentUrl;
  } catch (error) {
    console.error('URL extraction error:', error);
    return url;
  }
}

// Fix #5: accept buffer (not path) — Jimp.read handles both, but compareImages passes buffers
async function jpgToPngBuffer(imgBuffer) {
  const image = await Jimp.read(imgBuffer);
  return await image.getBuffer("image/png");
}

// Fix #4: use async readFile instead of blocking readFileSync
// Returns true only when both images exist and are pixel-identical; any read/decode failure counts as "different"
async function compareImages(imgPath1, imgPath2) {
  try {
    return await compareImageFiles(imgPath1, imgPath2);
  } catch (error) {
    console.warn(`Image comparison failed (treating as new): ${error.message}`);
    return false;
  }
}

async function compareImageFiles(imgPath1, imgPath2) {
  const [imgBuffer1, imgBuffer2] = await Promise.all([
    readFile(imgPath1),
    readFile(imgPath2)
  ]);

  const img1PngBuffer = await jpgToPngBuffer(imgBuffer1);
  const img2PngBuffer = await jpgToPngBuffer(imgBuffer2);

  const img1 = PNG.sync.read(img1PngBuffer);
  const img2 = PNG.sync.read(img2PngBuffer);

  if (img1.width !== img2.width || img1.height !== img2.height) return false;

  const diffPixels = pixelmatch(img1.data, img2.data, null, img1.width, img1.height, { threshold: 0.1 });
  return diffPixels === 0;
}

async function sendDiscordMessage(pageConfig, content) {
  const [pageName, channelId] = pageConfig;
  const channel = await discordClient.channels.fetch(channelId);

  // Discord rejects messages over 2000 characters
  const MAX_CONTENT = 2000;
  const header = `**${pageName}**\n`;
  const footer = content.embeddedLink?.url ? `\n\n🔗 Link: ${content.embeddedLink.url}` : '';
  let body = content.text || '';
  const room = MAX_CONTENT - header.length - footer.length;
  if (body.length > room) {
    const suffix = content.url ? `… ${content.url}` : '…';
    body = body.slice(0, Math.max(0, room - suffix.length)) + suffix;
  }

  const message = {
    content: (header + body + footer).slice(0, MAX_CONTENT),
    files: []
  };

  if (!content.embeddedLink?.url) {
    // Add media attachments (Discord limit: 25MB)
    for (const media of content.media) {
      try {
        if (media.path) {
          const fileStats = await stat(media.path);
          if (fileStats.size < 25_000_000) {
            message.files.push({
              attachment: media.path,
              name: path.basename(media.path)
            });
          } else {
            console.log(`File ${media.path} exceeds 25MB limit`);
          }
        }
      } catch (error) {
        console.error(`Error processing media ${media.path}:`, error.message);
      }
    }
  }

  const sentMessage = await channel.send(message);
  console.log(`Posted update from ${pageName} to Discord`);
  return sentMessage;
}

// Record the post as seen. The new media files are kept on disk so the next
// check can compare against them; the previous post's media is removed.
async function commitPost(pageName, content) {
  const lastPost = storage.posts[pageName];
  const keep = new Set(content.media.map(m => m.path));
  const oldPaths = (lastPost?.media || [])
    .filter(m => m.path)
    .map(m => resolveMediaPath(m.path))
    .filter(p => !keep.has(p));
  await deleteFiles(oldPaths, 'old');

  storage.posts[pageName] = {
    url: content.url,
    timestamp: content.timestamp,
    text: content.text,
    media: content.media.map(m => ({ type: m.type, path: path.basename(m.path) }))
  };
  await saveStorage();
}

async function monitorPage(pageConfig) {
  const [pageName] = pageConfig;
  let content = null;
  let sent = false;
  try {
    content = await processWebPost(pageName);
    if (!content) return;
    await sendDiscordMessage(pageConfig, content);
    sent = true;
    await commitPost(pageName, content);
  } catch (error) {
    // Selenium errors carry a huge remote stack trace; the first line is what matters
    console.error(`Error processing ${pageName}:`, error.name === 'WebDriverError' ? error.message.split('\n')[0] : error);
    // Send failed: drop this attempt's files; the post will be retried next check
    if (content && !sent) {
      await deleteFiles(content.media.map(m => m.path), 'unsent');
    }
  }
}

// Start monitoring with connectivity checks
discordClient.login(config.DISCORD_TOKEN)
  .then(async () => {
    console.log('Connected to Discord');

    async function monitoringLoop() {
      try {
        const isOnline = await checkInternetConnectivity();

        if (isOnline) {
          console.log('✅ Internet connection available - checking pages');
          // One page at a time: avoids launching a Chrome per page at once and racing writes to DATA_FILE
          for (const pageConfig of config.PAGES) {
            await monitorPage(pageConfig);
          }
          console.log(`⏳ Next check in ${checkIntervals.online / 60000} minutes`);
        } else {
          console.log('❌ No internet connection - retrying in 5 minutes');
        }

        // Schedule next check
        setTimeout(
          monitoringLoop,
          isOnline ? checkIntervals.online : checkIntervals.offline
        );
      } catch (error) {
        console.error('Monitoring loop error:', error);
        setTimeout(monitoringLoop, checkIntervals.offline);
      }
    }

    // Initial check
    monitoringLoop();
  })
  .catch(error => {
    console.error('Discord connection failed:', error);
    process.exit(1);
  });
