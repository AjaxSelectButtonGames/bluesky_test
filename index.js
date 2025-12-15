require('dotenv').config();
const { BskyAgent, RichText } = require('@atproto/api');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

// Configuration
const SPOTLIGHT_USER = process.env.SPOTLIGHT_USER || 'yourhandle.bsky.social';
const POST_INTERVAL = 4 * 60 * 60 * 1000; // Post every 4 hours
const CHECK_INTERVAL = 10 * 60 * 1000;     // Check for new submissions every 10 minutes
const SEARCH_INTERVAL = 20 * 60 * 1000;    // Search Bluesky every 20 minutes
const FOLLOWBACK_INTERVAL = 12 * 60 * 60 * 1000; // Follow back every 12 hours

const agent = new BskyAgent({ service: 'https://bsky.social' });

// Initialize SQLite database
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

  console.log('📂 Database initialized');
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

async function addToQueue(submission) {
  try {
    await dbRun(
      'INSERT OR IGNORE INTO post_queue (author, author_did, text, uri, timestamp) VALUES (?, ?, ?, ?, ?)',
      [submission.author, submission.authorDid, submission.text, submission.uri, submission.timestamp]
    );
  } catch (err) {
    if (!String(err.message).includes('UNIQUE constraint')) throw err;
  }
}

async function getNextFromQueue() {
  const row = await dbGet('SELECT * FROM post_queue ORDER BY timestamp ASC LIMIT 1');
  return row;
}

async function removeFromQueue(id) {
  await dbRun('DELETE FROM post_queue WHERE id = ?', [id]);
}

async function getQueueSize() {
  const row = await dbGet('SELECT COUNT(*) as count FROM post_queue');
  return row.count;
}

async function getStats() {
  const posted = await dbGet('SELECT COUNT(*) as count FROM posted_uris');
  const followed = await dbGet('SELECT COUNT(*) as count FROM followed_dids');
  const queued = await getQueueSize();
  return { posted: posted.count, followed: followed.count, queued };
}

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
    await sleep(1500);
  } catch (err) {
    console.error('Auto-follow error:', err.message);
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
        console.log('🔄 Following back:', f.handle);
        await autoFollow(f.did);
      }
    }
  } catch (err) {
    console.error('Follow-back error:', err.message);
  }
}

// Keyword detection (promo-oriented + link presence)
const PROMO_KEYWORDS = [
  'startup', 'launch', 'beta', 'demo', 'project', 'app', 'game',
  'founder', 'product', 'prototype', 'mvp', 'update', 'release'
];

function looksLikePromo(text) {
  const lower = (text || '').toLowerCase();
  const hasLink = lower.includes('http://') || lower.includes('https://');
  const hasKeyword = PROMO_KEYWORDS.some(word => lower.includes(word));
  return hasKeyword || hasLink;
}

async function addPostIfRelevant(post, sourceLabel = 'search') {
  const uri = post?.uri;
  if (!uri) return;
  if (await isPosted(uri)) return;

  const text = post?.record?.text || post?.text || '';
  if (!text) return;

  if (
    text.toLowerCase().includes('#spotlight') ||
    text.toLowerCase().includes('#promote') ||
    looksLikePromo(text)
  ) {
    const authorHandle = post?.author?.handle || 'unknown';
    const authorDid = post?.author?.did || 'unknown';
    console.log(`📬 [${sourceLabel}] Queuing post from @${authorHandle}`);
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
    console.log('🔍 Searching Bluesky for startup posts...');
    for (const keyword of PROMO_KEYWORDS) {
      // Correct search endpoint via agent namespace
      const resp = await agent.app.bsky.feed.searchPosts({ q: keyword, limit: 25 });
      const posts = resp?.data?.posts || [];
      for (const post of posts) {
        await addPostIfRelevant(post, `search:${keyword}`);
      }
      await sleep(500); // small delay to be polite
    }
    console.log(`📊 Search complete. Queue size: ${await getQueueSize()}`);
  } catch (err) {
    console.error('Search error:', err.message);
  }
}

async function checkForSubmissions() {
  try {
    console.log('🔎 Checking mentions/replies + spotlight feed...');
    // Mentions and replies
    const notifications = await agent.listNotifications({ limit: 50 });
    for (const notif of notifications.data.notifications) {
      const isRelevantReason = notif.reason === 'mention' || notif.reason === 'reply';
      if (!isRelevantReason) continue;
      if (!notif.record?.text) continue;

      // Avoid reprocessing the same URI
      if (await isPosted(notif.uri)) continue;

      const text = notif.record.text;
      const authorDid = notif.author.did;
      const authorHandle = notif.author.handle;

      if (
        text.toLowerCase().includes('#spotlight') ||
        text.toLowerCase().includes('#promote') ||
        looksLikePromo(text)
      ) {
        console.log('📬 New submission from @' + authorHandle);
        await addToQueue({
          author: authorHandle,
          authorDid,
          text,
          uri: notif.uri,
          timestamp: Date.now()
        });
        await markAsPosted(notif.uri);
        await autoFollow(authorDid);
        try {
          await agent.like(notif.uri, notif.cid);
          console.log('❤️ Liked submission from @' + authorHandle);
        } catch (err) {
          console.error('Like error:', err.message);
        }
      }
    }

    // Spotlight user feed
    const spotlightFeed = await agent.getAuthorFeed({ actor: SPOTLIGHT_USER, limit: 30 });
    for (const feedItem of spotlightFeed.data.feed) {
      const post = feedItem.post;
      if (!post) continue;
      await addPostIfRelevant(post, 'spotlightUser');
    }

    console.log(`📊 Queue size: ${await getQueueSize()} posts`);
  } catch (err) {
    console.error('Submission check error:', err.message);
  }
}

async function postSpotlight() {
  console.log('⏰ Post spotlight timer triggered');

  const submission = await getNextFromQueue();
  if (!submission) {
    console.log('📭 No posts in queue to spotlight');
    return;
  }

  try {
    console.log('🌟 Spotlighting community from @' + submission.author);

    // Clean up text (remove hashtags)
    let cleanText = (submission.text || '')
      .replace(/#spotlight/gi, '')
      .replace(/#promote/gi, '')
      .trim();

    // Truncate to fit template
    const maxContentLength = 200; // reserve room for template + hashtags
    if (cleanText.length > maxContentLength) {
      cleanText = cleanText.substring(0, maxContentLength) + '...';
    }

    const spotlightText =
      `🌟 Spotlight: @${submission.author}\n\n` +
      `${cleanText}\n\n` +
      `#IndieSpotlight #SmallCommunities`;

    const rt = new RichText({ text: spotlightText });
    await rt.detectFacets(agent);

    await agent.post({ text: rt.text, facets: rt.facets });

    console.log('✅ Posted spotlight for @' + submission.author);

    // Remove from queue and ensure we follow the author
    await removeFromQueue(submission.id);
    if (submission.author_did) {
      await autoFollow(submission.author_did);
    }
  } catch (err) {
    console.error('Post error:', err.message);
    // Leave in queue for retry later
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down bot gracefully...');
  try {
    const stats = await getStats();
    console.log('📊 Final stats:');
    console.log('   Posts spotlighted:', stats.posted);
    console.log('   Users followed:', stats.followed);
    console.log('   Queue remaining:', stats.queued);
  } catch (e) {
    console.error('Error fetching final stats:', e?.message || e);
  }

  db.close(err => {
    if (err) {
      console.error('Error closing database:', err);
    } else {
      console.log('✅ Database closed');
    }
    process.exit(0);
  });
});

async function main() {
  console.log('🚀 Community Spotlight Bot Starting...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await initDatabase();

  const loggedIn = await login();
  if (!loggedIn) {
    console.error('Failed to login. Exiting.');
    return;
  }

  const stats = await getStats();
  console.log(`📊 Current state: ${stats.posted} posted, ${stats.followed} followed, ${stats.queued} queued`);
  console.log('📢 Ready to spotlight small communities!');
  console.log('💡 Mention this bot with #spotlight or #promote to submit');
  console.log(`📬 Also watching @${SPOTLIGHT_USER} for submissions`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Initial discovery runs
  await checkForSubmissions();
  await searchStartupPosts();

  // If queue has items, post one immediately
  if (await getQueueSize() > 0) {
    console.log('🎯 Queue has items, posting first spotlight now...');
    await postSpotlight();
  }

  // Regular intervals
  setInterval(checkForSubmissions, CHECK_INTERVAL);
  setInterval(searchStartupPosts, SEARCH_INTERVAL);
  setInterval(postSpotlight, POST_INTERVAL);
  setInterval(followBack, FOLLOWBACK_INTERVAL);
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  db.close();
  process.exit(1);
});
