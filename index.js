require('dotenv').config();
const { BskyAgent } = require('@atproto/api');

const TAGS = ['indie', 'gaming', 'gamingnews', 'tech', 'gamedev', 'indiedev', 'indiegame'];
const REPOSTED_URIS = new Set();
const FOLLOWED_DIDS = new Set();

const agent = new BskyAgent({
  service: 'https://bsky.social'
});

async function login() {
  try {
    await agent.login({
      identifier: process.env.BLUESKY_USERNAME,
      password: process.env.BLUESKY_PASSWORD
    });
    console.log("Logged in as:", process.env.BLUESKY_USERNAME);
    return true;
  } catch (err) {
    console.error("Login failed:", err.message);
    return false;
  }
}

async function autoFollow(did) {
  if (FOLLOWED_DIDS.has(did)) {
    return;
  }

  try {
    const profile = await agent.getProfile({ actor: did });
    
    if (profile.data.viewer?.following) {
      console.log("Already following", profile.data.handle);
      FOLLOWED_DIDS.add(did);
      return;
    }

    console.log("Following user:", profile.data.handle);
    await agent.follow(did);
    FOLLOWED_DIDS.add(did);
    
    await sleep(2000);
  } catch (err) {
    console.error("Auto-follow error:", err.message);
  }
}

async function checkForInteresting() {
  try {
    console.log("Checking timeline for indie game and tech posts...");
    const timeline = await agent.getTimeline({ limit: 50 });
    let foundCount = 0;

    for (const feedItem of timeline.data.feed) {
      const post = feedItem.post;
      if (!post?.record?.text) continue;

      if (REPOSTED_URIS.has(post.uri)) continue;

      const text = post.record.text.toLowerCase();
      const hasTag = TAGS.some(tag => text.includes(`#${tag}`));
      
      if (!hasTag) continue;

      foundCount++;
      const authorDid = post.author.did;
      const authorHandle = post.author.handle;

      console.log("Found interesting post from @" + authorHandle);
      console.log("Text:", post.record.text.slice(0, 100));

      await autoFollow(authorDid);

      try {
        console.log("Reposting...");
        await agent.repost(post.uri, post.cid);
        REPOSTED_URIS.add(post.uri);
        console.log("Reposted successfully!");
        
        await sleep(3000);
      } catch (err) {
        if (err.message.includes('already been reposted')) {
          console.log("Already reposted this post");
          REPOSTED_URIS.add(post.uri);
        } else {
          console.error("Repost error:", err.message);
        }
      }
    }

    if (foundCount === 0) {
      console.log("No new posts found with target tags");
    } else {
      console.log("Processed", foundCount, "interesting posts");
    }
  } catch (err) {
    console.error("Timeline error:", err.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('SIGINT', () => {
  console.log("Shutting down bot gracefully...");
  console.log("Session stats:");
  console.log("Reposts:", REPOSTED_URIS.size);
  console.log("New follows:", FOLLOWED_DIDS.size);
});

async function main() {
  console.log("Indie Game and Tech Spotlight Bot Starting...");
  
  const loggedIn = await login();
  if (!loggedIn) {
    console.error("Failed to login. Exiting.");
    return;
  }

  console.log("Watching for tags:", TAGS.join(', '));
  console.log("Checking timeline every 60 seconds...");

  await checkForInteresting();

  setInterval(checkForInteresting, 60 * 1000);
}

main().catch(err => {
  console.error("Fatal error:", err);
});
