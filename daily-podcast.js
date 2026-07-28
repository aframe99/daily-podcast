#!/usr/bin/env node
/**
 * daily-podcast.js
 * ------------------------------------------------------------
 * Zero-cost version: uses Google's Gemini API free tier (no
 * credit card, so no way to be billed) for filtering + script
 * writing, and the free `msedge-tts` library (rides on
 * Microsoft Edge's built-in voices, no account/key needed) for
 * audio. Runs once a day via GitHub Actions.
 *
 * Required environment variables (set as GitHub Actions secrets):
 *   SUPABASE_URL
 *   SUPABASE_KEY            the anon/publishable key
 *   GEMINI_API_KEY          free from Google AI Studio, no card needed
 *   RESEND_API_KEY
 *   RESEND_FROM_EMAIL       e.g. onboarding@resend.dev
 *   USER_EMAIL
 *   REVIEW_PAGE_URL
 * ------------------------------------------------------------
 */

const crypto = require('crypto');
const Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_MODEL = 'gemini-3.5-flash'; // stable free-tier model, no billing required
const HOST_A_VOICE = 'en-US-GuyNeural';
const HOST_B_VOICE = 'en-US-JennyNeural';

const FEEDS = [
  'https://feeds.npr.org/1001/rss.xml',
  'https://www.policeone.com/rss/',
  'https://www.govtech.com/rss/all.rss',
  // Google News topic-search RSS also works well:
  // https://news.google.com/rss/search?q=YOUR+TOPIC&hl=en-US&gl=US&ceid=US:en
];
const MAX_ITEMS_PER_FEED = 15;

// ============================================================
// GEMINI HELPER (free tier — no billing enabled, so no way to be charged)
// ============================================================

async function callGemini(prompt, attempt = 1) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      }),
    }
  );
  if (!res.ok) {
    const bodyText = await res.text();
    // Retry a few times on transient server-side overload/rate-limit errors —
    // this runs unattended every morning, so it shouldn't need a human to
    // just try again a few seconds later.
    const transient = res.status === 503 || res.status === 429 || res.status >= 500;
    if (transient && attempt < 4) {
      const delayMs = 2000 * attempt; // 2s, 4s, 6s
      console.log(`Gemini call failed (status ${res.status}), retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/4)...`);
      await new Promise(r => setTimeout(r, delayMs));
      return callGemini(prompt, attempt + 1);
    }
    throw new Error(`Gemini call failed: ${bodyText}`);
  }
  const data = await res.json();
  return data.candidates[0].content.parts.map(p => p.text || '').join('\n');
}

// ============================================================
// SUPABASE HELPERS (plain REST calls, no SDK needed)
// ============================================================

async function sbGet(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase GET ${table} failed: ${await res.text()}`);
  return res.json();
}

async function sbUpsert(table, rows, onConflict) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase UPSERT ${table} failed: ${await res.text()}`);
}

async function sbPatch(table, query, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} failed: ${await res.text()}`);
}

async function sbUploadFile(bucket, filename, buffer, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${filename}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': contentType,
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Supabase upload failed: ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${filename}`;
}

// ============================================================
// 1. FLAGGED STORIES — pull unprocessed ones you shared from your phone,
//    fetch the real article text so the model has more than just a headline
// ============================================================

async function getFlaggedStories() {
  const rows = await sbGet('flagged_stories', 'processed=eq.false&select=*');
  const stories = [];

  for (const row of rows) {
    let title = row.title || row.url;
    let text = '';
    try {
      const res = await fetch(row.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await res.text();
      const dom = new JSDOM(html, { url: row.url });
      const article = new Readability(dom.window.document).parse();
      if (article) {
        title = article.title || title;
        text = (article.textContent || '').slice(0, 2000);
      }
    } catch (err) {
      console.error(`Could not fetch flagged article ${row.url}: ${err.message}`);
    }
    stories.push({
      id: crypto.createHash('md5').update(row.url).digest('hex').slice(0, 8),
      title,
      snippet: text || '(could not fetch article text — using link only)',
      link: row.url,
      source: 'flagged by you',
      flaggedRowId: row.id,
    });
  }
  return stories;
}

// ============================================================
// 2. COLLECT — pull raw RSS candidates
// ============================================================

async function collectCandidates() {
  const parser = new Parser();
  const candidates = [];
  for (const feedUrl of FEEDS) {
    let feed;
    try {
      feed = await parser.parseURL(feedUrl);
    } catch (err) {
      console.error(`Failed to fetch ${feedUrl}: ${err.message}`);
      continue;
    }
    for (const item of feed.items.slice(0, MAX_ITEMS_PER_FEED)) {
      candidates.push({
        id: crypto.createHash('md5').update(item.link || item.title).digest('hex').slice(0, 8),
        title: item.title,
        snippet: (item.contentSnippet || '').slice(0, 300),
        link: item.link,
        source: feed.title,
      });
    }
  }
  return candidates;
}

// ============================================================
// 3. FILTER — Gemini picks from RSS candidates using preferences + feedback
//    (flagged stories skip this — you already chose them)
// ============================================================

async function filterCandidates(candidates, prefs, feedback) {
  if (candidates.length === 0) return { selected: [], rejected: [] };

  const recentFeedback = feedback.slice(-40);
  const feedbackBlock = recentFeedback.length
    ? recentFeedback.map(f => `- [${f.decision.toUpperCase()}] "${f.title}" (${f.source})`).join('\n')
    : '(none yet)';

  const candidateBlock = candidates
    .map(c => `- id:${c.id} | ${c.title} (${c.source}): ${c.snippet}`)
    .join('\n');

  const prompt = `You are filtering news stories for a daily personal podcast.

TOPICS the listener cares about: ${prefs.topics.join(', ')}
LIKES: ${prefs.likes}
DISLIKES: ${prefs.dislikes}

RECENT FEEDBACK on past picks (learn from this):
${feedbackBlock}

CANDIDATE STORIES today:
${candidateBlock}

Select stories that best fit this listener's interests. Respond with ONLY
valid JSON, no markdown fences, no commentary:
{
  "selected": [{"id": "...", "reason": "short reason"}],
  "rejected": [{"id": "...", "reason": "short reason"}]
}
Every candidate id must appear in exactly one list. Prefer 4-8 strong picks
over including everything.`;

  const raw = (await callGemini(prompt)).trim();
  const cleaned = raw.replace(/^```json\s*|\s*```$/g, '');
  const parsed = JSON.parse(cleaned);

  const byId = Object.fromEntries(candidates.map(c => [c.id, c]));
  const selected = parsed.selected.map(s => ({ ...byId[s.id], reason: s.reason }));
  const rejected = parsed.rejected.map(r => ({ ...byId[r.id], reason: r.reason }));
  return { selected, rejected };
}

// ============================================================
// 4. SCRIPT — two-host podcast dialogue
// ============================================================

async function generateScript(stories) {
  const storyBlock = stories.map(s => `- ${s.title} (${s.source}): ${s.snippet}`).join('\n');
  if (!storyBlock.trim()) throw new Error('No stories selected today.');

  const prompt = `You are writing a script for a short daily two-host news podcast.
Hosts are "A" and "B". Cover the stories below conversationally, with brief
back-and-forth commentary — not just reading headlines. Aim for a 6-8 minute
episode (roughly 900-1100 words). Open with a short cold-open greeting and
close with a sign-off.

Format STRICTLY as alternating lines:
A: <line>
B: <line>

Stories:
${storyBlock}`;

  return callGemini(prompt);
}

// ============================================================
// 5. AUDIO — free edge-tts, per line, concatenated
// ============================================================

async function synthesizeSpeech(text, voice) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = await tts.toStream(text);

  const chunks = [];
  for await (const chunk of audioStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function renderAudio(script) {
  const lines = script.split('\n').map(l => l.trim()).filter(l => /^[AB]:/.test(l));
  if (lines.length === 0) throw new Error('Script not in expected A:/B: format.');

  const chunks = [];
  for (const line of lines) {
    const speaker = line[0];
    const content = line.slice(2).trim();
    if (!content) continue;
    const voice = speaker === 'A' ? HOST_A_VOICE : HOST_B_VOICE;
    chunks.push(await synthesizeSpeech(content, voice));
  }
  return Buffer.concat(chunks);
}

// ============================================================
// 6. EMAIL — via Resend
// ============================================================

async function sendEmail({ podcastUrl, reviewUrl, dateStr, storyCount }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      to: process.env.USER_EMAIL,
      subject: `Your daily podcast — ${dateStr}`,
      html: `<p>Today's episode covers ${storyCount} stories.</p>
             <p><a href="${podcastUrl}">Listen to today's podcast</a></p>
             <p><a href="${reviewUrl}">Review picks / adjust preferences</a></p>`,
    }),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${await res.text()}`);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const dateStr = new Date().toISOString().slice(0, 10);

  console.log('Loading preferences + feedback...');
  const [prefsRows, feedback] = await Promise.all([
    sbGet('preferences', 'id=eq.1&select=*'),
    sbGet('feedback', 'select=*&order=created_at.desc&limit=40'),
  ]);
  const prefs = prefsRows[0];

  console.log('Loading flagged stories...');
  const flagged = await getFlaggedStories();

  console.log('Collecting RSS candidates...');
  const candidates = await collectCandidates();

  console.log(`Filtering ${candidates.length} RSS candidates via Gemini...`);
  const { selected: rssSelected, rejected } = await filterCandidates(candidates, prefs, feedback);

  const allSelected = [...flagged, ...rssSelected];
  console.log(`Total selected: ${allSelected.length} (${flagged.length} flagged, ${rssSelected.length} from RSS)`);

  await sbUpsert('reviews', [{
    review_date: dateStr,
    selected: allSelected,
    rejected,
  }], 'review_date');

  console.log('Generating script...');
  const script = await generateScript(allSelected);

  console.log('Rendering audio...');
  const audioBuffer = await renderAudio(script);

  console.log('Uploading audio to Supabase storage...');
  const podcastUrl = await sbUploadFile('podcasts', `podcast-${dateStr}.mp3`, audioBuffer, 'audio/mpeg');

  console.log('Marking flagged stories as processed...');
  for (const f of flagged) {
    await sbPatch('flagged_stories', `id=eq.${f.flaggedRowId}`, { processed: true });
  }

  console.log('Sending email...');
  await sendEmail({
    podcastUrl,
    reviewUrl: process.env.REVIEW_PAGE_URL,
    dateStr,
    storyCount: allSelected.length,
  });

  console.log('Done.');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
