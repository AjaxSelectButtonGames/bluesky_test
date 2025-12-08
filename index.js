// index.js

const axios = require('axios');
const process = require('process');

// --- CONFIGURATION ---

const POST_INTERVAL_MS = 82800000; // 23 hours
const BSKY_SERVICE_URL = 'https://bsky.social';

const TOPICS_TO_SHARE = [
    "axios", 
    "vanilla js bot", 
    "404nerds"
];

// --- AUTHENTICATION & GLOBALS ---

let session = null; // Stores the successful session object
let headers = {};   // Stores the authorization header

function getCredentials() {
    const identifier = process.env.BSKY_USERNAME;
    const password = process.env.BSKY_APP_PASSWORD;
    
    if (!identifier || !password) {
        throw new Error(
            "Authentication failed. BSKY_USERNAME and BSKY_APP_PASSWORD are required."
        );
    }
    return { identifier, password };
}

async function login() {
    const { identifier, password } = getCredentials();
    console.log(`Logging in as ${identifier}...`);

    try {
        const response = await axios.post(`${BSKY_SERVICE_URL}/xrpc/com.atproto.server.createSession`, {
            identifier: identifier,
            password: password,
        });

        session = response.data;
        headers = { Authorization: `Bearer ${session.accessJwt}` };
        console.log("Login successful. DID:", session.did);
    } catch (error) {
        console.error("❌ Login failed. Check credentials and App Password.");
        throw error;
    }
}

// --- CORE BOT LOGIC ---

async function get_last_post_time() {
    if (!session) return null;

    try {
        const response = await axios.get(`${BSKY_SERVICE_URL}/xrpc/app.bsky.feed.getAuthorFeed`, {
            headers: headers,
            params: {
                actor: session.handle,
                limit: 1,
                filter: 'posts_only'
            }
        });

        const feed = response.data.feed;
        if (feed.length > 0) {
            const createdAtStr = feed[0].post.record.createdAt;
            return new Date(createdAtStr);
        }
        return null;
    } catch (e) {
        console.error("❌ Error checking last post time:", e.response?.data || e.message);
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
    
    // Posting Logic - Manual JSON Payload
    const postText = `Daily check-in from the 404Nerds-hosted Axios bot! Current time: ${now.toUTCString()}. Now fully compliant! 🎉`;
    
    try {
        await axios.post(`${BSKY_SERVICE_URL}/xrpc/com.atproto.repo.createRecord`, {
            repo: session.did,
            collection: 'app.bsky.feed.post',
            record: {
                $type: 'app.bsky.feed.post',
                text: postText,
                createdAt: now.toISOString(),
            }
        }, { headers });
        
        console.log(`✅ Posted daily message: '${postText.substring(0, 50)}...'`);
    } catch (e) {
        console.error("❌ Failed to post daily message:", e.response?.data || e.message);
    }
}

async function auto_follow_followers() {
    console.log("Checking for new followers to follow back...");
    
    try {
        // 1. Get who the bot follows
        const followsResponse = await axios.get(`${BSKY_SERVICE_URL}/xrpc/app.bsky.graph.getFollows`, {
            headers: headers,
            params: { actor: session.handle }
        });
        const followedDIDs = new Set(followsResponse.data.follows.map(f => f.did));

        // 2. Get the bot's followers
        const followersResponse = await axios.get(`${BSKY_SERVICE_URL}/xrpc/app.bsky.graph.getFollowers`, {
            headers: headers,
            params: { actor: session.handle }
        });
        
        let newlyFollowedCount = 0;
        
        for (const follower of followersResponse.data.followers) {
            if (!followedDIDs.has(follower.did)) {
                // 3. Manually create the follow record
                await axios.post(`${BSKY_SERVICE_URL}/xrpc/com.atproto.repo.createRecord`, {
                    repo: session.did,
                    collection: 'app.bsky.graph.follow',
                    record: {
                        $type: 'app.bsky.graph.follow',
                        subject: follower.did,
                        createdAt: new Date().toISOString(),
                    }
                }, { headers });

                console.log(`🤝 Followed back: @${follower.handle}`);
                newlyFollowedCount++;
            }
        }
        
        console.log(`✅ Finished follow-back check. Followed ${newlyFollowedCount} new users.`);
    } catch (e) {
        console.error("❌ Error during follow-back check:", e.response?.data || e.message);
    }
}

async function auto_share_topics() {
    console.log("Searching for topics to repost...");
    
    try {
        // Get the home timeline
        const feedResponse = await axios.get(`${BSKY_SERVICE_URL}/xrpc/app.bsky.feed.getTimeline`, {
            headers: headers,
            params: { limit: 50 }
        });
        
        let repostedCount = 0;
        
        for (const feedItem of feedResponse.data.feed) {
            const post = feedItem.post;
            const postText = post.record?.text?.toLowerCase();
            
            if (!postText) continue;
            // The viewer object gives us the current repost status
            if (post.viewer?.repost) continue; 
                
            const isMatch = TOPICS_TO_SHARE.some(topic => postText.includes(topic.toLowerCase()));
            
            if (isMatch) {
                // Manually create the repost record
                await axios.post(`${BSKY_SERVICE_URL}/xrpc/com.atproto.repo.createRecord`, {
                    repo: session.did,
                    collection: 'app.bsky.feed.repost',
                    record: {
                        $type: 'app.bsky.feed.repost',
                        subject: {
                            cid: post.cid,
                            uri: post.uri,
                        },
                        createdAt: new Date().toISOString(),
                    }
                }, { headers });
                
                repostedCount++;
                console.log(`🔄 Reposted matching post by @${post.author.handle}: '${postText.substring(0, 30)}...'`);
            }
        }
        
        console.log(`✅ Finished auto-share check. Reposted ${repostedCount} posts.`);
    } catch (e) {
        console.error("❌ Error during auto-share check:", e.response?.data || e.message);
    }
}

/**
 * Main function to run the bot routine.
 */
async function main() {
    try {
        await login();
        
        console.log(`Bot routine started for: ${session.handle}`);
        
        // Run all tasks
        await post_daily_message();
        await auto_follow_followers();
        await auto_share_topics();
        
        console.log("Bot routine finished successfully. Process will terminate naturally.");
    } catch (error) {
        // Errors handled in login() will flow here and cause a natural exit.
        console.error("CRITICAL BOT ROUTINE FAILURE:", error.message || error);
    }
}

// Execute the main function
main();
