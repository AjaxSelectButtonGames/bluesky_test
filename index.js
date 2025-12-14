require('dotenv').config();
const { BskyAgent, RichText } = require('@atproto/api');

// Configuration
const SPOTLIGHT_USER = process.env.SPOTLIGHT_USER || 'yourhandle.bsky.social';
const POST_INTERVAL = 4 * 60 * 60 * 1000; // Post every 4 hours
const CHECK_INTERVAL = 10 * 60 * 1000; // Check for new submissions every 10 minutes

const FOLLOWED_DIDS = new Set();
const POSTED_URIS = new Set();
let postQueue = [];

const agent = new BskyAgent({
  service: 'https://bsky.social'
});

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
  if (FOLLOWED_DIDS.has(did)) return;
  
  try {
    const profile = await agent.getProfile({ actor: did });
    
    if (profile.data.viewer?.following) {
      console.log("Already following", profile.data.handle);
      FOLLOWED_DIDS.add(did);
      return;
    }
    
    console.log("➕ Following user:", profile.data.handle);
    await agent.follow(did);
    FOLLOWED_DIDS.add(did);
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
      if (POSTED_URIS.has(notif.uri)) continue;
      
      const text = notif.record.text;
      const authorDid = notif.author.did;
      const authorHandle = notif.author.handle;
      
      // Check if this is a submission (contains #spotlight or #promote tag)
      if (text.toLowerCase().includes('#spotlight') || 
          text.toLowerCase().includes('#promote')) {
        
        console.log("📬 New submission from @" + authorHandle);
        
        postQueue.push({
          author: authorHandle,
          authorDid: authorDid,
          text: text,
          uri: notif.uri,
          timestamp: Date.now()
        });
        
        POSTED_URIS.add(notif.uri);
        
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
      if (POSTED_URIS.has(post.uri)) continue;
      
      const text = post.record?.text || '';
      if (text.toLowerCase().includes('#spotlight') || 
          text.toLowerCase().includes('#promote')) {
        
        console.log("📬 New spotlight post from designated user");
        
        postQueue.push({
          author: post.author.handle,
          authorDid: post.author.did,
          text: text,
          uri: post.uri,
          timestamp: Date.now()
        });
        
        POSTED_URIS.add(post.uri);
        await autoFollow(post.author.did);
      }
    }
    
    console.log(`📊 Queue size: ${postQueue.length} posts`);
    
  } catch (err) {
    console.error("Submission check error:", err.message);
  }
}

async function postSpotlight() {
  if (postQueue.length === 0) {
    console.log("📭 No posts in queue to spotlight");
    return;
  }
  
  // Get the oldest post from queue
  const submission = postQueue.shift();
  
  try {
    console.log("🌟 Spotlighting community from @" + submission.author);
    
    // Extract relevant info (remove hashtags, clean up)
    let cleanText = submission.text
      .replace(/#spotlight/gi, '')
      .replace(/#promote/gi, '')
      .trim();
    
    // Create spotlight post
    const spotlightText = `🌟 Community Spotlight 🌟

Featuring: @${submission.author}

${cleanText}

#IndieSpotlight #CommunityLove #SmallCommunities`;
    
    const rt = new RichText({ text: spotlightText });
    await rt.detectFacets(agent);
    
    await agent.post({
      text: rt.text,
      facets: rt.facets
    });
    
    console.log("✅ Posted spotlight for @" + submission.author);
    
    // Follow them if we haven't already
    await autoFollow(submission.authorDid);
    
  } catch (err) {
    console.error("Post error:", err.message);
    // Put it back in queue if it failed
    postQueue.unshift(submission);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('SIGINT', () => {
  console.log("\n👋 Shutting down bot gracefully...");
  console.log("📊 Session stats:");
  console.log("   Posts spotlighted:", POSTED_URIS.size);
  console.log("   New follows:", FOLLOWED_DIDS.size);
  console.log("   Queue remaining:", postQueue.length);
  process.exit(0);
});

async function main() {
  console.log("🚀 Community Spotlight Bot Starting...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  
  const loggedIn = await login();
  if (!loggedIn) {
    console.error("Failed to login. Exiting.");
    return;
  }
  
  console.log("📢 Ready to spotlight small communities!");
  console.log("💡 Mention this bot with #spotlight or #promote to submit");
  console.log(`📬 Also watching @${SPOTLIGHT_USER} for submissions`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  
  // Initial check
  await checkForSubmissions();
  
  // Check for new submissions regularly
  setInterval(checkForSubmissions, CHECK_INTERVAL);
  
  // Post spotlights on interval
  setInterval(postSpotlight, POST_INTERVAL);
  
  // Also post one shortly after startup if queue has items
  setTimeout(postSpotlight, 30 * 1000);
}

main().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
