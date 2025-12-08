// index.js

const { BskyAgent } = require('@atproto/api');
const process = require('process');
const dotenv = require('dotenv');

// Load environment variables (useful for local development)
dotenv.config();

// --- CONFIGURATION ---
const POST_INTERVAL_MS = 82800000; // 23 hours in milliseconds
const TOPICS_TO_SHARE = [
    "javascript", 
    "nodejs bot", 
    "404nerds"
];

// --- AUTHENTICATION & AGENT SETUP ---

function getCredentials() {
    const identifier = process.env.BSKY_USERNAME;
    const password = process.env.BSKY_APP_PASSWORD;
    
    if (!identifier || !password) {
        // We throw an error instead of exiting, letting the process terminate naturally
        throw new Error(
            "Authentication failed. Please set BSKY_USERNAME and BSKY_APP_PASSWORD " +
            "environment variables on your hosting platform."
        );
    }
    return { identifier, password };
}

const agent = new BskyAgent({
    service: 'https://bsky.social',
});

// --- CORE BOT LOGIC (Functions remain unchanged) ---

async function get_last_post_time() {
    const handle = agent.session?.handle;
    if (!handle) return null;
    // ... (rest of function logic) ...
    try {
        const response = await agent.getAuthorFeed({
            actor: handle, limit: 1, filter: 'posts_only'
        });

        if (response.data.feed.length > 0) {
            const createdAtStr = response.data.feed[0].post.record?.createdAt;
            if (createdAtStr) return new Date(createdAtStr);
        }
        return null;
    } catch (e) {
        console.error("❌ Error checking last post time:", e);
        return null;
    }
}

async function post_daily_message() {
    const lastPostDate = await get_last_post_time();
    const now = new Date();
    
    // Conditional Check
    if (lastPostDate) {
        const timeSinceLastPost = now.getTime() - lastPostDate.getTime();
        if (timeSinceLastPost < POST_INTERVAL_MS) {
            const hoursSince = (timeSinceLastPost / (1000 * 60 * 60)).toFixed(2);
            console.log(`⚠️ Post check skipped. Last post was only ${hoursSince} hours ago.`);
            return;
        }
        console.log(`✅ Interval passed. Posting new message.`);
    } else {
        console.log("No previous posts found. Posting first message.");
    }
    
    // Posting Logic
    const postText = `Daily check-in from the 404Nerds-hosted Node.js bot! Current time: ${now.toUTCString()}. Stay decentralized! 🌐`;
    
    try {
        await agent.post({ text: postText });
        console.log(`✅ Posted daily message: '${postText.substring(0, 50)}...'`);
    } catch (e) {
        console.error("❌ Failed to post daily message:", e);
    }
}

async function auto_follow_followers() {
    console.log("Checking for new followers to follow back...");
    
    try {
        const handle = agent.session.handle;
        
        const followsResponse = await agent.getFollows({ actor: handle });
        const followedDIDs = new Set(followsResponse.data.follows.map(f => f.did));

        const followersResponse = await agent.getFollowers({ actor: handle });
        
        let newlyFollowedCount = 0;
        
        for (const follower of followersResponse.data.followers) {
            if (!followedDIDs.has(follower.did)) {
                await agent.follow(follower.did);
                console.log(`🤝 Followed back: @${follower.handle}`);
                newlyFollowedCount++;
            }
        }
        
        console.log(`✅ Finished follow-back check. Followed ${newlyFollowedCount} new users.`);
    } catch (e) {
        console.error("❌ Error during follow-back check:", e);
    }
}

async function auto_share_topics() {
    console.log("Searching for topics to repost...");
    
    try {
        const feedResponse = await agent.getTimeline({ limit: 50 });
        let repostedCount = 0;
        
        for (const feedItem of feedResponse.data.feed) {
            const post = feedItem.post;
            const postText = post.record?.text?.toLowerCase();
            
            if (!postText) continue;
            if (post.viewer?.repost) continue;
                
            const isMatch = TOPICS_TO_SHARE.some(topic => postText.includes(topic.toLowerCase()));
            
            if (isMatch) {
                await agent.repost(post.uri, post.cid);
                repostedCount++;
                console.log(`🔄 Reposted matching post by @${post.author.handle}: '${postText.substring(0, 30)}...'`);
            }
        }
        
        console.log(`✅ Finished auto-share check. Reposted ${repostedCount} posts.`);
    } catch (e) {
        console.error("❌ Error during auto-share check:", e);
    }
}

/**
 * Main function to run the bot routine.
 */
async function main() {
    try {
        const { identifier, password } = getCredentials();
        await agent.login({ identifier, password });
        
        console.log(`Bot routine started for: ${agent.session.handle}`);
        
        // Run all tasks
        await post_daily_message();
        await auto_follow_followers();
        await auto_share_topics();
        
        console.log("Bot routine finished successfully.");
        // Process naturally exits here after all async tasks are done.
    } catch (error) {
        console.error("CRITICAL BOT FAILURE:", error);
        // We no longer use process.exit(1) here. Throwing the error 
        // will log it, but the process will still terminate naturally 
        // after the error is handled.
    }
}

// Execute the main function
main();
