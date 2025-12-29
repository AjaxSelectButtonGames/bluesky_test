require('dotenv').config();
const { BskyAgent, RichText } = require('@atproto/api');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

// 🔗 SITE INTEGRATION
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const SITE_API_URL = process.env.SPOTLIGHT_API_URL;

const SPOTLIGHT_USER = process.env.SPOTLIGHT_USER || 'yourhandle.bsky.social';
const POST_INTERVAL = 10 * 60 * 1000;
const CHECK_INTERVAL = 15 * 60 * 1000;
const SEARCH_INTERVAL = 15 * 60 * 1000;
const NETWORK_INTERVAL = 30 * 60 * 1000;
const FOLLOWBACK_INTERVAL = 10 * 60 * 1000;

const agent = new BskyAgent({ service: 'https://bsky.social' });

const db = new sqlite3.Database('bot-state.db');
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

function convertAtUriToWebUrl(uri, authorHandle) {
  try {
    const parts = uri.split('/');
    const postId = parts[parts.length - 1];
    return `https://bsky.app/profile/${authorHandle}/post/${postId}`;
  } catch {
    return null;
  }
}

// ---------------- SITE PUSH ----------------

async function sendSpotlightToSite(submission, postUrl) {
  if (!SITE_API_URL) return;

  let tag = 'indie-software';
  const lower = submission.text.toLowerCase();

  if (lower.includes('game')) tag = 'indie-games';
  else if (lower.includes('startup')) tag = 'indie-startups';

  try {
    const res = await fetch(`${SITE_API_URL}/api/spotlights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author_handle: submission.author,
        author_did: submission.author_did,
        content: submission.text,
        post_url: postUrl,
        tag
      })
    });

    if (res.ok) {
      console.log('Spotlight sent to site');
    } else {
      console.error('Site API rejected spotlight');
    }
  } catch (err) {
    console.error('Failed to send spotlight to site:', err.message);
  }
}

// ---------------- DATABASE ----------------

async function initDatabase() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS posted_uris (
      uri TEXT PRIMARY KEY,
      posted_at INTEGER
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS followed_dids (
      did TEXT PRIMARY KEY,
      followed_at INTEGER
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS post_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT,
      author_did TEXT,
      text TEXT,
      uri TEXT UNIQUE,
      timestamp INTEGER
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS blocklist (
      did TEXT PRIMARY KEY,
      handle TEXT,
      reason TEXT,
      added_at INTEGER
    )
  `);
}

async function isPosted(uri) {
  return !!(await dbGet('SELECT uri FROM posted_uris WHERE uri = ?', [uri]));
}

async function markAsPosted(uri) {
  await dbRun(
    'INSERT OR IGNORE INTO posted_uris (uri, posted_at) VALUES (?, ?)',
    [uri, Date.now()]
  );
}

async function isFollowed(did) {
  return !!(await dbGet('SELECT did FROM followed_dids WHERE did = ?', [did]));
}

async function markAsFollowed(did) {
  await dbRun(
    'INSERT OR IGNORE INTO followed_dids (did, followed_at) VALUES (?, ?)',
    [did, Date.now()]
  );
}

async function isBlocked(did) {
  return !!(await dbGet('SELECT did FROM blocklist WHERE did = ?', [did]));
}

async function addToQueue(submission) {
  await dbRun(
    'INSERT OR IGNORE INTO post_queue (author, author_did, text, uri, timestamp) VALUES (?, ?, ?, ?, ?)',
    [submission.author, submission.authorDid, submission.text, submission.uri, submission.timestamp]
  );
}

async function getNextFromQueue() {
  return await dbGet('SELECT * FROM post_queue ORDER BY timestamp ASC LIMIT 1');
}

async function removeFromQueue(id) {
  await dbRun('DELETE FROM post_queue WHERE id = ?', [id]);
}

// ---------------- AUTH ----------------

async function login() {
  try {
    await agent.login({
      identifier: process.env.BLUESKY_USERNAME,
      password: process.env.BLUESKY_PASSWORD
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------- POSTING ----------------

async function postSpotlight() {
  const submission = await getNextFromQueue();
  if (!submission) return;

  let cleanText = submission.text
    .replace(/#spotlight|#promote|#buildinpublic|#indiehackers|#indiedev|#solopreneur/gi, '')
    .trim();

  const postUrl = convertAtUriToWebUrl(submission.uri, submission.author);

  const spotlightText =
    `🌟 Spotlight: @${submission.author}\n\n` +
    `${cleanText}\n\n` +
    (postUrl ? `👉 ${postUrl}\n\n` : '') +
    `#IndieSpotlight`;

  const rt = new RichText({ text: spotlightText });
  await rt.detectFacets(agent);

  await agent.post({ text: rt.text, facets: rt.facets });
  console.log('Posted spotlight for @' + submission.author);

  // 🔗 PUSH TO SITE
  if (postUrl) {
    await sendSpotlightToSite(submission, postUrl);
  }

  await removeFromQueue(submission.id);
}

// ---------------- MAIN ----------------

async function main() {
  await initDatabase();
  if (!(await login())) return;

  setInterval(postSpotlight, POST_INTERVAL);
  console.log('Bot running');
}

main();
