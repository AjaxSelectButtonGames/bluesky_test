import { BskyAgent } from '@atproto/api';
import dotenv from 'dotenv';
dotenv.config();

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

// Auto-follow user if not already following
async function autoFollow(did) {
  try {
    const rel = await agent.rpc.get('app.bsky.graph.getRelationships', {
      params: { actor: did, viewer: agent.session.did },
    });

    const following = rel.data.relationships?.[0]?.following;
    if (!following) {
      console.log("Following user:", did);
      await agent.follow(did);
    }
  } catch (err) {
    console.error("Follow error:", err);
  }
}

// Check timeline for interesting posts
async function checkForInteresting() {
  const timeline = await agent.getTimeline({ limit: 50 });

  for (const feedItem of timeline.data.feed) {
    const post = feedItem.post;
    if (!post?.record?.text) continue;

    const text = post.record.text.toLowerCase();

    const hasTag = TAGS.some(tag => text.includes(`#${tag}`));
    if (!hasTag) continue;

    const authorDid = post.author.did;

    // Follow before repost
    await autoFollow(authorDid);

    try {
      console.log(`Reposting: ${post.uri}`);
      await agent.repost(post.uri, post.cid);
    } catch (err) {
      console.error("Repost error:", err);
    }
  }
}

// Read DMs and post user-submitted messages
async function checkDirectMessages() {
  try {
    const { data } = await agent.rpc.get(
      'chat.bsky.convo.listConvos',
      {}
    );

    for (const convo of data.convos) {
      const messages = convo?.messages || [];
      for (const msg of messages) {
        if (!msg?.record?.text) continue;

        const text = msg.record.text.trim();
        const sender = msg.sender?.did;

        // Only react to new messages
        if (text.startsWith('!post ')) {
          const content = text.replace('!post ', '').trim();

          if (content.length === 0) continue;

          console.log(`Posting DM content from ${sender}: ${content}`);

          await agent.post({
            text: content
          });
        }
      }
    }
  } catch (err) {
    console.error("DM error:", err);
  }
}

async function main() {
  await login();
  console.log("Bot started!");

  // Run the loops every 30 seconds
  setInterval(checkForInteresting, 30 * 1000);
  setInterval(checkDirectMessages, 30 * 1000);
}

main();
