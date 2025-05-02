import { Builder } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { readFile, writeFile, open, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { Client } from 'discord.js';
import dotenv from 'dotenv';
import ffmpeg from 'fluent-ffmpeg';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

// Configuration
const config = {
  PAGES: JSON.parse(process.env.PAGES),
  CHECK_INTERVAL: process.env.CHECK_INTERVAL || '*/30 * * * *',
  DATA_FILE: path.join(__dirname, process.env.DATA_FILE || 'storage.json'),
  MEDIA_DIR: path.join(__dirname, process.env.MEDIA_DIR || 'media'),
  HEADLESS: process.env.HEADLESS !== 'false',
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  FB_URL: process.env.FB_URL
};

// Initialize Discord
const discordClient = new Client({
  intents: []
});

// Storage setup
let storage = { posts: {} };
try {
  storage = JSON.parse(await readFile(config.DATA_FILE, 'utf8'));
} catch { }

// Configure browser
const chromeOptions = new chrome.Options()
  .windowSize({ width: 1280, height: 720 })
  .addArguments('--disable-notifications');

if (config.HEADLESS) chromeOptions.addArguments('--headless');

// Connectivity check endpoints
const CONNECTIVITY_ENDPOINTS = [
  'http://www.google.com',
  'http://www.cloudflare.com'
];

// Convert cron pattern to milliseconds
function parseCheckInterval(cronPattern) {
  const cronParts = cronPattern.split(' ');
  if (cronParts[0].startsWith('*/')) {
    const minutes = parseInt(cronParts[0].substring(2));
    return minutes * 60 * 1000;
  }
  throw new Error('Only simple interval cron patterns are supported');
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

async function processWebPost(pageName) {
  const driver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(chromeOptions)
    .build();

  try {
    await driver.get(`${config.FB_URL}/${pageName}`);
    await driver.sleep(5000);

    // Scroll to trigger video loading
    await driver.executeScript('window.scrollTo(0, 500)');
    await driver.sleep(3000);

    const pageSource = await driver.getPageSource();
    const $ = cheerio.load(pageSource);

    const post = $('div[role="article"]').first();
    if (!post.length) return null;

    // Extract post metadata
    const postUrl = post.find('a[href*="/posts/"]').attr('href')?.split('?')[0];
    const fullPostUrl = postUrl ? `${postUrl}` : null;

    // Check for existing post
    if (storage.posts[pageName]?.url === fullPostUrl) return null;

    // New: Extract embedded link metadata
    const linkPreview = post.find([
      'div[data-lynx-uri]',
      'div.x1lq5wgf', // Example class-based selector
      'a[role="link"][target="_blank"]'
    ].join(',')).first();

    let embeddedLink = null;

    if (linkPreview.length) {
      try {
        const rawUrl = linkPreview.attr('data-lynx-uri') ||
          linkPreview.find('a').attr('href') ||
          linkPreview.closest('a').attr('href');

        embeddedLink = {
          url: extractUrl(decodeURIComponent(rawUrl)),
          // Keep existing title/image extraction if needed
        };

        // Special case for image-only links
        if (!embeddedLink.url.startsWith('http')) {
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
      text: post.find('div[data-ad-preview="message"]').text().trim(),
      media: [],
      url: fullPostUrl,
      embeddedLink: embeddedLink, // Add embedded link metadata
      timestamp: new Date().toISOString()
    };

    if (!embeddedLink) {
      // Handle videos
      const videoElement = post.find('video');
      if (videoElement.length) {
        const videoSrc = videoElement.attr('src');
        if (videoSrc) {
          const videoPath = await downloadMedia(pageName, videoSrc, 'video');
          content.media.push({ type: 'video', path: videoPath });
        }
      }

      // Handle images
      const images = post.find('img');
      images.each(async (imgIndex, img) => {
        const imageUrl = $(img).attr('src');

        if (imageUrl && imageUrl.startsWith('http')) {
          // First check image size via HEAD request
          const headResponse = await axios.head(imageUrl);
          const contentLength = headResponse.headers['content-length'];

          if (contentLength && parseInt(contentLength) > 2048) {
            const imgPath = await downloadMedia(pageName, imageUrl, 'image', imgIndex);
            content.media.push({ type: 'image', path: imgPath });
          }
        }
      });
    }

    // Update storage
    storage.posts[pageName] = {
      url: content.url,
      timestamp: content.timestamp
    };
    await writeFile(config.DATA_FILE, JSON.stringify(storage, null, 2));

    return content;
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
    const response = await axios.get(url, { responseType: 'stream' });
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
    console.error(`Failed to download ${type}:`, error);
    return null;
  } finally {
    if (fileHandle) await fileHandle.close();
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

async function sendDiscordMessage(pageConfig, content) {
  const [pageName, channelId] = pageConfig;
  const channel = await discordClient.channels.fetch(channelId);
  const filesToDelete = [];

  const message = {
    content: `**${pageName}**\n${content.text}`,
    files: []
  };

  if (content.embeddedLink?.url) {
    //   message.content += `\n\n🔗 **[Click Here](${content.embeddedLink.url})**`;
    message.content += `\n\n🔗 Link: ${content.embeddedLink.url}`;
  } else {
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

            filesToDelete.push(media.path);
          } else {
            console.log(`File ${media.path} exceeds 25MB limit`);
          }
        }
      } catch (error) {
        console.error(`Error processing media ${media.path}:`, error.message);
      }
    }
  }

  try {
    const sentMessage = await channel.send(message);
    console.log(`Posted update from ${pageName} to Discord`);

    // Delete files after successful upload
    await Promise.allSettled(
      filesToDelete.map(async (filePath) => {
        try {
          await unlink(filePath);
          console.log(`Deleted ${path.basename(filePath)}`);
        } catch (error) {
          console.error(`Failed to delete ${filePath}:`, error.message);
        }
      })
    );

    return sentMessage;
  } catch (error) {
    console.error(`Failed to send message to Discord:`, error.message);
    throw error;
  }
}

async function monitorPage(pageConfig) {
  try {
    const content = await processWebPost(pageConfig[0]);
    if (content) await sendDiscordMessage(pageConfig, content);
  } catch (error) {
    console.error(`Error processing ${pageConfig[0]}:`, error);
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
          await Promise.all(config.PAGES.map(monitorPage));
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