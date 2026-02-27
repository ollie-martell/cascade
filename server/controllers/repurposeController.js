const { initSSE } = require('../services/sseService');
const { fetchTranscript, isValidYouTubeUrl } = require('../services/transcriptService');
const { analyseContent, generateForPlatform, PLATFORM_CONFIGS } = require('../services/claudeService');

// ~40k tokens at ~4 chars/token
const MAX_CONTENT_CHARS = 160_000;
// ~50k tokens threshold for warning
const WARN_CONTENT_CHARS = 200_000;

async function repurpose(req, res) {
  const { content, youtubeUrl, platforms, tone, voiceContext } = req.body;

  // ── Validation ────────────────────────────────────────────────────────────
  if (!content && !youtubeUrl) {
    return res.status(400).json({ error: 'Either content or youtubeUrl is required.' });
  }
  if (youtubeUrl && !isValidYouTubeUrl(youtubeUrl)) {
    return res.status(400).json({ error: 'Invalid YouTube URL.' });
  }
  if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
    return res.status(400).json({ error: 'At least one platform must be selected.' });
  }

  // Filter to known platforms only
  const validPlatforms = platforms.filter((p) => PLATFORM_CONFIGS[p]);
  if (validPlatforms.length === 0) {
    return res.status(400).json({ error: 'No recognised platforms selected.' });
  }

  // ── SSE init ──────────────────────────────────────────────────────────────
  const { send, close } = initSSE(res);

  let sourceContent = content || '';
  let trimmed = false;

  try {
    // Step 2 — Extract
    send({ stage: 'extract', progress: 5 });

    // Step 3 — Transcript (YouTube only)
    if (youtubeUrl) {
      send({ stage: 'transcript', progress: 10, sublabel: 'Pulling transcript from YouTube...' });

      try {
        sourceContent = await fetchTranscript(youtubeUrl);
        send({ stage: 'transcript', progress: 15 });
      } catch (err) {
        send({
          stage: 'error',
          code: err.code || 'TRANSCRIPT_ERROR',
          message: err.message || 'Failed to fetch transcript.',
        });
        return close();
      }
    }

    // Length guard
    if (sourceContent.length > WARN_CONTENT_CHARS) {
      trimmed = true;
      send({
        stage: 'warning',
        code: 'CONTENT_TRIMMED',
        message: 'Content was trimmed to fit. Consider splitting into multiple runs.',
      });
      sourceContent = sourceContent.substring(0, MAX_CONTENT_CHARS);
    } else if (sourceContent.length > MAX_CONTENT_CHARS) {
      trimmed = true;
      sourceContent = sourceContent.substring(0, MAX_CONTENT_CHARS);
    }

    // Step 4 — Analyse
    send({ stage: 'analyse', progress: 25 });
    let analysis;
    try {
      analysis = await analyseContent(sourceContent);
    } catch (err) {
      send({
        stage: 'error',
        code: 'ANALYSIS_ERROR',
        message: `Failed to analyse content: ${err.message}`,
      });
      return close();
    }

    // Step 5 — Map
    send({ stage: 'map', progress: 30 });

    // Step 6 — Generate per platform (sequential for granular SSE progress)
    for (let i = 0; i < validPlatforms.length; i++) {
      const platformId = validPlatforms[i];
      const platformConfig = PLATFORM_CONFIGS[platformId];
      const progressStart = 30 + (i / validPlatforms.length) * 55;

      send({
        stage: 'generate',
        platform: platformId,
        platformName: platformConfig.name,
        progress: Math.round(progressStart),
      });

      try {
        const platformContent = await generateForPlatform(
          platformId,
          analysis,
          sourceContent,
          tone || 'Conversational',
          voiceContext || '',
          (attempt) => {
            send({
              stage: 'retrying',
              platform: platformId,
              platformName: platformConfig.name,
              attempt,
              message: `Generation slowed — retrying ${platformConfig.name}...`,
            });
          }
        );

        const progressEnd = 30 + ((i + 1) / validPlatforms.length) * 55;
        send({
          stage: 'result',
          platform: platformId,
          platformName: platformConfig.name,
          content: platformContent,
          progress: Math.round(progressEnd),
        });
      } catch (err) {
        // Non-fatal: report the error but continue with remaining platforms
        send({
          stage: 'platformError',
          platform: platformId,
          platformName: platformConfig.name,
          message: `Could not generate ${platformConfig.name}: ${err.message}`,
        });
      }
    }

    // Step 7 — Polish (short pause for dramatic effect and UX clarity)
    send({ stage: 'polish', progress: 90 });
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Step 8 — Done
    send({ stage: 'done', progress: 100, complete: true, trimmed });
  } catch (err) {
    console.error('[repurposeController] Unhandled error:', err);
    send({
      stage: 'error',
      code: 'SERVER_ERROR',
      message: 'An unexpected error occurred. Please try again.',
    });
  } finally {
    // Small buffer to ensure last event is received before close
    await new Promise((resolve) => setTimeout(resolve, 150));
    close();
  }
}

module.exports = { repurpose };
