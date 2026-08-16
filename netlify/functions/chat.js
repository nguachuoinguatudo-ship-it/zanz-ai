exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY belum diset di server' }) };
  }
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Bad Request' };
  }
  const model = String(body.model || 'gemini-2.5-flash');
  const payload = {
    contents: body.contents || []
  };
  if (body.generationConfig) payload.generationConfig = body.generationConfig;

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

  const text = await upstream.text();

  return {
    statusCode: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    },
    body: text
  };
};