const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-opus-4-6';

// ---------------------------------------------------------------------------
// Platform configuration — each entry defines metadata + prompt builder
// ---------------------------------------------------------------------------
const PLATFORM_CONFIGS = {
  instagram_caption: {
    name: 'Instagram Caption',
    maxTokens: 600,
    buildPrompt: (analysis, content, tone) =>
      `Write an Instagram caption for this content. Start with a strong hook (first line must stop the scroll). Use 3–5 short, punchy paragraphs separated by blank lines. End with a clear, single-line CTA. Include 8–12 relevant hashtags on a new line after the caption body.

Tone: ${tone}

Content analysis:
${JSON.stringify(analysis, null, 2)}

Full source content:
${content}`,
  },

  instagram_reel: {
    name: 'Instagram Reel Script',
    maxTokens: 700,
    buildPrompt: (analysis, content, tone) =>
      `Write a short-form video script for Instagram Reels (45–60 seconds when spoken at a natural pace). Format as three clearly labelled sections on their own lines:

[HOOK] — first 3 seconds: a bold statement, provocative question, or scroll-stopping opening line
[BODY] — core value in 3–4 punchy, deliverable points
[CTA] — single clear next action for the viewer

Tone: ${tone}

Content analysis:
${JSON.stringify(analysis, null, 2)}

Source content:
${content}`,
  },

  tiktok_script: {
    name: 'TikTok Script',
    maxTokens: 600,
    buildPrompt: (analysis, content, tone) =>
      `Write a TikTok script (30–45 seconds). Open with a pattern interrupt in the first 2 words. Every sentence is a new thought — fast-paced, punchy delivery. End with a curiosity loop or strong CTA. Label sections as:

[HOOK]
[BODY]
[CTA]

Tone: ${tone}

Source content:
${content}`,
  },

  youtube_shorts: {
    name: 'YouTube Shorts Script',
    maxTokens: 600,
    buildPrompt: (analysis, content, tone) =>
      `Write a YouTube Shorts script (50–60 seconds). Start with a strong verbal hook that references a relatable problem or bold claim. Deliver quick, high-value payoff. End with a subscribe CTA. Label sections:

[HOOK]
[BODY]
[CTA]

Tone: ${tone}

Source content:
${content}`,
  },

  twitter_thread: {
    name: 'Twitter/X Thread',
    maxTokens: 1200,
    buildPrompt: (analysis, content, tone) =>
      `Write a Twitter/X thread of 8–12 tweets.

Tweet 1 is the hook — bold, specific, creates urgency to read on. No "I'm going to explain..." openers.
Tweets 2–10: one tight idea per tweet, short paragraphs, no wasted words.
Final tweet: punchy summary + CTA.

Number each tweet exactly like: 1/ 2/ 3/ etc. on its own line before each tweet.

Tone: ${tone}

Content analysis:
${JSON.stringify(analysis, null, 2)}

Source content:
${content}`,
  },

  linkedin_post: {
    name: 'LinkedIn Post',
    maxTokens: 800,
    buildPrompt: (analysis, content, tone) =>
      `Write a LinkedIn post. Rules:
- No hashtag spam (max 3, at end if used at all)
- First line is a single-line hook — never start with "I'm excited to share" or "Thrilled to announce"
- Short punchy paragraphs with blank lines between them
- 200–400 words total
- Personal, direct, insight-driven — reads like a smart founder wrote it
- End with an open question to drive comments

Tone: ${tone}

Content analysis:
${JSON.stringify(analysis, null, 2)}

Source content:
${content}`,
  },

  linkedin_article: {
    name: 'LinkedIn Article',
    maxTokens: 2000,
    buildPrompt: (analysis, content, tone) =>
      `Write a full LinkedIn Article (800–1200 words). Structure:
- Compelling headline (write it as the first line)
- Introduction that clearly states the problem or opportunity
- 3–4 body sections each with an H2 heading (## format) and substantive insights
- Real frameworks, not platitudes
- Conclusion with a clear, memorable takeaway
- Reads like a thoughtful founder wrote it, not a content marketer

Tone: ${tone}

Content analysis:
${JSON.stringify(analysis, null, 2)}

Source content:
${content}`,
  },

  newsletter: {
    name: 'Newsletter Section',
    maxTokens: 900,
    buildPrompt: (analysis, content, tone) =>
      `Write a newsletter section (300–500 words). Style: conversational but substantive — feels like a trusted, smart friend sharing something genuinely useful. Deliver one key insight, explained well, with a real-world application or example. End with a reflective question or thought for the reader.

Tone: ${tone}

Content analysis:
${JSON.stringify(analysis, null, 2)}

Source content:
${content}`,
  },

  podcast_notes: {
    name: 'Podcast Show Notes',
    maxTokens: 1000,
    buildPrompt: (analysis, content, tone) =>
      `Write podcast show notes. Include all of these sections:

Episode Summary (2–3 sentences)

Key Takeaways (5 bullet points, each starting with an action verb)

Timestamps (estimate based on pacing — label as "(approx)" and assume natural speaking pace of ~130 words per minute)

Notable Quotes (3 direct quotes from the content that are compelling standalone)

Resources Mentioned (extract any tools, books, people, or links referenced)

Tone: ${tone}

Source content:
${content}`,
  },

  blog_summary: {
    name: 'Blog Post Summary',
    maxTokens: 700,
    buildPrompt: (analysis, content, tone) =>
      `Write a blog post introduction/summary section (200–300 words). Requirements:
- First sentence immediately names the core problem or opportunity
- Clearly previews what the reader will learn
- Persuasive enough to make them keep reading
- SEO-aware but reads naturally — not stuffed with keywords
- Ends with a transition sentence that flows into the body

Tone: ${tone}

Content analysis:
${JSON.stringify(analysis, null, 2)}

Source content:
${content}`,
  },

  email_subjects: {
    name: 'Email Subject Lines',
    maxTokens: 400,
    buildPrompt: (analysis, content, tone) =>
      `Write 5 email subject lines for this content. One of each style:
1. Curiosity gap (make them need to know)
2. Direct benefit (clear value proposition)
3. Number-led (specific, credible)
4. Provocative or contrarian (challenges an assumption)
5. Story-led (hints at a narrative)

Rules: No clickbait. Under 50 characters each. Output ONLY the 5 subject lines numbered 1–5, one per line, no other text.

Source content:
${content}`,
  },

  quote_cards: {
    name: 'Quote Cards',
    maxTokens: 500,
    buildPrompt: (analysis, content, tone) =>
      `Extract 5 powerful, visually standalone quotes from this content. Each quote must:
- Work completely on its own without any context
- Be punchy and thought-provoking
- Be 1–3 sentences maximum
- Be a direct quote or paraphrase from the content — not invented

Output ONLY a numbered list 1–5 of the quotes. No labels, no commentary, no quotation marks around the list items.

Source content:
${content}`,
  },
};

// ---------------------------------------------------------------------------
// Content analysis — extracts structure for injection into platform prompts
// ---------------------------------------------------------------------------
async function analyseContent(content) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system:
      'You are a content analyst. Return only valid JSON with no markdown formatting, no code blocks, no backticks. Just the raw JSON object.',
    messages: [
      {
        role: 'user',
        content: `Analyse this content and return a JSON object with exactly these fields:
{
  "mainTopic": "one sentence describing what this content is about",
  "keyIdeas": ["idea 1", "idea 2", "idea 3"],
  "sourceTone": "description of the tone (e.g. conversational, authoritative, motivational)",
  "targetAudience": "who this content is aimed at",
  "hooks": ["compelling hook option 1", "hook 2", "hook 3", "hook 4", "hook 5"]
}

Content to analyse (first 6000 chars):
${content.substring(0, 6000)}`,
      },
    ],
  });

  const text = response.content[0].text.trim();

  try {
    return JSON.parse(text);
  } catch {
    // Fallback if JSON parse fails — extract from markdown code block
    const match = text.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (match) return JSON.parse(match[1]);
    // Last resort: return a minimal analysis object
    return {
      mainTopic: 'Content analysis unavailable',
      keyIdeas: [],
      sourceTone: 'neutral',
      targetAudience: 'general audience',
      hooks: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Platform generation with retry logic
// ---------------------------------------------------------------------------
async function callWithRetry(params, onRetry, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create(params);
      return response.content[0].text;
    } catch (err) {
      const isRateLimit = err.status === 429;
      const isRetryable = isRateLimit || err.status === 529;

      if (isRetryable && attempt < maxRetries) {
        if (onRetry) onRetry(attempt + 1);
        const delay = 5000 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}

async function generateForPlatform(platformId, analysis, content, tone, voiceContext, onRetry) {
  const config = PLATFORM_CONFIGS[platformId];
  if (!config) throw new Error(`Unknown platform: ${platformId}`);

  const voiceLine = voiceContext
    ? `\nVoice & style context: ${voiceContext}`
    : '\nAdapt to the tone and voice implied by the source content.';

  const system = `You are an expert content strategist and copywriter who specialises in repurposing longform content for social media and digital platforms. You understand platform-specific best practices, algorithm behaviour, and audience psychology for each channel.${voiceLine}

Always output ONLY the requested content format with no preamble, explanation, or meta-commentary. Your output goes directly into a publishing tool.`;

  const userPrompt = config.buildPrompt(analysis, content, tone);

  return callWithRetry(
    {
      model: MODEL,
      max_tokens: config.maxTokens,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    },
    onRetry
  );
}

module.exports = { analyseContent, generateForPlatform, PLATFORM_CONFIGS };
