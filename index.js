require('dotenv').config();
const { BskyAgent, RichText } = require('@atproto/api');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

// ---------------- CONFIG ----------------

const SPOTLIGHT_USER = process.env.SPOTLIGHT_USER || 'yourhandle.bsky.social';
const SITE_API_URL = process.env.SPOTLIGHT_API_URL || ''; // e.g. https://spotlight.yourdomain.com

const POST_INTERVAL = 10 * 60 * 1000;
const CHECK_INTERVAL = 15 * 60 * 1000;
const SEARCH_INTERVAL = 15 * 60 * 1000;
const NETWORK_INTERVAL = 30 * 60 * 1000;
const FOLLOWBACK_INTERVAL = 10 * 60 * 1000;
const HEALTH_INTERVAL = 5 * 60 * 1000;
const MAX_POST_AGE_MS = 3 * 24 * 60 * 60 * 1000; 

const MAX_QUEUE = Number(process.env.MAX_QUEUE || 2000);
const MAX_TEXT_LEN = 280; // Keep some safety; Bluesky supports ~300 but facets/linking can push it.

const agent = new BskyAgent({ service: 'https://bsky.social' });

// ---------------- DB ----------------

const db = new sqlite3.Database('bot-state.db');
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

async function initDatabase() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS posted_uris (
      uri TEXT PRIMARY KEY,
      posted_at INTEGER
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS followed_dids (
      did TEXT PRIMARY KEY,
      followed_at INTEGER
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS post_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT,
      author_did TEXT,
      text TEXT,
      uri TEXT UNIQUE,
      timestamp INTEGER
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS blocklist (
      did TEXT PRIMARY KEY,
      handle TEXT,
      reason TEXT,
      added_at INTEGER
    )
  `);

  console.log('✅ Database initialized');
}

async function isPosted(uri) {
  const row = await dbGet('SELECT uri FROM posted_uris WHERE uri = ?', [uri]);
  return !!row;
}

async function markAsPosted(uri) {
  await dbRun('INSERT OR IGNORE INTO posted_uris (uri, posted_at) VALUES (?, ?)', [uri, Date.now()]);
}

async function isFollowed(did) {
  const row = await dbGet('SELECT did FROM followed_dids WHERE did = ?', [did]);
  return !!row;
}

async function markAsFollowed(did) {
  await dbRun('INSERT OR IGNORE INTO followed_dids (did, followed_at) VALUES (?, ?)', [did, Date.now()]);
}

async function isBlocked(did) {
  const row = await dbGet('SELECT did FROM blocklist WHERE did = ?', [did]);
  return !!row;
}

async function addToBlocklist(did, handle, reason = 'user request') {
  await dbRun(
    'INSERT OR IGNORE INTO blocklist (did, handle, reason, added_at) VALUES (?, ?, ?, ?)',
    [did, handle, reason, Date.now()]
  );
  console.log(`⛔ Blocked @${handle} (${reason})`);
}

async function addToQueue(submission) {
  // queue protection
  const q = await getQueueSize();
  if (q >= MAX_QUEUE) {
    console.warn(`⚠️ Queue at cap (${MAX_QUEUE}). Skipping new enqueue.`);
    return;
  }

  try {
    await dbRun(
      'INSERT OR IGNORE INTO post_queue (author, author_did, text, uri, timestamp) VALUES (?, ?, ?, ?, ?)',
      [submission.author, submission.authorDid, submission.text, submission.uri, submission.timestamp]
    );
  } catch (err) {
    // ignore unique insert collisions
    if (!String(err.message).includes('UNIQUE constraint')) throw err;
  }
}

async function getNextFromQueue() {
  return await dbGet('SELECT * FROM post_queue ORDER BY timestamp ASC LIMIT 1');
}

async function removeFromQueue(id) {
  await dbRun('DELETE FROM post_queue WHERE id = ?', [id]);
}

async function getQueueSize() {
  const row = await dbGet('SELECT COUNT(*) as count FROM post_queue');
  return row?.count || 0;
}

async function getStats() {
  const posted = await dbGet('SELECT COUNT(*) as count FROM posted_uris');
  const followed = await dbGet('SELECT COUNT(*) as count FROM followed_dids');
  const blocked = await dbGet('SELECT COUNT(*) as count FROM blocklist');
  const queued = await getQueueSize();
  return {
    posted: posted?.count || 0,
    followed: followed?.count || 0,
    blocked: blocked?.count || 0,
    queued
  };
}

// ---------------- HELPERS ----------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function convertAtUriToWebUrl(uri, authorHandle) {
  try {
    const parts = uri.split('/');
    const postId = parts[parts.length - 1];
    return `https://bsky.app/profile/${authorHandle}/post/${postId}`;
  } catch {
    return null;
  }
}

// Conservative heuristic tags for the website
function inferTag(text) {
  const lower = (text || '').toLowerCase();

  if (lower.includes('game') || lower.includes('steam') || lower.includes('itch.io') || lower.includes('unity') || lower.includes('unreal')) {
    return 'indie-games';
  }
  if (lower.includes('startup') || lower.includes('mvp') || lower.includes('funding') || lower.includes('saas')) {
    return 'indie-startups';
  }
  return 'indie-software';
}

function isPostTooOld(post) {
  try {
    // Posts have indexedAt timestamp from Bluesky
    const postTime = post?.indexedAt || post?.record?.createdAt;
    if (!postTime) return false; // If no timestamp, allow it through
    
    const postDate = new Date(postTime).getTime();
    const now = Date.now();
    const age = now - postDate;
    
    return age > MAX_POST_AGE_MS;
  } catch (err) {
    console.error('Error checking post age:', err.message);
    return false; // If error, don't filter it out
  }
}

// ---------------- AUTH ----------------

async function login() {
  try {
    await agent.login({
      identifier: process.env.BLUESKY_USERNAME,
      password: process.env.BLUESKY_PASSWORD
    });
    console.log('✅ Logged in as:', process.env.BLUESKY_USERNAME);
    return true;
  } catch (err) {
    console.error('❌ Login failed:', err.message);
    return false;
  }
}

// ---------------- FOLLOWING ----------------

async function autoFollow(did) {
  if (!did) return;
  if (await isFollowed(did)) return;

  try {
    const profile = await agent.getProfile({ actor: did });

    if (profile.data.viewer?.following) {
      await markAsFollowed(did);
      return;
    }

    console.log('➕ Following user:', profile.data.handle);
    await agent.follow(did);
    await markAsFollowed(did);
    await sleep(1200);
  } catch (err) {
    console.error('Follow error:', err.message);
  }
}

async function followBack() {
  try {
    console.log('🔄 Running follow-back routine...');
    const followers = await agent.getFollowers({
      actor: process.env.BLUESKY_USERNAME,
      limit: 100
    });

    for (const f of followers.data.followers) {
      if (!(await isFollowed(f.did))) {
        console.log('↩️ Following back:', f.handle);
        await autoFollow(f.did);
      }
    }
  } catch (err) {
    console.error('Followback error:', err.message);
  }
}

// ---------------- FILTERS ----------------

const PROMO_KEYWORDS = [
  'launched', 'built this', 'made this', 'working on', 'side project',
  'feedback welcome', 'check out my', 'just shipped', 'new project',
  'my app', 'my game', 'my product', 'my startup'
];

const SPAM_PATTERNS = [
  'cupom', 'precinho', 'amazon', 'iphone', 'playstation', 'nintendo',
  'preço', 'oferta', 'desconto', 'compre', 'deal', 'sale', 'lumens',
  'flashlight', 'rechargeable', 'camera -', 'wireless security',
  'breaking:', 'breaking news', 'cbs', 'nbc', 'nba', 'nfl', 'sports',
  'game highlights', 'watch:', 'video:', 'stream:', 'live now',
  'laser', '3d print', 'journal', 'research paper', 'academic'
];

const BAD_CONTEXT = [
  'buy now', 'order', 'purchase', 'shipping', 'delivery', 'battery',
  'waterproof', 'warranty', 'research', 'study', 'paper', 'journal'
];

function looksLikePromo(text) {
  const lower = (text || '').toLowerCase();

  if (SPAM_PATTERNS.some(spam => lower.includes(spam))) return false;
  if (BAD_CONTEXT.some(bad => lower.includes(bad))) return false;

  const linkCount = (lower.match(/https?:\/\//g) || []).length;
  if (linkCount > 2) return false;
  if ((text || '').length < 20 && !lower.includes('#promote')) return false;

  if (lower.includes('#promote')) return true;

  if (lower.includes('#spotlight')) {
    const hasDevContext = ['built', 'made', 'working on', 'project', 'app', 'game', 'website', 'startup', 'launch', 'feedback', 'beta']
      .some(word => lower.includes(word));
    if (hasDevContext) return true;
  }

  if (lower.includes('#buildinpublic') || lower.includes('#indiehackers') ||
      lower.includes('#indiedev') || lower.includes('#solopreneur')) {
    return true;
  }

  const hasLink = lower.includes('http://') || lower.includes('https://');
  const keywordMatches = PROMO_KEYWORDS.filter(word => lower.includes(word));
  return hasLink && keywordMatches.length >= 2;
}

// ---------------- WEBSITE PUSH ----------------

async function sendSpotlightToSite(submission, postUrl) {
  if (!SITE_API_URL) return;

  const tag = inferTag(submission.text);

  try {
    const resp = await fetch(`${SITE_API_URL}/api/spotlights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author_handle: submission.author,
        author_did: submission.author_did,
        content: submission.text,
        post_url: postUrl,
        tag
      })
    });

    if (resp.ok) {
      console.log('🌐 Spotlight sent to site');
    } else {
      const t = await resp.text().catch(() => '');
      console.error('🌐 Site API rejected spotlight:', resp.status, t.slice(0, 200));
    }
  } catch (err) {
    console.error('🌐 Failed to send spotlight to site:', err.message);
  }
}

// ---------------- DISCOVERY ----------------

async function addPostIfRelevant(post, sourceLabel = 'search') {
  const uri = post?.uri;
  if (!uri) return;
  if (await isPosted(uri)) return;

  // NEW: Check post age
  if (isPostTooOld(post)) {
    console.log(`⏰ Skipped old post (>3 days) from @${post?.author?.handle || 'unknown'}`);
    return;
  }

  const text = post?.record?.text || post?.text || '';
  if (!text) return;

  const authorHandle = post?.author?.handle || 'unknown';
  const authorDid = post?.author?.did || 'unknown';

  if (await isBlocked(authorDid)) {
    console.log(`⛔ Skipped blocked user: @${authorHandle}`);
    return;
  }

  // prevent self
  const ownHandle = (process.env.BLUESKY_USERNAME || '').replace('.bsky.social', '');
  if (authorHandle === ownHandle || authorHandle.includes(ownHandle)) {
    return;
  }

  if (looksLikePromo(text)) {
    console.log(`✅ [${sourceLabel}] Queuing post from @${authorHandle}`);
    console.log(`   Preview: ${(text || '').slice(0, 180).replace(/\n/g, ' ')}${text.length > 180 ? '…' : ''}`);

    await addToQueue({
      author: authorHandle,
      authorDid,
      text,
      uri,
      timestamp: Date.now()
    });

    await markAsPosted(uri);
    await autoFollow(authorDid);
  }
}

async function searchStartupPosts() {
  try {
    console.log('🔎 Searching community hashtags...');
    const searchTerms = [
      '#spotlight', '#promote', '#buildinpublic',
      '#indiehackers', '#indiedev', '#solopreneur'
    ];

    for (const keyword of searchTerms) {
      try {
        const resp = await agent.app.bsky.feed.searchPosts({
          q: keyword,
          limit: 15
        });

        const posts = resp?.data?.posts || [];
        console.log(`   Found ${posts.length} posts for "${keyword}"`);

        for (const post of posts) {
          await addPostIfRelevant(post, `search:${keyword}`);
        }

        await sleep(1200);
      } catch (err) {
        console.error(`Search failed for "${keyword}":`, err.message);
      }
    }

    console.log(`📊 Search complete. Queue size: ${await getQueueSize()}`);
  } catch (err) {
    console.error('Search error:', err.message);
  }
}

async function searchFollowingNetwork() {
  try {
    console.log('🧭 Checking following network...');
    const following = await agent.getFollows({
      actor: process.env.BLUESKY_USERNAME,
      limit: 50
    });

    let checkedCount = 0;

    for (const user of following.data.follows) {
      try {
        const feed = await agent.getAuthorFeed({
          actor: user.did,
          limit: 5
        });

        for (const feedItem of feed.data.feed) {
          if (feedItem.post) {
            await addPostIfRelevant(feedItem.post, `following:${user.handle}`);
          }
        }

        checkedCount++;
        await sleep(500);
      } catch (err) {
        console.error(`Error checking @${user.handle}:`, err.message);
      }
    }

    console.log(`📊 Network search complete (checked ${checkedCount} users). Queue: ${await getQueueSize()}`);
  } catch (err) {
    console.error('Network search error:', err.message);
  }
}

async function checkForSubmissions() {
  try {
    console.log('📨 Checking mentions & replies...');
    const notifications = await agent.listNotifications({ limit: 50 });
    let foundCount = 0;

    for (const notif of notifications.data.notifications) {
      const isRelevant = notif.reason === 'mention' || notif.reason === 'reply';
      if (!isRelevant || !notif.record?.text) continue;

      const text = notif.record.text;
      const authorDid = notif.author.did;
      const authorHandle = notif.author.handle;
      const lowerText = text.toLowerCase();

      // opt-out handling
      if (
        lowerText.includes('stop') || lowerText.includes('unfollow') ||
        lowerText.includes('dont follow') || lowerText.includes("don't follow") ||
        lowerText.includes('opt out') || lowerText.includes('remove me') ||
        lowerText.includes('no bot') || lowerText.includes('unsubscribe')
      ) {
        await addToBlocklist(authorDid, authorHandle, 'user request');

        // unfollow if currently following
        try {
          const profile = await agent.getProfile({ actor: authorDid });
          if (profile.data.viewer?.following) {
            await agent.deleteFollow(profile.data.viewer.following);
            console.log(`🚫 Unfollowed @${authorHandle} per request`);
          }
        } catch (err) {
          console.error('Unfollow error:', err.message);
        }

        // polite reply
        try {
          await agent.post({
            text: `@${authorHandle} Got it — I won’t feature or follow you. Sorry about that!`,
            reply: {
              root: { uri: notif.uri, cid: notif.cid },
              parent: { uri: notif.uri, cid: notif.cid }
            }
          });
        } catch (err) {
          console.error('Reply error:', err.message);
        }

        continue;
      }

      if (await isPosted(notif.uri)) continue;
      if (await isBlocked(authorDid)) continue;

      if (lowerText.includes('#spotlight') || lowerText.includes('#promote') || looksLikePromo(text)) {
        console.log(`✅ New submission from @${authorHandle}`);
        await addToQueue({
          author: authorHandle,
          authorDid,
          text,
          uri: notif.uri,
          timestamp: Date.now()
        });

        await markAsPosted(notif.uri);
        await autoFollow(authorDid);
        foundCount++;

        try {
          await agent.like(notif.uri, notif.cid);
        } catch (err) {
          console.error('Like error:', err.message);
        }
      }
    }

    // Spotlight user's feed
    try {
      const spotlightFeed = await agent.getAuthorFeed({
        actor: SPOTLIGHT_USER,
        limit: 30
      });

      for (const feedItem of spotlightFeed.data.feed) {
        if (feedItem.post) {
          await addPostIfRelevant(feedItem.post, 'spotlightUser');
        }
      }
    } catch (err) {
      console.error('Spotlight user feed error:', err.message);
    }

    console.log(`📬 Submissions check complete. Found ${foundCount}. Queue: ${await getQueueSize()}`);
  } catch (err) {
    console.error('Submission check error:', err.message);
  }
}

// ---------------- POSTING ----------------

function stripTags(text) {
  return (text || '')
    .replace(/#spotlight/gi, '')
    .replace(/#promote/gi, '')
    .replace(/#buildinpublic/gi, '')
    .replace(/#indiehackers/gi, '')
    .replace(/#indiedev/gi, '')
    .replace(/#solopreneur/gi, '')
    .trim();
}

function clampText(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(0, maxLen - 3)) + '...';
}

async function postSpotlight() {
  console.log('⏰ Post spotlight timer triggered');

  const submission = await getNextFromQueue();
  if (!submission) {
    console.log('⏳ Queue empty, nothing to post');
    return;
  }

  try {
    console.log(`🌟 Spotlighting @${submission.author}`);

    let cleanText = stripTags(submission.text);

    const postUrl = convertAtUriToWebUrl(submission.uri, submission.author);

    const templateOverhead =
      '🌟 Spotlight: @'.length +
      submission.author.length +
      '\n\n'.length +
      '\n\n👉 '.length +
      (postUrl ? postUrl.length : 0) +
      '\n\n#IndieSpotlight'.length;

    const maxContent = Math.max(50, MAX_TEXT_LEN - templateOverhead);
    cleanText = clampText(cleanText, maxContent);

    const spotlightText =
      `🌟 Spotlight: @${submission.author}\n\n` +
      `${cleanText}\n\n` +
      (postUrl ? `👉 ${postUrl}\n\n` : '') +
      `#IndieSpotlight`;

    // Try with facets, fallback without facets (fixes DID facet issues)
    try {
      const rt = new RichText({ text: spotlightText });
      await rt.detectFacets(agent);
      await agent.post({ text: rt.text, facets: rt.facets });
    } catch (err) {
      console.warn('⚠️ Facet post failed, retrying without facets:', err.message);
      await agent.post({ text: spotlightText });
    }

    console.log(`✅ Posted spotlight for @${submission.author}`);

    // Push to your website
    if (postUrl) {
      await sendSpotlightToSite(
        {
          author: submission.author,
          author_did: submission.author_did,
          text: cleanText
        },
        postUrl
      );
    }

    await removeFromQueue(submission.id);

    if (submission.author_did) {
      await autoFollow(submission.author_did);
    }
  } catch (err) {
    console.error('Post error:', err.message);
  }
}

// ---------------- HEALTH ----------------

async function healthLog() {
  try {
    const stats = await getStats();
    console.log(`💓 Health: posted=${stats.posted} followed=${stats.followed} blocked=${stats.blocked} queued=${stats.queued}`);
  } catch (err) {
    console.error('Health error:', err.message);
  }
}

// ---------------- SHUTDOWN ----------------

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');

  try {
    await healthLog();
  } catch {}

  db.close(err => {
    if (err) console.error('DB close error:', err.message);
    process.exit(0);
  });
});

// ---------------- MAIN ----------------

async function main() {
  console.log('🚀 Starting Community Spotlight Bot...');

  await initDatabase();

  const loggedIn = await login();
  if (!loggedIn) {
    console.error('❌ Login failed. Exiting.');
    return;
  }

  await healthLog();

  console.log(`👀 Watching for #spotlight and #promote`);
  console.log(`⭐ Also monitoring @${SPOTLIGHT_USER}`);
  if (SITE_API_URL) console.log(`🌐 Website push enabled: ${SITE_API_URL}`);
  else console.log(`🌐 Website push disabled (set SPOTLIGHT_API_URL to enable)`);

  // Initial discovery burst
  await checkForSubmissions();
  await searchStartupPosts();
  await searchFollowingNetwork();

  // Post immediately if queue already has items
  const initialQueue = await getQueueSize();
  if (initialQueue > 0) {
    console.log(`📌 Initial queue has ${initialQueue} items — posting one now...`);
    await postSpotlight();
  }

  // Recurring work
  setInterval(checkForSubmissions, CHECK_INTERVAL);
  setInterval(searchStartupPosts, SEARCH_INTERVAL);
  setInterval(searchFollowingNetwork, NETWORK_INTERVAL);
  setInterval(postSpotlight, POST_INTERVAL);
  setInterval(followBack, FOLLOWBACK_INTERVAL);
  setInterval(healthLog, HEALTH_INTERVAL);

  console.log('✅ Bot is running');
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  db.close();
  process.exit(1);
});
