require('dotenv').config();
const { BskyAgent } = require('@atproto/api');

const TAGS = ['indie', 'gaming', 'gamingnews', 'tech', 'gamedev', 'indiedev', 'indiegame'];
const REPOSTED_URIS = new Set(); // Track what we've already reposted
const FOLLOWED_DIDS = new Set(); // Track who we've already followed

const agent = new BskyAgent({
  service: 'https://bsky.social'
});

// Login
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

// Auto-follow logic
async function autoFollow(did) {
  // Skip if we've already followed them this session
  if (FOLLOWED_DIDS.has(did)) {
    return;
  }

  try {
    const profile = await agent.getProfile({ actor: did });
    
    // Check if we're already following them
    if (profile.data.viewer?.following) {
      console.log(`   Already following ${profile.data.handle}`);
      FOLLOWED_DIDS.add(did);
      return;
    }

    console.log(`   👤 Following user: ${profile.data.handle}`);
    await agent.follow(did);
    FOLLOWED_DIDS.add(did);
    
    // Rate limit: wait a bit between follows
    await sleep(2000);
  } catch (err) {
    console.error("   ⚠️ Auto-follow error:", err.message);
  }
}

// Auto-repost logic
async function checkForInteresting() {
  try {
    console.log("\n🔍 Checking timeline for indie game & tech posts...");
    const timeline = await agent.getTimeline({ limit: 50 });
    let foundCount = 0;

    for (const feedItem of timeline.data.feed) {
      const post = feedItem.post;
      if (!post?.record?.text) continue;

      // Skip if we've already reposted this
      if (REPOSTED_URIS.has(post.uri)) continue;

      const text = post.record.text.toLowerCase();
      const hasTag = TAGS.some(tag => text.includes(`#${tag}`));
      
      if (!hasTag) continue;

      foundCount++;
      const authorDid = post.author.did;
      const authorHandle = post.author.handle;

      console.log(`\n📌 Found interesting post from @${authorHandle}:`);
      console.log(`   "${post.record.text.slice(0, 100)}${post.record.text.length > 100 ? '...' : ''}"`);

      // Follow them before reposting
      await autoFollow(authorDid);

      try {
        console.log(`   🔄 Reposting...`);
        await agent.repost(post.uri, post.cid);
        REPOSTED_URIS.add(post.uri);
        console.log(`   ✅ Reposted successfully!`);
        
        // Rate limit: wait between reposts
        await sleep(3000);
      } catch (err) {
        if (err.message.includes('already been reposted')) {
          console.log(`   ℹ️ Already reposted this post`);
          REPOSTED_URIS.add(post.uri);
        } else {
          console.error(`   ⚠️ Repost error: ${err.message}`);
        }
      }
    }

    if (foundCount === 0) {
      console.log("   No new posts found with target tags");
    } else {
      console.log(`\n✨ Processed ${foundCount} interesting post(s)`);
    }
  } catch (err) {
    console.error("❌ Timeline error:", err.message);
  }
}

// Helper function to sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down bot gracefully...');
  console.log(`📊 Session stats:`);
  console.log(`   - Reposts: ${REPOSTED_URIS.size}`);
  console.log(`   - New follows: ${FOLLOWED_DIDS.size}`);
  process.exit(0);
});

// Main loop
async function main() {
  console.log("🎮 Indie Game & Tech Spotlight Bot Starting...\n");
  
  const loggedIn = await login();
  if (!loggedIn) {
    console.error("Failed to login. Exiting.");
    process.exit(1);
  }

  console.log(`🏷️  Watching for tags: ${TAGS.join(', ')}`);
  console.log("🔄 Checking timeline every 60 seconds...\n");

  // Initial check
  await checkForInteresting();

  // Check timeline every 60 seconds (increased from 30 to be more respectful)
  setInterval(checkForInteresting, 60 * 1000);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
