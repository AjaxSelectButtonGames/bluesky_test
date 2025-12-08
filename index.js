// Simple Bluesky Bot - Ready to deploy on NerdHosting!
// Just add your credentials as environment variables in the dashboard

const { BskyAgent } = require('@atproto/api');

const agent = new BskyAgent({
    service: 'https://bsky.social'
});

async function main() {
    try {
        console.log('🦋 Simple Bluesky Bot Starting...');
        console.log('📅 Started at:', new Date().toISOString());
        
        // Get credentials from environment (set in NerdHosting dashboard)
        const handle = process.env.BLUESKY_HANDLE;
        const appPassword = process.env.BLUESKY_APP_PASSWORD;
        
        if (!handle || !appPassword) {
            console.error('❌ Missing environment variables!');
            console.error('   Please set in NerdHosting dashboard:');
            console.error('   - BLUESKY_HANDLE (your handle like: mybot.bsky.social)');
            console.error('   - BLUESKY_APP_PASSWORD (get from bsky.app/settings/app-passwords)');
            process.exit(1);
        }
        
        console.log(`📝 Logging in as: ${handle}`);
        
        // Login
        await agent.login({
            identifier: handle,
            password: appPassword
        });
        
        console.log('✅ Login successful!');
        
        // Get and display profile stats
        const profile = await agent.getProfile({ actor: agent.session.did });
        console.log(`\n👤 Account Info:`);
        console.log(`   Handle: @${profile.data.handle}`);
        console.log(`   Display Name: ${profile.data.displayName || 'Not set'}`);
        console.log(`   Followers: ${profile.data.followersCount}`);
        console.log(`   Following: ${profile.data.followsCount}`);
        console.log(`   Posts: ${profile.data.postsCount}`);
        
        // Simple heartbeat - log every minute that bot is alive
        console.log('\n💓 Bot is running! Heartbeat every 60 seconds...');
        console.log('   (This keeps the bot alive and shows it\'s working)\n');
        
        let heartbeatCount = 0;
        setInterval(() => {
            heartbeatCount++;
            const now = new Date().toLocaleTimeString();
            console.log(`[${now}] ❤️  Heartbeat #${heartbeatCount} - Bot is alive and well!`);
        }, 60000); // Every 60 seconds
        
        // Check mentions every 5 minutes (more realistic for a real bot)
        setInterval(async () => {
            try {
                const notifications = await agent.listNotifications({ limit: 10 });
                const unread = notifications.data.notifications.filter(n => !n.isRead);
                
                if (unread.length > 0) {
                    console.log(`\n🔔 You have ${unread.length} new notification(s):`);
                    unread.slice(0, 3).forEach(n => {
                        console.log(`   - ${n.reason} from @${n.author.handle}`);
                    });
                    console.log('');
                }
            } catch (error) {
                console.error(`⚠️  Error checking notifications: ${error.message}`);
            }
        }, 300000); // Every 5 minutes
        
    } catch (error) {
        console.error('\n❌ Bot failed to start!');
        console.error(`Error: ${error.message}`);
        
        if (error.message.includes('Invalid identifier or password')) {
            console.error('\n💡 Tips:');
            console.error('   1. Make sure you created an APP PASSWORD (not your main password)');
            console.error('   2. Get app password: https://bsky.app/settings/app-passwords');
            console.error('   3. Handle should be like: yourname.bsky.social');
            console.error('   4. Or use your email address');
        }
        
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down bot...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n\n👋 Shutting down bot...');
    process.exit(0);
});

main();
