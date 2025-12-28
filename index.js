require('dotenv').config();
const { BskyAgent, RichText } = require('@atproto/api');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

const SPOTLIGHT_USER = process.env.SPOTLIGHT_USER || 'yourhandle.bsky.social';
const POST_INTERVAL = 10 * 60 * 1000;
const CHECK_INTERVAL = 15 * 60 * 1000;
const SEARCH_INTERVAL = 15 * 60 * 1000;
const NETWORK_INTERVAL = 30 * 60 * 1000;
const FOLLOWBACK_INTERVAL = 10 * 60 * 1000;

const agent = new BskyAgent({ service: 'https://bsky.social' });

const db = new sqlite3.Database('bot-state.db');
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

function convertAtUriToWebUrl(uri, authorHandle) {
  try {
    const parts = uri.split('/');
    const postId = parts[parts.length - 1];
    return `https://bsky.app/profile/${authorHandle}/post/${postId}`;
  } catch (err) {
    console.error('Error converting URI:', err.message);
    return null;
  }
}

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
  
  console.log('Database initialized');
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
  console.log(`Blocked @${handle} (${reason})`);
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
  return await dbGet('SELECT * FROM post_queue ORDER BY timestamp ASC LIMIT 1');
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
    console.log('Logged in as:', process.env.BLUESKY_USERNAME);
    return true;
  } catch (err) {
    console.error('Login failed:', err.message);
    return false;
  }
}

async function autoFollow(did) {
  if (!did || await isFollowed(did)) return;
  
  try {
    const profile = await agent.getProfile({ actor: did });
    if (profile.data.viewer?.following) {
      await markAsFollowed(did);
      return;
    }
    
    console.log('Following:', profile.data.handle);
    await agent.follow(did);
    await markAsFollowed(did);
    await sleep(1500);
  } catch (err) {
    console.error('Follow error:', err.message);
  }
}

async function followBack() {
  try {
    console.log('Checking for new followers...');
    const followers = await agent.getFollowers({
      actor: process.env.BLUESKY_USERNAME,
      limit: 100
    });
    
    for (const f of followers.data.followers) {
      if (!(await isFollowed(f.did))) {
        console.log('Following back:', f.handle);
        await autoFollow(f.did);
      }
    }
  } catch (err) {
    console.error('Followback error:', err.message);
  }
}

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
  
  // Filter out spam and shopping posts
  if (SPAM_PATTERNS.some(spam => lower.includes(spam))) return false;
  if (BAD_CONTEXT.some(bad => lower.includes(bad))) return false;
  
  const linkCount = (lower.match(/https?:\/\//g) || []).length;
  if (linkCount > 2) return false;
  if (text.length < 20 && !lower.includes('#promote')) return false;
  
  // Check for explicit promotion tags
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
  
  // Require both link and multiple keywords for generic posts
  const hasLink = lower.includes('http://') || lower.includes('https://');
  const keywordMatches = PROMO_KEYWORDS.filter(word => lower.includes(word));
  
  return hasLink && keywordMatches.length >= 2;
}

async function addPostIfRelevant(post, sourceLabel = 'search') {
  const uri = post?.uri;
  if (!uri || await isPosted(uri)) return;
  
  const text = post?.record?.text || post?.text || '';
  if (!text) return;
  
  const authorHandle = post?.author?.handle || 'unknown';
  const authorDid = post?.author?.did || 'unknown';
  
  if (await isBlocked(authorDid)) {
    console.log(`Skipped blocked user: @${authorHandle}`);
    return;
  }
  
  const ownHandle = process.env.BLUESKY_USERNAME.replace('.bsky.social', '');
  if (authorHandle === ownHandle || authorHandle.includes(ownHandle)) {
    return;
  }
  
  if (looksLikePromo(text)) {
    console.log(`[${sourceLabel}] Queuing post from @${authorHandle}`);
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
    console.log('Searching for community posts...');
    
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
        console.log(`Found ${posts.length} posts for "${keyword}"`);
        
        for (const post of posts) {
          await addPostIfRelevant(post, `search:${keyword}`);
        }
        
        await sleep(1500);
      } catch (err) {
        console.error(`Search failed for "${keyword}":`, err.message);
      }
    }
    
    const queueSize = await getQueueSize();
    console.log(`Search complete. Queue: ${queueSize}`);
  } catch (err) {
    console.error('Search error:', err.message);
  }
}

async function searchFollowingNetwork() {
  try {
    console.log('Checking following network...');
    
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
          await addPostIfRelevant(feedItem.post, `following:${user.handle}`);
        }
        
        checkedCount++;
        await sleep(500);
      } catch (err) {
        console.error(`Error checking @${user.handle}:`, err.message);
      }
    }
    
    console.log(`Checked ${checkedCount} users. Queue: ${await getQueueSize()}`);
  } catch (err) {
    console.error('Network search error:', err.message);
  }
}

async function checkForSubmissions() {
  try {
    console.log('Checking mentions and replies...');
    
    const notifications = await agent.listNotifications({ limit: 50 });
    let foundCount = 0;
    
    for (const notif of notifications.data.notifications) {
      const isRelevant = notif.reason === 'mention' || notif.reason === 'reply';
      if (!isRelevant || !notif.record?.text) continue;
      
      const text = notif.record.text;
      const authorDid = notif.author.did;
      const authorHandle = notif.author.handle;
      const lowerText = text.toLowerCase();
      
      // Handle opt-out requests
      if (lowerText.includes('stop') || lowerText.includes('unfollow') || 
          lowerText.includes('dont follow') || lowerText.includes("don't follow") ||
          lowerText.includes('opt out') || lowerText.includes('remove me') ||
          lowerText.includes('no bot') || lowerText.includes('unsubscribe')) {
        
        await addToBlocklist(authorDid, authorHandle, 'user request');
        
        try {
          const profile = await agent.getProfile({ actor: authorDid });
          if (profile.data.viewer?.following) {
            await agent.deleteFollow(profile.data.viewer.following);
            console.log(`Unfollowed @${authorHandle} per request`);
          }
        } catch (err) {
          console.error('Unfollow error:', err.message);
        }
        
        try {
          await agent.post({
            text: `@${authorHandle} Got it! I've removed you from my spotlight list. Sorry for the inconvenience!`,
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
      if (await isBlocked(authorDid)) {
        console.log(`Skipped mention from blocked user @${authorHandle}`);
        continue;
      }
      
      if (lowerText.includes('#spotlight') || lowerText.includes('#promote') || looksLikePromo(text)) {
        console.log('New submission from @' + authorHandle);
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
    
    // Check spotlight user's feed
    const spotlightFeed = await agent.getAuthorFeed({
      actor: SPOTLIGHT_USER,
      limit: 30
    });
    
    for (const feedItem of spotlightFeed.data.feed) {
      if (feedItem.post) {
        await addPostIfRelevant(feedItem.post, 'spotlightUser');
      }
    }
    
    console.log(`Found ${foundCount} new submissions. Queue: ${await getQueueSize()}`);
  } catch (err) {
    console.error('Submission check error:', err.message);
  }
}

async function postSpotlight() {
  const submission = await getNextFromQueue();
  if (!submission) {
    console.log('Queue empty, nothing to post');
    return;
  }
  
  try {
    console.log('Spotlighting @' + submission.author);
    
    // Clean up hashtags
    let cleanText = (submission.text || '')
      .replace(/#spotlight/gi, '')
      .replace(/#promote/gi, '')
      .replace(/#buildinpublic/gi, '')
      .replace(/#indiehackers/gi, '')
      .replace(/#indiedev/gi, '')
      .replace(/#solopreneur/gi, '')
      .trim();
    
    const postUrl = convertAtUriToWebUrl(submission.uri, submission.author);
    
    // Calculate max length for content
    const templateLength = '🌟 Spotlight: @'.length + 
                          submission.author.length + 
                          '\n\n'.length + 
                          '\n\n👉 '.length + 
                          (postUrl ? postUrl.length : 0) + 
                          '\n\n#IndieSpotlight'.length;
    
    const maxContentLength = 290 - templateLength;
    
    if (cleanText.length > maxContentLength) {
      cleanText = cleanText.substring(0, maxContentLength - 3) + '...';
    }
    
    const spotlightText = `🌟 Spotlight: @${submission.author}\n\n` +
                         `${cleanText}\n\n` +
                         (postUrl ? `👉 ${postUrl}\n\n` : '') +
                         `#IndieSpotlight`;
    
    const rt = new RichText({ text: spotlightText });
    await rt.detectFacets(agent);
    await agent.post({
      text: rt.text,
      facets: rt.facets
    });
    
    console.log('Posted spotlight for @' + submission.author);
    
    await removeFromQueue(submission.id);
    if (submission.author_did) {
      await autoFollow(submission.author_did);
    }
  } catch (err) {
    console.error('Post error:', err.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  
  try {
    const stats = await getStats();
    console.log('Final stats:');
    console.log('  Posts:', stats.posted);
    console.log('  Followed:', stats.followed);
    console.log('  Blocked:', stats.blocked);
    console.log('  Queued:', stats.queued);
  } catch (e) {
    console.error('Error fetching stats:', e?.message || e);
  }
  
  db.close(err => {
    if (err) console.error('Error closing database:', err);
    process.exit(0);
  });
});

async function main() {
  console.log('Starting Community Spotlight Bot...');
  
  await initDatabase();
  
  const loggedIn = await login();
  if (!loggedIn) {
    console.error('Login failed. Exiting.');
    return;
  }
  
  const stats = await getStats();
  console.log(`Stats: ${stats.posted} posted, ${stats.followed} followed, ${stats.blocked} blocked, ${stats.queued} queued`);
  console.log('Watching for #spotlight and #promote tags');
  console.log(`Also monitoring @${SPOTLIGHT_USER}`);
  
  // Initial discovery
  await checkForSubmissions();
  await searchStartupPosts();
  await searchFollowingNetwork();
  
  const initialQueue = await getQueueSize();
  if (initialQueue > 0) {
    console.log(`Queue has ${initialQueue} items, posting first one now...`);
    await postSpotlight();
  }
  
  // Set up intervals
  setInterval(checkForSubmissions, CHECK_INTERVAL);
  setInterval(searchStartupPosts, SEARCH_INTERVAL);
  setInterval(searchFollowingNetwork, NETWORK_INTERVAL);
  setInterval(postSpotlight, POST_INTERVAL);
  setInterval(followBack, FOLLOWBACK_INTERVAL);
  
  console.log('Bot is running');
}

main().catch(err => {
  console.error('Fatal error:', err);
  db.close();
  process.exit(1);
});
