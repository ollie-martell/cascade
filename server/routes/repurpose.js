const express = require('express');
const router = express.Router();
const { repurpose } = require('../controllers/repurposeController');

router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug endpoint — hits each transcript strategy and reports results
router.get('/debug/transcript', async (req, res) => {
  const videoId = req.query.v || 'dQw4w9WgXcQ';
  const axios = require('axios');
  const result = { videoId, steps: {} };

  // 1. youtubei.js session + getInfo
  try {
    const { Innertube } = require('youtubei.js');
    const t0 = Date.now();
    const yt = await Innertube.create({ generate_session_locally: true });
    result.steps.innertube_create_ms = Date.now() - t0;

    const t1 = Date.now();
    const info = await yt.getInfo(videoId);
    result.steps.get_info_ms = Date.now() - t1;

    const tracks = info.captions?.caption_tracks || [];
    result.steps.track_count = tracks.length;
    result.steps.first_track_lang = tracks[0]?.language_code ?? null;
    result.steps.first_track_url_prefix = tracks[0]?.base_url?.substring(0, 100) ?? null;

    if (tracks[0]?.base_url) {
      try {
        const capUrl = tracks[0].base_url + '&fmt=json3';
        const t2 = Date.now();
        const capRes = await axios.get(capUrl, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        result.steps.caption_fetch_ms = Date.now() - t2;
        result.steps.caption_events = capRes.data?.events?.length ?? 0;
        const sample = (capRes.data?.events || [])
          .filter(e => Array.isArray(e.segs))
          .slice(0, 3)
          .map(e => e.segs.map(s => s.utf8 || '').join(''))
          .join(' ');
        result.steps.caption_sample = sample.substring(0, 150);
      } catch (e) {
        result.steps.caption_fetch_error = e.message;
      }
    }
  } catch (e) {
    result.steps.youtubei_error = e.message;
  }

  // 2. Bare ANDROID v19 (no session)
  try {
    const t = Date.now();
    const r = await axios.post(
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      {
        videoId,
        context: { client: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 34, hl: 'en', gl: 'US' } },
        contentCheckOk: true, racyCheckOk: true,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip',
          'X-YouTube-Client-Name': '3',
          'X-YouTube-Client-Version': '19.09.37',
        },
        timeout: 10000,
      }
    );
    const tracks = r.data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    result.steps.android_tracks = tracks.length;
    result.steps.android_ms = Date.now() - t;
  } catch (e) {
    result.steps.android_error = e.message;
  }

  res.json(result);
});

router.post('/repurpose', repurpose);

module.exports = router;
