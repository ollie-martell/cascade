/**
 * YouTube transcript fetching.
 *
 * Render's cloud IP is hard-blocked by YouTube's timedtext CDN (HTTP 429 on
 * every request, regardless of headers/delays/session tokens). yt-dlp uses
 * a completely different session mechanism that bypasses this restriction.
 *
 * Strategy 1: ANDROID v19  → timedtext (fast; works on residential IPs)
 * Strategy 2: yt-dlp       → own session/retry logic (works from cloud IPs)
 * Strategy 3: Page scrape  → last resort
 */

const axios  = require('axios');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');
const YTDlpWrap = require('yt-dlp-wrap').default;

// ─── URL parsing ─────────────────────────────────────────────────────────────

const YOUTUBE_PATTERNS = [
  /(?:youtube\.com\/watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/,
  /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  /(?:youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
];

function extractVideoId(url) {
  for (const re of YOUTUBE_PATTERNS) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function isValidYouTubeUrl(url) {
  return extractVideoId(url) !== null;
}

// ─── Caption track selector (for ANDROID strategy) ───────────────────────────

function pickBestTrack(tracks) {
  return (
    tracks.find(t => t.languageCode?.startsWith('en') && t.kind !== 'asr') ||
    tracks.find(t => t.languageCode?.startsWith('en')) ||
    tracks.find(t => t.kind !== 'asr') ||
    tracks[0]
  );
}

// ─── VTT parser ──────────────────────────────────────────────────────────────

function parseVTT(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l =>
      l &&
      l !== 'WEBVTT' &&
      !l.match(/^\d{2}:\d{2}/) &&
      !l.includes('-->') &&
      !l.match(/^\d+$/) &&
      !l.startsWith('NOTE') &&
      !l.startsWith('REGION') &&
      !l.startsWith('STYLE') &&
      !l.startsWith('Kind:') &&
      !l.startsWith('Language:')
    )
    .map(l => l.replace(/<[^>]+>/g, '').replace(/\[♪+\]/g, '').replace(/♪/g, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── yt-dlp setup ─────────────────────────────────────────────────────────────

const YTDLP_BINARY = path.join(os.tmpdir(), 'yt-dlp-cascade');
let _ytdlp = null;

async function getYtdlp() {
  if (_ytdlp) return _ytdlp;
  if (!fs.existsSync(YTDLP_BINARY)) {
    console.log('[Cascade] Downloading yt-dlp binary...');
    await YTDlpWrap.downloadFromGithub(YTDLP_BINARY);
    console.log('[Cascade] yt-dlp binary downloaded');
  }
  _ytdlp = new YTDlpWrap(YTDLP_BINARY);
  return _ytdlp;
}

// Pre-warm: download binary at startup so first request is faster
setImmediate(() => {
  getYtdlp()
    .then(() => console.log('[Cascade] yt-dlp ready'))
    .catch(e => console.log('[Cascade] yt-dlp pre-warm failed:', e.message));
});

// ─── youtubei.js session (used only for visitor ID in ANDROID strategy) ───────

const { Innertube } = require('youtubei.js');
let _yt = null;

setImmediate(() => {
  Innertube.create({ generate_session_locally: true })
    .then(yt => { _yt = yt; console.log('[Cascade] youtubei.js session ready'); })
    .catch(e => console.log('[Cascade] youtubei.js pre-warm failed:', e.message));
});

// ─── Strategy 1: ANDROID v19 ─────────────────────────────────────────────────

async function fetchViaAndroid(videoId) {
  const res = await axios.post(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    {
      videoId,
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '19.09.37',
          androidSdkVersion: 34,
          hl: 'en',
          gl: 'US',
          timeZone: 'UTC',
          utcOffsetMinutes: 0,
        },
      },
      contentCheckOk: true,
      racyCheckOk: true,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip',
        'X-YouTube-Client-Name': '3',
        'X-YouTube-Client-Version': '19.09.37',
        'X-Goog-Api-Format-Version': '1',
      },
      timeout: 10000,
    }
  );

  const tracks = res.data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) return null;

  const track = pickBestTrack(tracks);
  if (!track?.baseUrl) return null;

  console.log(`[Cascade] ANDROID: ${tracks.length} tracks, "${track.languageCode}" ${track.kind === 'asr' ? '(auto)' : '(manual)'}`);

  // Non-blocking: use cached visitor ID if session is ready
  const visitorId = _yt?.session?.context?.client?.visitorData || null;

  const capUrl = new URL(track.baseUrl);
  capUrl.searchParams.set('fmt', 'json3');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': `https://www.youtube.com/watch?v=${videoId}`,
    'Origin': 'https://www.youtube.com',
    ...(visitorId ? { 'X-Goog-Visitor-Id': visitorId } : {}),
  };

  // Single attempt — if 429, yt-dlp strategy will handle it
  const capRes = await axios.get(capUrl.toString(), { timeout: 10000, headers });

  if (capRes.data?.events) {
    const text = capRes.data.events
      .filter(e => Array.isArray(e.segs))
      .map(e => e.segs.map(s => (s.utf8 || '').replace(/\n/g, ' ')).join('').trim())
      .filter(t => t && t !== '[♪♪♪]' && t !== '[Music]' && t !== '[Applause]')
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (text.length > 30) return text;
  }

  return null;
}

// ─── Strategy 2: yt-dlp ───────────────────────────────────────────────────────
// Uses completely different session/signing mechanism — bypasses timedtext 429.

async function fetchViaYtdlp(videoId) {
  const yt = await getYtdlp();
  const outTemplate = path.join(os.tmpdir(), `cascade_${videoId}`);

  // Clean up any stale files from a previous failed run
  try {
    fs.readdirSync(os.tmpdir())
      .filter(f => f.startsWith(`cascade_${videoId}`))
      .forEach(f => fs.unlinkSync(path.join(os.tmpdir(), f)));
  } catch (_) {}

  await yt.execPromise([
    `https://www.youtube.com/watch?v=${videoId}`,
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-lang', 'en',
    '--sub-format', 'vtt',
    '-o', outTemplate,
    '--quiet',
    '--no-warnings',
  ]);

  const files = fs.readdirSync(os.tmpdir())
    .filter(f => f.startsWith(`cascade_${videoId}`) && f.endsWith('.vtt'));

  if (!files.length) {
    console.log('[Cascade] yt-dlp: no subtitle files found');
    return null;
  }

  // Prefer manual captions over auto-generated
  const preferred = files.find(f => !f.includes('orig')) || files[0];
  const content = fs.readFileSync(path.join(os.tmpdir(), preferred), 'utf8');

  // Cleanup
  files.forEach(f => {
    try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {}
  });

  const text = parseVTT(content);
  if (text.length > 30) {
    console.log(`[Cascade] yt-dlp: ${text.length} chars from ${preferred}`);
    return text;
  }
  return null;
}

// ─── Strategy 3: Page scrape ──────────────────────────────────────────────────

async function fetchViaPageScrape(videoId) {
  const res = await axios.get(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 15000,
  });

  const html = res.data;
  const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  const marker = 'ytInitialPlayerResponse = ';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) return null;

  const jsonStart = startIdx + marker.length;
  let depth = 0, i = jsonStart;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
    i++;
  }

  const playerResponse = JSON.parse(html.substring(jsonStart, i));
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) return null;

  const track = pickBestTrack(tracks);
  if (!track?.baseUrl) return null;

  const capUrl = new URL(track.baseUrl);
  capUrl.searchParams.set('fmt', 'json3');
  const capRes = await axios.get(capUrl.toString(), {
    timeout: 10000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Cookie': cookies,
      'Referer': 'https://www.youtube.com/',
    },
  });

  if (capRes.data?.events) {
    const text = capRes.data.events
      .filter(e => Array.isArray(e.segs))
      .map(e => e.segs.map(s => (s.utf8 || '').replace(/\n/g, ' ')).join('').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (text.length > 30) return text;
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function fetchTranscript(youtubeUrl) {
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    const err = new Error('Invalid YouTube URL');
    err.code = 'INVALID_URL';
    throw err;
  }

  console.log(`[Cascade] Fetching transcript: ${videoId}`);

  const strategies = [
    { name: 'ANDROID v19',  fn: () => fetchViaAndroid(videoId) },
    { name: 'yt-dlp',       fn: () => fetchViaYtdlp(videoId) },
    { name: 'Page scrape',  fn: () => fetchViaPageScrape(videoId) },
  ];

  for (const { name, fn } of strategies) {
    try {
      const transcript = await fn();
      if (transcript && transcript.trim().length > 30) {
        console.log(`[Cascade] ✓ ${name} — ${transcript.length} chars`);
        return transcript;
      }
      console.log(`[Cascade] ${name} returned empty, trying next...`);
    } catch (err) {
      console.log(`[Cascade] ${name} failed: ${err.message?.substring(0, 100)}`);
    }
  }

  const err = new Error(
    'No captions found for this video. Auto-generated captions may be disabled or the video is restricted. Please paste the transcript manually.'
  );
  err.code = 'NO_TRANSCRIPT';
  throw err;
}

module.exports = { fetchTranscript, extractVideoId, isValidYouTubeUrl };
