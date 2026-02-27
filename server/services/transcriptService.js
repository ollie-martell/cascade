/**
 * YouTube transcript fetching via the InnerTube ANDROID client API.
 *
 * Strategy 1: InnerTube ANDROID v19 (primary — confirmed working)
 * Strategy 2: InnerTube ANDROID v18 (fallback)
 * Strategy 3: Page scrape with cookie forwarding (last resort)
 */

const axios = require('axios');

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

// ─── Caption URL fetcher ──────────────────────────────────────────────────────

async function fetchCaptionTrack(baseUrl) {
  const u = new URL(baseUrl);
  u.searchParams.set('fmt', 'json3');

  const res = await axios.get(u.toString(), {
    timeout: 12000,
    headers: {
      'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip',
    },
  });

  const data = res.data;
  if (data?.events) {
    const text = data.events
      .filter(e => Array.isArray(e.segs))
      .map(e =>
        e.segs
          .map(s => (s.utf8 || '').replace(/\n/g, ' '))
          .join('')
          .trim()
      )
      .filter(t => t && t !== '[♪♪♪]' && t !== '[Music]' && t !== '[Applause]')
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (text.length > 30) return text;
  }

  // Fallback: raw XML
  const xmlRes = await axios.get(baseUrl, {
    timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
  });

  const xml = xmlRes.data;
  const texts = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
    if (t) texts.push(t);
  }
  return texts.join(' ').replace(/\s{2,}/g, ' ').trim();
}

// ─── InnerTube ANDROID client ─────────────────────────────────────────────────

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
    `[Cascade] ANDROID/${version}: ${tracks.length} tracks, using "${track.languageCode}" ${track.kind === 'asr' ? '(auto-generated)' : '(manual)'}`
  );
  return fetchCaptionTrack(track.baseUrl);
}

// ─── Page scrape fallback ─────────────────────────────────────────────────────

async function fetchViaPageScrape(videoId) {
  const res = await axios.get(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
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

  console.log(`[Cascade] PAGE SCRAPE: ${tracks.length} tracks, using "${track.languageCode}"`);

  // Fetch the caption URL with the same session cookies
  const u = new URL(track.baseUrl);
  u.searchParams.set('fmt', 'json3');
  const capRes = await axios.get(u.toString(), {
    timeout: 12000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Cookie': cookies,
      'Referer': 'https://www.youtube.com/',
    },
  });

  const data = capRes.data;
  if (data?.events) {
    const text = data.events
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
    { name: 'ANDROID v19', fn: () => fetchViaAndroid(videoId, '19.09.37', 34) },
    { name: 'ANDROID v18', fn: () => fetchViaAndroid(videoId, '18.11.34', 32) },
    { name: 'Page scrape', fn: () => fetchViaPageScrape(videoId) },
  ];

  for (const { name, fn } of strategies) {
    try {
      const transcript = await fn();
      if (transcript && transcript.trim().length > 30) {
        console.log(`[Cascade] ✓ ${name} — ${transcript.length} chars`);
        return transcript;
      }
      console.log(`[Cascade] ${name} returned empty result, trying next...`);
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
