const axios = require('axios');
const process = require('process');

// --- CONFIGURATION ---

const BSKY_SERVICE_URL = 'https://bsky.social';

// Task Scheduling Intervals
const TASK_INTERVAL_MINUTES = 15; // How often to run all tasks (login check, follow, repost)
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
let isRunning = false; // Prevents overlapping task executions

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
        return false;
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
        // If the API call fails here, it often means the token expired.
        console.error("❌ API Error checking last post time (possible expired token):", e.response?.data || e.message);
        return null;
    }
}

async function post_daily_message() {
    const lastPostDate = await get_last_post_time();
    const now = new Date();
    
    if (lastPostDate) {
        const timeSinceLastPost = now.getTime() - lastPostDate.getTime();
        if (timeSinceLastPost < POST_INTERVAL_MS) {
            const hoursSince = (timeSinceLastPost / (1000 * 60 * 60)).toFixed(2);
            console.log(`⚠️ Post check skipped. Last post was only ${hoursSince} hours ago.`);
            return;
        }
    } else {
        console.log("No previous posts found. Posting first message.");
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
        console.error("❌ Failed to post daily message:", e.response?.data || e.message);
    }
}

async function auto_follow_followers() {
    // Logic for getting follows/followers and creating follow records (Axios calls)
    try {
        // ... (Axios implementation for getFollows and getFollowers) ...
        // ... (This logic is identical to the previous Axios version) ...
        console.log("✅ Finished follow-back check.");
    } catch (e) {
        console.error("❌ Error during follow-back check:", e.response?.data || e.message);
    }
}

async function auto_share_topics() {
    // Logic for getting timeline and creating repost records (Axios calls)
    try {
        // ... (Axios implementation for getTimeline and createRepost) ...
        // ... (This logic is identical to the previous Axios version) ...
        console.log(`✅ Finished auto-share check.`);
    } catch (e) {
        console.error("❌ Error during auto-share check:", e.response?.data || e.message);
    }
}

// --- MAIN EXECUTION LOOP ---

async function runBotRoutine() {
    if (isRunning) return; // Prevent concurrent execution
    isRunning = true;
    console.log(`\n--- Starting routine at ${new Date().toTimeString()} ---`);

    try {
        // 1. Check if we are logged in or if the session expired
        if (!session || !session.accessJwt) {
            const success = await login();
            if (!success) {
                // If login fails, we stop the current loop execution.
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
        // Force re-login on next cycle if any task failed unexpectedly
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
    // Runs the routine every 15 minutes
    setInterval(runBotRoutine, TASK_INTERVAL_MS);

    // Initial run after startup
    runBotRoutine();
}

// Start the whole application
main();
