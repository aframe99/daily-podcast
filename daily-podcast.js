#!/usr/bin/env node
/**
 * daily-podcast.js
 * ------------------------------------------------------------
 * Zero-cost version: uses Google's Gemini API free tier (no
 * credit card, so no way to be billed) for filtering, script
 * writing, AND audio — Gemini's own native text-to-speech model
 * (also free tier, same API key) generates both podcast voices
 * directly, which sounds far more natural than the free
 * Microsoft Edge voices this used to rely on. Runs once a day
 * via GitHub Actions.
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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_MODEL = 'gemini-3.5-flash-lite'; // stable free-tier model, no billing required; lite tier tends to have more capacity headroom
const TTS_MODEL = 'gemini-2.5-flash-preview-tts'; // free-tier native Gemini TTS; picked over the newer 3.1 TTS preview to avoid the same demand-congestion we hit on gemini-3.5-flash
const HOST_A_VOICE = 'Puck'; // Gemini prebuilt voice: "Upbeat"
const HOST_B_VOICE = 'Kore'; // Gemini prebuilt voice: "Firm" — the two voices used in Google's own multi-speaker examples

const FEEDS = [
  'https://feeds.npr.org/1001/rss.xml',
  // The original policeone.com and govtech.com feed URLs both 404'd (policeone.com
  // rebranded to police1.com and no longer publishes a feed at the old path;
  // govtech.com/rss/all.rss doesn't exist either). Replaced with confirmed-working
  // feeds that cover the same ground:
  'https://police1.com/news.rss', // Police1's real feed (found via their RSS index page) — daily law enforcement news, incl. police tech and traffic enforcement
  'https://feeds.feedburner.com/StateTech', // state & local government IT, incl. public safety tech
  'https://www.nextgov.com/rss/all/', // federal/state govtech and cybersecurity news
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
// 5. AUDIO — Gemini's own native two-speaker TTS (free tier)
// ============================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini TTS returns raw 16-bit PCM audio (24kHz, mono) with no file header —
// this wraps it in a standard 44-byte WAV header so it's a playable file.
function pcmToWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

async function synthesizeChunk(chunkText, attempt = 1) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `TTS the following conversation between speaker A and speaker B. Keep a natural, conversational podcast delivery:\n\n${chunkText}`,
          }],
        }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: [
                { speaker: 'A', voiceConfig: { prebuiltVoiceConfig: { voiceName: HOST_A_VOICE } } },
                { speaker: 'B', voiceConfig: { prebuiltVoiceConfig: { voiceName: HOST_B_VOICE } } },
              ],
            },
          },
        },
      }),
    }
  );

  if (!res.ok) {
    const bodyText = await res.text();
    const transient = res.status === 503 || res.status === 429 || res.status >= 500;
    if (transient && attempt < 4) {
      const delayMs = 2000 * attempt;
      console.log(`TTS chunk failed (status ${res.status}), retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/4)...`);
      await sleep(delayMs);
      return synthesizeChunk(chunkText, attempt + 1);
    }
    throw new Error(`Gemini TTS call failed: ${bodyText}`);
  }

  const data = await res.json();
  const inlineData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inlineData?.data) {
    // Docs note this model occasionally returns text instead of audio on a
    // small percentage of requests — worth a retry rather than failing.
    if (attempt < 4) {
      const delayMs = 2000 * attempt;
      console.log(`TTS chunk returned no audio, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/4)...`);
      await sleep(delayMs);
      return synthesizeChunk(chunkText, attempt + 1);
    }
    throw new Error('Gemini TTS returned no audio data after retries.');
  }
  return Buffer.from(inlineData.data, 'base64');
}

async function renderAudio(script) {
  const lines = script.split('\n').map(l => l.trim()).filter(l => /^[AB]:/.test(l));
  if (lines.length === 0) throw new Error('Script not in expected A:/B: format.');

  // Chunk the script rather than sending it all in one TTS call — Google's
  // own docs note speech quality/consistency can drift on outputs longer
  // than a few minutes, so smaller chunks keep each one sounding clean.
  const LINES_PER_CHUNK = 8;
  const chunks = [];
  for (let i = 0; i < lines.length; i += LINES_PER_CHUNK) {
    chunks.push(lines.slice(i, i + LINES_PER_CHUNK).join('\n'));
  }

  const pcmParts = [];
  for (const chunk of chunks) {
    pcmParts.push(await synthesizeChunk(chunk));
    await sleep(250); // small gap between requests
  }
  return pcmToWav(Buffer.concat(pcmParts));
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

async function sendNoStoriesEmail({ reviewUrl, dateStr, candidateCount }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      to: process.env.USER_EMAIL,
      subject: `No podcast today — ${dateStr}`,
      html: `<p>Checked ${candidateCount} stories today, but none matched your topics/likes closely enough to make the cut, so there's no episode.</p>
             <p>This is normal on quiet news days. Flag anything interesting from your phone, or loosen your topics/likes on the review page, to get more picks tomorrow.</p>
             <p><a href="${reviewUrl}">Review / adjust preferences</a></p>`,
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

  if (allSelected.length === 0) {
    console.log('No stories matched today — sending a heads-up email instead of a podcast.');
    await sendNoStoriesEmail({
      reviewUrl: process.env.REVIEW_PAGE_URL,
      dateStr,
      candidateCount: candidates.length,
    });
    console.log('Done (no episode today).');
    return;
  }

  console.log('Generating script...');
  const script = await generateScript(allSelected);

  console.log('Rendering audio...');
  const audioBuffer = await renderAudio(script);

  console.log('Uploading audio to Supabase storage...');
  const podcastUrl = await sbUploadFile('podcasts', `podcast-${dateStr}.wav`, audioBuffer, 'audio/wav');

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
