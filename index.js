require('dotenv').config();
const { BskyAgent, RichText } = require('@atproto/api');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

// Configuration
const SPOTLIGHT_USER = process.env.SPOTLIGHT_USER || 'yourhandle.bsky.social';
const POST_INTERVAL = 4 * 60 * 60 * 1000; // Post every 4 hours
const CHECK_INTERVAL = 10 * 60 * 1000; // Check for new submissions every 10 minutes

const agent = new BskyAgent({
  service: 'https://bsky.social'
});

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
  await dbRun(
    'INSERT OR IGNORE INTO posted_uris (uri, posted_at) VALUES (?, ?)',
    [uri, Date.now()]
  );
}

async function isFollowed(did) {
  const row = await dbGet('SELECT did FROM followed_dids WHERE did = ?', [did]);
  return !!row;
}

async function markAsFollowed(did) {
  await dbRun(
    'INSERT OR IGNORE INTO followed_dids (did, followed_at) VALUES (?, ?)',
    [did, Date.now()]
  );
}

async function addToQueue(submission) {
  try {
    await dbRun(
      'INSERT OR IGNORE INTO post_queue (author, author_did, text, uri, timestamp) VALUES (?, ?, ?, ?, ?)',
      [submission.author, submission.authorDid, submission.text, submission.uri, submission.timestamp]
    );
  } catch (err) {
    // Ignore duplicate key errors
    if (!err.message.includes('UNIQUE constraint')) {
      throw err;
    }
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
  
  return {
    posted: posted.count,
    followed: followed.count,
    queued: queued
  };
}

async function login() {
  try {
    await agent.login({
      identifier: process.env.BLUESKY_USERNAME,
      password: process.env.BLUESKY_PASSWORD
    });
    console.log("✅ Logged in as:", process.env.BLUESKY_USERNAME);
    return true;
  } catch (err) {
    console.error("❌ Login failed:", err.message);
    return false;
  }
}

async function autoFollow(did) {
  if (await isFollowed(did)) {
    return;
  }
  
  try {
    const profile = await agent.getProfile({ actor: did });
    
    if (profile.data.viewer?.following) {
      console.log("Already following", profile.data.handle);
      await markAsFollowed(did);
      return;
    }
    
    console.log("➕ Following user:", profile.data.handle);
    await agent.follow(did);
    await markAsFollowed(did);
    await sleep(2000);
  } catch (err) {
    console.error("Auto-follow error:", err.message);
  }
}

async function checkForSubmissions() {
  try {
    console.log("🔍 Checking for new community submissions...");
    
    // Get mentions to this bot account
    const notifications = await agent.listNotifications({ limit: 50 });
    
    for (const notif of notifications.data.notifications) {
      if (notif.reason !== 'mention' && notif.reason !== 'reply') continue;
      if (!notif.record?.text) continue;
      if (await isPosted(notif.uri)) continue;
      
      const text = notif.record.text;
      const authorDid = notif.author.did;
      const authorHandle = notif.author.handle;
      
      // Check if this is a submission (contains #spotlight or #promote tag)
      if (text.toLowerCase().includes('#spotlight') || 
          text.toLowerCase().includes('#promote')) {
        
        console.log("📬 New submission from @" + authorHandle);
        
        await addToQueue({
          author: authorHandle,
          authorDid: authorDid,
          text: text,
          uri: notif.uri,
          timestamp: Date.now()
        });
        
        await markAsPosted(notif.uri);
        
        // Follow the submitter
        await autoFollow(authorDid);
        
        // Like their submission post
        try {
          await agent.like(notif.uri, notif.cid);
          console.log("❤️ Liked submission from @" + authorHandle);
        } catch (err) {
          console.error("Like error:", err.message);
        }
      }
    }
    
    // Also check posts from designated spotlight user
    const spotlightPosts = await agent.getAuthorFeed({
      actor: SPOTLIGHT_USER,
      limit: 20
    });
    
    for (const feedItem of spotlightPosts.data.feed) {
      const post = feedItem.post;
      if (await isPosted(post.uri)) continue;
      
      const text = post.record?.text || '';
      if (text.toLowerCase().includes('#spotlight') || 
          text.toLowerCase().includes('#promote')) {
        
        console.log("📬 New spotlight post from designated user");
        
        await addToQueue({
          author: post.author.handle,
          authorDid: post.author.did,
          text: text,
          uri: post.uri,
          timestamp: Date.now()
        });
        
        await markAsPosted(post.uri);
        await autoFollow(post.author.did);
      }
    }
    
    const queueSize = await getQueueSize();
    console.log(`📊 Queue size: ${queueSize} posts`);
    
  } catch (err) {
    console.error("Submission check error:", err.message);
  }
}

async function postSpotlight() {
  console.log("⏰ Post spotlight timer triggered");
  
  const submission = await getNextFromQueue();
  
  if (!submission) {
    console.log("📭 No posts in queue to spotlight");
    return;
  }
  
  console.log(`📤 Processing spotlight (queue size: ${await getQueueSize()})`);
  
  try {
    console.log("🌟 Spotlighting community from @" + submission.author);
    
    // Extract relevant info (remove hashtags, clean up)
    let cleanText = submission.text
      .replace(/#spotlight/gi, '')
      .replace(/#promote/gi, '')
      .trim();
    
    // Truncate if too long (leave room for our template + hashtags)
    const maxContentLength = 200; // Reserve 100 chars for template/hashtags
    if (cleanText.length > maxContentLength) {
      cleanText = cleanText.substring(0, maxContentLength) + '...';
    }
    
    // Create spotlight post
    const spotlightText = `🌟 Spotlight: @${submission.author}

${cleanText}

#IndieSpotlight #SmallCommunities`;
    
    const rt = new RichText({ text: spotlightText });
    await rt.detectFacets(agent);
    
    await agent.post({
      text: rt.text,
      facets: rt.facets
    });
    
    console.log("✅ Posted spotlight for @" + submission.author);
    
    // Remove from queue
    await removeFromQueue(submission.id);
    
    // Follow them if we haven't already
    await autoFollow(submission.author_did);
    
  } catch (err) {
    console.error("Post error:", err.message);
    // Leave it in queue to retry later
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('SIGINT', async () => {
  console.log("\n👋 Shutting down bot gracefully...");
  
  const stats = await getStats();
  console.log("📊 Final stats:");
  console.log("   Posts spotlighted:", stats.posted);
  console.log("   Users followed:", stats.followed);
  console.log("   Queue remaining:", stats.queued);
  
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err);
    } else {
      console.log('✅ Database closed');
    }
    process.exit(0);
  });
});

async function main() {
  console.log("🚀 Community Spotlight Bot Starting...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  
  // Initialize database
  await initDatabase();
  
  const loggedIn = await login();
  if (!loggedIn) {
    console.error("Failed to login. Exiting.");
    return;
  }
  
  // Show current stats
  const stats = await getStats();
  console.log(`📊 Current state: ${stats.posted} posted, ${stats.followed} followed, ${stats.queued} queued`);
  
  console.log("📢 Ready to spotlight small communities!");
  console.log("💡 Mention this bot with #spotlight or #promote to submit");
  console.log(`📬 Also watching @${SPOTLIGHT_USER} for submissions`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  
  // Initial check
  await checkForSubmissions();
  
  // Post immediately if we have items in queue
  if (await getQueueSize() > 0) {
    console.log("🎯 Queue has items, posting first spotlight now...");
    await postSpotlight();
  }
  
  // Check for new submissions regularly
  setInterval(checkForSubmissions, CHECK_INTERVAL);
  
  // Post spotlights on interval
  setInterval(postSpotlight, POST_INTERVAL);
}

main().catch(err => {
  console.error("💥 Fatal error:", err);
  db.close();
  process.exit(1);
});
