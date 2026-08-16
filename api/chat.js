export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) {
    res.status(500).json({ error: 'GEMINI_API_KEY belum diset di server' });
    return;
  }
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).end();
    return;
  }
  const model = String((body && body.model) || 'gemini-2.5-flash');
  const payload = {
    contents: (body && body.contents) || [],
    generationConfig: (body && body.generationConfig) || undefined
  };
  if (!payload.generationConfig) delete payload.generationConfig;

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) +
    ':streamGenerateContent?alt=sse';

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key
    },
    body: JSON.stringify(payload)
  });

  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}