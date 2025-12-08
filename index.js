const { BskyAgent } = require('@atproto/api'); 
const agent = new BskyAgent({ service: 'https://bsky.social' }); 
async function main() { 
    // Login with credentials 
    from dashboard await agent.login({ identifier: 
        process.env.BLUESKY_HANDLE, password: 
        process.env.BLUESKY_APP_PASSWORD }); 
    console.log('Bot is running!'); 
    // Check notifications every 5 minutes 
    setInterval(async () => { const notifs = await agent.listNotifications(); 
    console.log(`New notifications: ${notifs.data.notifications.length}`); }, 300000); 
} 
main();
