require('dotenv').config();
const { BskyAgent, RichText } = require('@atproto/api');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

// Configuration
const SPOTLIGHT_USER = process.env.SPOTLIGHT_USER || 'yourhandle.bsky.social';
const POST_INTERVAL = 10 * 60 * 1000; // Post every 10 minutes
const CHECK_INTERVAL = 15 * 60 * 1000;     // Check for new submissions every 15 minutes
const SEARCH_INTERVAL = 15 * 60 * 1000;    // Search Bluesky every 15 minutes
const NETWORK_INTERVAL = 30 * 60 * 1000;   // Search following network every 30 minutes
const FOLLOWBACK_INTERVAL = 10 * 60 * 1000 // Follow back every 10 minutes

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

  await dbRun(`
    CREATE TABLE IF NOT EXISTS blocklist (
      did TEXT PRIMARY KEY,
      handle TEXT,
      reason TEXT,
      added_at INTEGER
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

async function isBlocked(did) {
  const row = await dbGet('SELECT did FROM blocklist WHERE did = ?', [did]);
  return !!row;
}

async function addToBlocklist(did, handle, reason = 'user request') {
  await dbRun(
    'INSERT OR IGNORE INTO blocklist (did, handle, reason, added_at) VALUES (?, ?, ?, ?)',
    [did, handle, reason, Date.now()]
  );
  console.log(`🚫 Added @${handle} to blocklist (${reason})`);
}

async function removeFromBlocklist(did) {
  await dbRun('DELETE FROM blocklist WHERE did = ?', [did]);
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
  const blocked = await dbGet('SELECT COUNT(*) as count FROM blocklist');
  const queued = await getQueueSize();
  return { posted: posted.count, followed: followed.count, blocked: blocked.count, queued };
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

// Expanded keyword detection
const PROMO_KEYWORDS = [
  'launched', 'built this', 'made this', 'working on', 'side project',
  'feedback welcome', 'check out my', 'just shipped', 'new project',
  'my app', 'my game', 'my product', 'my startup'
];

const COMMUNITY_KEYWORDS = [
  '#spotlight', '#promote', '#buildinpublic', '#indiehackers', 
  '#indiedev', '#solopreneur', '#maker'
];

// Spam patterns to reject - EXPANDED
const SPAM_PATTERNS = [
  // Shopping spam
  'cupom', 'precinho', 'amazon', 'iphone', 'playstation', 'nintendo',
  'preço', 'oferta', 'desconto', 'compre', 'deal', 'sale',
  'lumens', 'flashlight', 'rechargeable', 'pack -', 'camera -',
  'wireless security', 'night vision', 'arlo', 'olight',
  
  // News/Sports
  'breaking:', 'breaking news', 'cbs', 'nbc', 'nba', 'nfl', 'sports',
  'Bulls', 'Lakers', 'game highlights', 'score', 'final score',
  'news:', 'report:', 'mayor', 'election', 'politics',
  'watch:', 'video:', 'stream:', 'live now', 'tune in',
  
  // Hardware/Physical products
  'laser', 'filament', '3d print', 'cutting', 'engraving',
  
  // Academic
  'journal', 'research paper', 'academic', 'university', 'optica.org',
  'summary by', 'spotlight summary', 'spotlightsunday'
];

// Context words that indicate it's NOT indie dev content
const BAD_CONTEXT = [
  'buy now', 'order', 'purchase', 'shipping', 'delivery',
  'lumens', 'battery', 'waterproof', 'durable', 'warranty',
  'research', 'study', 'paper', 'journal', 'academic'
];

function looksLikePromo(text) {
  const lower = (text || '').toLowerCase();
  
  // REJECT spam/news FIRST
  if (SPAM_PATTERNS.some(spam => lower.includes(spam))) {
    return false;
  }
  
  // REJECT if it has bad context (shopping/academic language)
  if (BAD_CONTEXT.some(bad => lower.includes(bad))) {
    return false;
  }
  
  // REJECT if it's just a link with no context
  const linkCount = (lower.match(/https?:\/\//g) || []).length;
  if (linkCount > 2) {
    return false; // Multiple links = spam
  }
  
  // If text is too short (< 20 chars), reject unless it has #promote
  if (text.length < 20 && !lower.includes('#promote')) {
    return false;
  }
  
  // STRONG SIGNAL: Has #promote hashtag (more specific than #spotlight)
  if (lower.includes('#promote')) {
    return true;
  }
  
  // MEDIUM SIGNAL: Has #spotlight AND indie dev context
  if (lower.includes('#spotlight')) {
    const hasDevContext = [
      'built', 'made', 'working on', 'project', 'app', 'game', 
      'website', 'startup', 'launch', 'feedback', 'beta'
    ].some(word => lower.includes(word));
    
    if (hasDevContext) {
      return true;
    }
  }
  
  // MEDIUM SIGNAL: Has #buildinpublic or #indiehackers
  if (lower.includes('#buildinpublic') || lower.includes('#indiehackers') || 
      lower.includes('#indiedev') || lower.includes('#solopreneur')) {
    return true;
  }
  
  // WEAK SIGNAL: Must have BOTH a link AND multiple strong keywords
  const hasLink = lower.includes('http://') || lower.includes('https://');
  const keywordMatches = PROMO_KEYWORDS.filter(word => lower.includes(word));
  
  // Need at least 2 keywords + link to qualify
  if (hasLink && keywordMatches.length >= 2) {
    return true;
  }
  
  return false;
}

async function addPostIfRelevant(post, sourceLabel = 'search') {
  const uri = post?.uri;
  if (!uri) {
    return;
  }
  
  if (await isPosted(uri)) {
    return;
  }

  const text = post?.record?.text || post?.text || '';
  if (!text) {
    return;
  }

  const authorHandle = post?.author?.handle || 'unknown';
  const authorDid = post?.author?.did || 'unknown';
  
  // Check blocklist FIRST
  if (await isBlocked(authorDid)) {
    console.log(`   🚫 Skipped: @${authorHandle} is blocked`);
    return;
  }
  
  // Skip your own posts
  const ownHandle = process.env.BLUESKY_USERNAME.replace('.bsky.social', '');
  if (authorHandle === ownHandle || authorHandle.includes(ownHandle)) {
    console.log(`   ⏭️ Skipped own post from @${authorHandle}`);
    return;
  }

  const matches = looksLikePromo(text);
  
  if (matches) {
    console.log(`   ✅ [${sourceLabel}] Queuing post from @${authorHandle}`);
    console.log(`      Preview: ${text.substring(0, 100)}...`);
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
    console.log('🔍 Searching Bluesky for community posts...');
    
    // ONLY search for explicit promotion hashtags
    const focusedSearchTerms = [
      '#spotlight', '#promote', '#buildinpublic', '#indiehackers',
      '#indiedev', '#solopreneur'
    ];
    
    for (const keyword of focusedSearchTerms) {
      try {
        const resp = await agent.app.bsky.feed.searchPosts({ 
          q: keyword, 
          limit: 15 // Reduced from 25 to get less noise
        });
        const posts = resp?.data?.posts || [];
        console.log(`   Found ${posts.length} posts for "${keyword}"`);
        
        for (const post of posts) {
          await addPostIfRelevant(post, `search:${keyword}`);
        }
        await sleep(1500); // Slower to be more careful
      } catch (err) {
        console.error(`   Search failed for "${keyword}":`, err.message);
      }
    }
    
    const queueSize = await getQueueSize();
    console.log(`📊 Search complete. Queue size: ${queueSize}`);
    
    if (queueSize === 0) {
      console.log('⚠️ Queue is empty after search - may need to adjust keywords');
    }
  } catch (err) {
    console.error('Search error:', err.message);
  }
}

async function searchFollowingNetwork() {
  try {
    console.log('👥 Checking posts from following network...');
    
    const following = await agent.getFollows({
      actor: process.env.BLUESKY_USERNAME,
      limit: 50
    });
    
    let checkedCount = 0;
    for (const user of following.data.follows) {
      try {
        const feed = await agent.getAuthorFeed({ 
          actor: user.did, 
          limit: 5 // Reduced from 10 to check less per user
        });
        
        for (const feedItem of feed.data.feed) {
          await addPostIfRelevant(feedItem.post, `following:${user.handle}`);
        }
        checkedCount++;
        await sleep(500);
      } catch (err) {
        console.error(`   Error checking @${user.handle}:`, err.message);
      }
    }
    
    console.log(`📊 Network search complete (checked ${checkedCount} users). Queue: ${await getQueueSize()}`);
  } catch (err) {
    console.error('Network search error:', err.message);
  }
}

async function checkForSubmissions() {
  try {
    console.log('🔎 Checking mentions/replies + spotlight feed...');
    
    // Mentions and replies
    const notifications = await agent.listNotifications({ limit: 50 });
    let foundCount = 0;
    
    for (const notif of notifications.data.notifications) {
      const isRelevantReason = notif.reason === 'mention' || notif.reason === 'reply';
      if (!isRelevantReason) continue;
      if (!notif.record?.text) continue;

      const text = notif.record.text;
      const authorDid = notif.author.did;
      const authorHandle = notif.author.handle;

      // Check for opt-out requests
      const lowerText = text.toLowerCase();
      if (lowerText.includes('stop') || lowerText.includes('unfollow') || 
          lowerText.includes('dont follow') || lowerText.includes("don't follow") ||
          lowerText.includes('opt out') || lowerText.includes('remove me') ||
          lowerText.includes('no bot') || lowerText.includes('unsubscribe')) {
        
        await addToBlocklist(authorDid, authorHandle, 'user request via mention');
        
        // Unfollow them if we're following
        try {
          const profile = await agent.getProfile({ actor: authorDid });
          if (profile.data.viewer?.following) {
            await agent.deleteFollow(profile.data.viewer.following);
            console.log(`👋 Unfollowed @${authorHandle} per their request`);
          }
        } catch (err) {
          console.error('Unfollow error:', err.message);
        }
        
        // Reply to confirm
        try {
          await agent.post({
            text: `@${authorHandle} Got it! I've removed you from my spotlight list and won't feature your content. Sorry for any inconvenience! 👍`,
            reply: {
              root: { uri: notif.uri, cid: notif.cid },
              parent: { uri: notif.uri, cid: notif.cid }
            }
          });
          console.log(`✅ Replied to @${authorHandle} confirming opt-out`);
        } catch (err) {
          console.error('Reply error:', err.message);
        }
        
        continue;
      }

      if (await isPosted(notif.uri)) continue;

      // Check if they're blocked
      if (await isBlocked(authorDid)) {
        console.log(`   🚫 Skipped mention from blocked user @${authorHandle}`);
        continue;
      }

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
        foundCount++;
        
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

    console.log(`📊 Found ${foundCount} new submissions. Queue size: ${await getQueueSize()} posts`);
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
    const maxContentLength = 200;
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
    console.log('   Users blocked:', stats.blocked);
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
  console.log(`📊 Current state: ${stats.posted} posted, ${stats.followed} followed, ${stats.blocked} blocked, ${stats.queued} queued`);
  console.log('📢 Ready to spotlight small communities!');
  console.log('💡 Mention this bot with #spotlight or #promote to submit');
  console.log(`📬 Also watching @${SPOTLIGHT_USER} for submissions`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Initial discovery runs
  console.log('🎯 Running initial discovery...');
  await checkForSubmissions();
  await searchStartupPosts();
  await searchFollowingNetwork();

  // If queue has items, post one immediately
  const initialQueue = await getQueueSize();
  if (initialQueue > 0) {
    console.log(`🎯 Queue has ${initialQueue} items, posting first spotlight now...`);
    await postSpotlight();
  } else {
    console.log('⚠️ Queue is empty after initial discovery - will retry on intervals');
  }

  // Regular intervals
  setInterval(checkForSubmissions, CHECK_INTERVAL);
  setInterval(searchStartupPosts, SEARCH_INTERVAL);
  setInterval(searchFollowingNetwork, NETWORK_INTERVAL);
  setInterval(postSpotlight, POST_INTERVAL);
  setInterval(followBack, FOLLOWBACK_INTERVAL);
  
  console.log('✅ All intervals scheduled. Bot is now running!');
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  db.close();
  process.exit(1);
});
