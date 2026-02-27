/**
 * YouTube transcript fetching.
 *
 * Root cause on cloud IPs: YouTube's timedtext endpoint returns 429 for
 * unauthenticated requests from datacenters. Fix: include X-Goog-Visitor-Id
 * from a youtubei.js session + retry with backoff on 429.
 *
 * Strategy 1: ANDROID v19 (fast, 180ms) + authenticated timedtext fetch
 * Strategy 2: youtubei.js session (fallback, includes transcript panel)
 * Strategy 3: Page scrape with cookies (last resort)
 */

const axios = require('axios');
const { Innertube } = require('youtubei.js');

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

// ─── Caption track selector ───────────────────────────────────────────────────

function pickBestTrack(tracks) {
  return (
    tracks.find(t => t.languageCode?.startsWith('en') && t.kind !== 'asr') ||
    tracks.find(t => t.languageCode?.startsWith('en')) ||
    tracks.find(t => t.kind !== 'asr') ||
    tracks[0]
  );
}

// ─── youtubei.js session (pre-warmed at startup) ──────────────────────────────
// Used solely to get a valid X-Goog-Visitor-Id for timedtext requests.

let _yt = null;
let _ytExpiry = 0;
const YT_TTL_MS = 25 * 60 * 1000;

async function getInnertube() {
  if (!_yt || Date.now() > _ytExpiry) {
    _yt = await Innertube.create({ generate_session_locally: true });
    _ytExpiry = Date.now() + YT_TTL_MS;
    console.log('[Cascade] youtubei.js session created');
  }
  return _yt;
}

// Pre-warm at module load — avoids 19s delay on first user request
setImmediate(() => {
  getInnertube()
    .then(() => console.log('[Cascade] youtubei.js session ready'))
    .catch(e => console.log('[Cascade] youtubei.js pre-warm failed:', e.message));
});

// ─── Caption content fetcher ──────────────────────────────────────────────────
// The timedtext endpoint returns 429 for bare cloud requests.
// Fix: add X-Goog-Visitor-Id + Referer, then retry with backoff on 429.

async function fetchCaptionContent(baseUrl, videoId) {
  // Best-effort: get visitor ID from cached session to authenticate the request
  let visitorId = null;
  try {
    const yt = await getInnertube();
    visitorId = yt.session?.context?.client?.visitorData || null;
  } catch (_) {}

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': `https://www.youtube.com/watch?v=${videoId}`,
    'Origin': 'https://www.youtube.com',
    ...(visitorId ? { 'X-Goog-Visitor-Id': visitorId } : {}),
  };

  // Try json3 format with up to 3 attempts (backing off on 429)
  const jsonUrl = new URL(baseUrl);
  jsonUrl.searchParams.set('fmt', 'json3');

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const wait = attempt * 3000;
      console.log(`[Cascade] 429 on timedtext, waiting ${wait}ms (attempt ${attempt + 1})...`);
      await new Promise(r => setTimeout(r, wait));
    }

    try {
      const res = await axios.get(jsonUrl.toString(), { timeout: 12000, headers });

      if (res.data?.events) {
        const text = res.data.events
          .filter(e => Array.isArray(e.segs))
          .map(e => e.segs.map(s => (s.utf8 || '').replace(/\n/g, ' ')).join('').trim())
          .filter(t => t && t !== '[♪♪♪]' && t !== '[Music]' && t !== '[Applause]')
          .join(' ')
          .replace(/\s{2,}/g, ' ')
          .trim();
        if (text.length > 30) return text;
      }
    } catch (err) {
      if (err.response?.status === 429 && attempt < 2) continue;

      // Non-429 error or final attempt — fall through to XML fallback below
      break;
    }
  }

  // XML fallback (different path, different rate-limit bucket)
  try {
    const xmlRes = await axios.get(baseUrl, { timeout: 12000, headers });
    const xml = xmlRes.data;
    if (typeof xml === 'string' && xml.includes('<text')) {
      const texts = [];
      const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
      let m;
      while ((m = re.exec(xml)) !== null) {
        const t = m[1]
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
        if (t) texts.push(t);
      }
      const text = texts.join(' ').replace(/\s{2,}/g, ' ').trim();
      if (text.length > 30) return text;
    }
  } catch (_) {}

  return '';
}

// ─── Strategy 1: ANDROID v19 ─────────────────────────────────────────────────
// Fast (180ms) — gets track list, then fetchCaptionContent handles 429 retry.

async function fetchViaAndroid(videoId, version = '19.09.37', sdkVersion = 34) {
  const res = await axios.post(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    {
      videoId,
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: version,
          androidSdkVersion: sdkVersion,
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
        'User-Agent': `com.google.android.youtube/${version} (Linux; U; Android ${sdkVersion >= 34 ? 14 : 11}) gzip`,
        'X-YouTube-Client-Name': '3',
        'X-YouTube-Client-Version': version,
        'X-Goog-Api-Format-Version': '1',
      },
      timeout: 15000,
    }
  );

  const tracks = res.data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) return null;

  const track = pickBestTrack(tracks);
  if (!track?.baseUrl) return null;

  console.log(
    `[Cascade] ANDROID/${version}: ${tracks.length} tracks, using "${track.languageCode}" ${track.kind === 'asr' ? '(auto)' : '(manual)'}`
  );
  return fetchCaptionContent(track.baseUrl, videoId);
}

// ─── Strategy 2: youtubei.js ──────────────────────────────────────────────────
// Full session-based approach — also tries the transcript panel.

async function fetchViaYoutubei(videoId) {
  const yt = await getInnertube();
  const info = await yt.getInfo(videoId);

  // Try transcript panel first (best format)
  try {
    const ti = await info.getTranscript();
    const segments = ti?.transcript?.content?.body?.initial_segments;
    if (segments?.length) {
      const text = segments
        .map(s => s.snippet?.runs?.map(r => r.text).join('') || '')
        .filter(Boolean)
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (text.length > 30) {
        console.log(`[Cascade] youtubei.js transcript panel: ${text.length} chars`);
        return text;
      }
    }
  } catch (_) {}

  // Fall back to caption tracks
  const tracks = info.captions?.caption_tracks;
  if (!tracks?.length) return null;

  const track =
    tracks.find(t => t.language_code?.startsWith('en') && t.kind !== 'asr') ||
    tracks.find(t => t.language_code?.startsWith('en')) ||
    tracks[0];

  if (!track?.base_url) return null;

  console.log(
    `[Cascade] youtubei.js: ${tracks.length} tracks, using "${track.language_code}" ${track.kind === 'asr' ? '(auto)' : '(manual)'}`
  );
  return fetchCaptionContent(track.base_url, videoId);
}

// ─── Strategy 3: Page scrape ──────────────────────────────────────────────────

async function fetchViaPageScrape(videoId) {
  const res = await axios.get(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

  console.log(`[Cascade] Page scrape: ${tracks.length} tracks, using "${track.languageCode}"`);

  return fetchCaptionContent(track.baseUrl, videoId);
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
    { name: 'ANDROID v19',  fn: () => fetchViaAndroid(videoId, '19.09.37', 34) },
    { name: 'youtubei.js',  fn: () => fetchViaYoutubei(videoId) },
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
      console.log(`[Cascade] ${name} failed: ${err.message}`);
    }
  }

  const err = new Error(
    'No captions found for this video. Auto-generated captions may be disabled or the video is restricted. Please paste the transcript manually.'
  );
  err.code = 'NO_TRANSCRIPT';
  throw err;
}

module.exports = { fetchTranscript, extractVideoId, isValidYouTubeUrl };
