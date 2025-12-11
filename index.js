require('dotenv').config();
const { BskyAgent } = require('@atproto/api');

const TAGS = ['indie', 'gaming', 'gamingnews', 'tech'];

const agent = new BskyAgent({
  service: 'https://bsky.social'
});

// Login
async function login() {
  await agent.login({
    identifier: process.env.BLUESKY_USERNAME,
    password: process.env.BLUESKY_PASSWORD
  });
  console.log("Logged in as:", process.env.BLUESKY_USERNAME);
}

// Auto-follow logic
async function autoFollow(did) {
  try {
    const rel = await agent.rpc.get('app.bsky.graph.getRelationships', {
      params: { actor: did, viewer: agent.session.did },
    });

    const following = rel.data.relationships?.[0]?.following;

    if (!following) {
      console.log(`Following user: ${did}`);
      await agent.follow(did);
    }
  } catch (err) {
    console.error("Auto-follow error:", err);
  }
}

// Auto-repost logic
async function checkForInteresting() {
  try {
    const timeline = await agent.getTimeline({ limit: 50 });

    for (const feedItem of timeline.data.feed) {
      const post = feedItem.post;
      if (!post?.record?.text) continue;

      const text = post.record.text.toLowerCase();

      const hasTag = TAGS.some(tag => text.includes(`#${tag}`));
      if (!hasTag) continue;

      const authorDid = post.author.did;

      // Follow them before reposting
      await autoFollow(authorDid);

      try {
        console.log(`Reposting: ${post.uri}`);
        await agent.repost(post.uri, post.cid);
      } catch (err) {
        console.error("Repost error:", err.message);
      }
    }
  } catch (err) {
    console.error("Timeline error:", err);
  }
}

// Main loop
async function main() {
  await login();
  console.log("Auto-follow + Auto-repost bot is running...");

  // Check timeline every 30 seconds
  setInterval(checkForInteresting, 30 * 1000);
}

main();
