const axios = require('axios');
const process = require('process');

// --- CONFIGURATION ---

const BSKY_SERVICE_URL = 'https://bsky.social';

// Task Scheduling Intervals
const TASK_INTERVAL_MINUTES = 15;
const TASK_INTERVAL_MS = TASK_INTERVAL_MINUTES * 60 * 1000;

// Daily Post Interval
const POST_INTERVAL_MS = 23 * 60 * 60 * 1000; 

const TOPICS_TO_SHARE = [
    "axios", 
    "vanilla js bot", 
    "404nerds"
];

// --- GLOBALS & STATE ---

let session = null;
let headers = {};
let isRunning = false;

function getCredentials() {
    const identifier = process.env.BSKY_USERNAME;
    const password = process.env.BSKY_APP_PASSWORD;
    
    if (!identifier || !password) {
        throw new Error(
            "CRITICAL: BSKY_USERNAME and BSKY_APP_PASSWORD are required. Stopping execution."
        );
    }
    return { identifier, password };
}

// --- AUTHENTICATION & REFRESH ---

async function login() {
    console.log("Attempting fresh login...");
    const { identifier, password } = getCredentials();

    try {
        const response = await axios.post(`${BSKY_SERVICE_URL}/xrpc/com.atproto.server.createSession`, {
            identifier: identifier,
            password: password,
        });

        session = response.data;
        headers = { Authorization: `Bearer ${session.accessJwt}` };
        console.log(`✅ Login successful. Session established for ${session.handle}.`);
        return true;
    } catch (error) {
        console.error("❌ CRITICAL: Login failed. Bot cannot run.");
        session = null;
        headers = {};
        return false;
    }
}

// Function to handle expired token errors across all API calls
function handleApiError(e) {
    const errorMessage = e.response?.data?.error;
    
    if (errorMessage === 'ExpiredToken') {
        console.error("🚨 Detected Expired Token. Invalidating session for re-login.");
        session = null;
        headers = {};
        return true; // Token was expired
    } else {
        console.error("❌ API Error:", e.response?.data || e.message);
        return false; // Other API error
    }
}

// --- CORE BOT TASKS ---

async function get_last_post_time() {
    if (!session) return null;

    try {
        const response = await axios.get(`${BSKY_SERVICE_URL}/xrpc/app.bsky.feed.getAuthorFeed`, {
            headers: headers,
            params: { actor: session.handle, limit: 1, filter: 'posts_only' }
        });
        const feed = response.data.feed;
        if (feed.length > 0) {
            return new Date(feed[0].post.record.createdAt);
        }
        return null;
    } catch (e) {
        handleApiError(e);
        return null;
    }
}

async function post_daily_message() {
    const lastPostDate = await get_last_post_time();
    const now = new Date();
    
    // Skip if lastPostDate is null (due to previous token error) or if interval not met
    if (!session || (lastPostDate && now.getTime() - lastPostDate.getTime() < POST_INTERVAL_MS)) {
        if (lastPostDate) {
            const hoursSince = ((now.getTime() - lastPostDate.getTime()) / (1000 * 60 * 60)).toFixed(2);
            console.log(`⚠️ Post check skipped. Last post was only ${hoursSince} hours ago.`);
        }
        return;
    }
    
    const postText = `Daily check-in from the 404Nerds 24/7 bot! Current time: ${now.toUTCString()}. System is running continuously!`;
    
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
        handleApiError(e);
    }
}

async function auto_follow_followers() {
    if (!session) return;
    console.log("Checking for new followers to follow back...");
    
    try {
        const followsResponse = await axios.get(`${BSKY_SERVICE_URL}/xrpc/app.bsky.graph.getFollows`, {
            headers: headers,
            params: { actor: session.handle }
        });
        const followedDIDs = new Set(followsResponse.data.follows.map(f => f.did));

        const followersResponse = await axios.get(`${BSKY_SERVICE_URL}/xrpc/app.bsky.graph.getFollowers`, {
            headers: headers,
            params: { actor: session.handle }
        });
        
        let newlyFollowedCount = 0;
        
        for (const follower of followersResponse.data.followers) {
            if (!followedDIDs.has(follower.did)) {
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
        handleApiError(e);
    }
}

async function auto_share_topics() {
    if (!session) return;
    console.log("Searching for topics to repost...");
    
    try {
        const feedResponse = await axios.get(`${BSKY_SERVICE_URL}/xrpc/app.bsky.feed.getTimeline`, {
            headers: headers,
            params: { limit: 50 }
        });
        
        let repostedCount = 0;
        
        for (const feedItem of feedResponse.data.feed) {
            const post = feedItem.post;
            const postText = post.record?.text?.toLowerCase();
            
            if (!postText || post.viewer?.repost) continue;
                
            const isMatch = TOPICS_TO_SHARE.some(topic => postText.includes(topic.toLowerCase()));
            
            if (isMatch) {
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
        handleApiError(e);
    }
}

// --- MAIN EXECUTION LOOP ---

async function runBotRoutine() {
    if (isRunning) return;
    isRunning = true;
    console.log(`\n--- Starting routine at ${new Date().toTimeString()} ---`);

    try {
        // 1. Check if session is missing or was deliberately invalidated
        if (!session) {
            const success = await login();
            if (!success) {
                isRunning = false;
                return;
            }
        }
        
        // 2. Execute tasks
        await post_daily_message();
        await auto_follow_followers();
        await auto_share_topics();

    } catch (error) {
        console.error("CRITICAL ERROR during routine execution:", error.message || error);
        // Force re-login on next cycle if any unhandled error occurred
        session = null; 
    } finally {
        isRunning = false;
        console.log("--- Routine finished. Waiting for next cycle. ---");
    }
}

async function main() {
    console.log("Starting 24/7 Continuous Bot Process...");
    
    // Attempt initial login to establish session
    await login();

    // Set the continuous loop
    setInterval(runBotRoutine, TASK_INTERVAL_MS);

    // Initial run after startup (to avoid waiting 15 mins)
    runBotRoutine();
}

// Start the whole application
main();
