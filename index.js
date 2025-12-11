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

// Auto-follow user before reposting
async function autoFollow(did) {
  try {
    const rel = await agent.rpc.get('app.bsky.graph.getRelationships', {
      params: { actor: did, viewer: agent.session.did },
    });
    const following = rel.data.relationships?.[0]?.following;

    if (!following) {
      console.log("Following:", did);
      await agent.follow(did);
    }
  } catch (err) {
    console.error("Follow error:", err);
  }
}

// Scan timeline and repost tagged content
async function checkForInteresting() {
  try {
    const timeline = await agent.getTimeline({ limit: 50 });

    for (const feedItem of timeline.data.feed) {
      const post = feedItem.post;
      if (!post?.record?.text) continue;

      const text = post.record.text.toLowerCase();
      const hasTag = TAGS.some(tag => text.includes(`#${tag}`));
      if (!hasTag) continue;

      const did = post.author.did;

      await autoFollow(did);

      console.log(`Reposting ${post.uri}`);
      await agent.repost(post.uri, post.cid);
    }
  } catch (err) {
    console.error("Timeline scan error:", err);
  }
}

// Listen to DMs for "!post ..."
async function checkDirectMessages() {
  try {
    const { data } = await agent.rpc.get('chat.bsky.convo.listConvos', {});
    for (const convo of data.convos) {
      const msgs = convo.messages || [];

      for (const msg of msgs) {
        if (!msg?.record?.text) continue;

        const text = msg.record.text.trim();

        if (text.startsWith("!post ")) {
          const content = text.replace("!post ", "").trim();
          if (!content.length) continue;

          console.log("Posting DM content:", content);
          await agent.post({ text: content });
        }
      }
    }
  } catch (err) {
    console.error("DM error:", err);
  }
}

// Start the bot
async function main() {
  await login();
  console.log("Bluesky bot running...");

  setInterval(checkForInteresting, 30 * 1000);
  setInterval(checkDirectMessages, 30 * 1000);
}

main();
