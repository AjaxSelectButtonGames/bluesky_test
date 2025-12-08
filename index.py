import os
import time
import requests
from datetime import datetime, timedelta, timezone # <-- NEW IMPORTS
from atproto import Client, models

# --- CONFIGURATION ---

# Define the minimum time difference between two posts. 
# 23 hours ensures you meet the "daily" goal even if the cron job drifts slightly.
POST_INTERVAL_HOURS = 23 

TOPICS_TO_SHARE = [
    "python code", 
    "programming bot", 
    "404nerds"
]

# (The get_credentials function remains the same as before)
def get_credentials():
    username = os.environ.get('BSKY_USERNAME')
    app_password = os.environ.get('BSKY_APP_PASSWORD')
    
    if not username or not app_password:
        raise ValueError(
            "Authentication failed. Please set BSKY_USERNAME and BSKY_APP_PASSWORD "
            "environment variables on your hosting platform."
        )
    return username, app_password

class BlueskyBot:
    """A simple bot to automate posting, following, and reposting."""

    def __init__(self, username, password):
        self.client = Client()
        print(f"Logging in as {username}...")
        self.client.login(username, password)
        print("Login successful.")
        self.handle = username
        self.did = self.client.me.did
    
    # --- NEW / MODIFIED FUNCTION ---
    def get_last_post_time(self) -> datetime | None:
        """
        Fetches the timestamp of the last post made by the bot.
        
        Returns:
            datetime: The UTC datetime of the last post, or None if no posts are found.
        """
        try:
            # Use get_author_feed to get the bot's own posts, ordered chronologically
            # We filter for only the bot's primary posts (no replies) and limit to 1.
            feed_response = self.client.get_author_feed(
                actor=self.handle, 
                limit=1,
                filter='posts_only'
            )
            
            # The first item in the feed is the most recent post
            if feed_response.feed:
                last_post = feed_response.feed[0].post
                
                # The timestamp is stored in the record's 'createdAt' field as an ISO 8601 string
                created_at_str = last_post.record.created_at
                
                # Convert the ISO string to a timezone-aware datetime object
                # We replace 'Z' with '+00:00' for reliable parsing, and ensure it's UTC
                last_post_time = datetime.fromisoformat(
                    created_at_str.replace('Z', '+00:00')
                ).astimezone(timezone.utc)
                
                return last_post_time
            
            return None # No posts found in the feed

        except Exception as e:
            print(f"❌ Error checking last post time: {e}")
            return None

    def post_daily_message(self):
        """Task 1: Check if the post interval has passed, then post a message."""
        
        last_post_dt = self.get_last_post_time()
        
        # Current time in UTC for comparison
        now_utc = datetime.now(timezone.utc)
        
        if last_post_dt:
            time_since_last_post = now_utc - last_post_dt
            
            # Define the required interval
            required_interval = timedelta(hours=POST_INTERVAL_HOURS)

            if time_since_last_post < required_interval:
                print(f"⚠️ Post check skipped. Last post was only {time_since_last_post} ago. Required interval is {required_interval}.")
                return # Exit the function if the interval hasn't passed
            
            print(f"✅ Interval passed ({time_since_last_post} since last post). Posting new message.")

        else:
            print("No previous posts found. Posting first message.")

        # --- Posting Logic (Same as before) ---
        current_time = now_utc.strftime("%H:%M:%S UTC")
        post_text = (
            f"Daily check-in from the 404Nerds-hosted bot! "
            f"Current time: {current_time}. Keep building awesome things! 🛠️"
        )
        
        try:
            self.client.send_post(post_text)
            print(f"✅ Posted daily message: '{post_text[:50]}...'")
        except Exception as e:
            print(f"❌ Failed to post daily message: {e}")

    # (The auto_follow_followers and auto_share_topics functions remain the same)
    def auto_follow_followers(self):
        # ... (Same logic as provided in the initial answer)
        pass

    def auto_share_topics(self):
        # ... (Same logic as provided in the initial answer)
        pass


def run_bot_routine():
    """Main execution entry point."""
    try:
        username, password = get_credentials()
        bot = BlueskyBot(username, password)
        
        # 1. Perform conditional daily post
        bot.post_daily_message()
        
        # 2. Perform follow-back check (unconditional, runs every time)
        # bot.auto_follow_followers()
        
        # 3. Perform topic sharing check (unconditional, runs every time)
        # bot.auto_share_topics()
        
    except ValueError as e:
        print(f"CRITICAL ERROR: {e}")
    except requests.exceptions.HTTPError as e:
        print(f"BLUESKY API ERROR: {e}")
    except Exception as e:
        print(f"AN UNEXPECTED ERROR OCCURRED: {e}")

if __name__ == "__main__":
    run_bot_routine()
