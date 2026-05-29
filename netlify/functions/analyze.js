exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { idToken, systemPrompt, userText, image1, image2, minimaxKey, minimaxGroupId, forceMinimax } = body;

  // Verify Firebase ID token before doing anything
  if (!idToken) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  try {
    await verifyFirebaseToken(idToken);
  } catch (e) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: ' + e.message }) };
  }

  if (!forceMinimax && process.env.GEMINI_API_KEY) {
    try {
      const result = await callGemini('gemini-2.5-flash', systemPrompt, userText, image1, image2);
      return ok({ ...result, _provider: 'Gemini 2.5 Flash' });
    } catch (e) {
      if (!e.isRateLimit) return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
      // rate limited — try Gemini 3.1 Flash Lite
    }
    try {
      const result = await callGemini('gemini-3.1-flash-lite', systemPrompt, userText, image1, image2);
      return ok({ ...result, _provider: 'Gemini 3.1 Flash Lite' });
    } catch (e) {
      if (!e.isRateLimit) return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
      // rate limited — fall through to MiniMax
    }
  }

  if (!minimaxKey) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Gemini rate limited and no MiniMax key configured. Add a MiniMax key in Settings.' }) };
  }

  try {
    const result = await callMiniMax(systemPrompt, userText, image1, image2, minimaxKey, minimaxGroupId);
    const note = (image1 || image2) ? ' (vision)' : '';
    return ok({ ...result, _provider: `MiniMax-Text-01${note}` });
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

const ok = (data) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

async function verifyFirebaseToken(idToken) {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error('FIREBASE_API_KEY not configured');
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  const data = await res.json();
  if (!res.ok || !data.users?.length) throw new Error('Invalid or expired token');
}

function parseJSON(text) {
  // Strip thinking blocks and code fences
  const clean = text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  // Direct parse
  try { return JSON.parse(clean); } catch {}

  // Extract every complete {...} candidate, try each from last to first
  // (the real JSON object is always last — after any prose or partial examples)
  const candidates = [];
  let depth = 0, start = -1;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '{') { if (depth++ === 0) start = i; }
    else if (clean[i] === '}' && depth > 0) {
      if (--depth === 0 && start !== -1) { candidates.push(clean.slice(start, i + 1)); start = -1; }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { return JSON.parse(candidates[i]); } catch {}
  }

  throw new Error(`Could not parse AI response. Raw (first 400 chars): ${text.slice(0, 400)}`);
}

async function callGemini(model, systemPrompt, userText, image1, image2) {
  const parts = [];
  if (image1) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image1.split(',')[1] } });
  if (image2) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image2.split(',')[1] } });
  parts.push({ text: userText });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: 4000, temperature: 0 }
      })
    }
  );

  if (res.status === 429 || res.status === 403) {
    const err = new Error(`Gemini ${res.status}`);
    err.isRateLimit = true;
    throw err;
  }
  const geminiRaw = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${geminiRaw.slice(0, 200)}`);
  }

  let data;
  try { data = JSON.parse(geminiRaw); } catch { throw new Error(`Gemini response not JSON: ${geminiRaw.slice(0, 200)}`); }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseJSON(text);
}

async function callMiniMax(systemPrompt, userText, image1, image2, apiKey, groupId) {
  const model = 'MiniMax-Text-01';

  // Build user message content — attempt vision if images provided
  let userContent;
  if (image1 || image2) {
    userContent = [{ type: 'text', text: userText }];
    if (image1) userContent.push({ type: 'image_url', image_url: { url: image1 } });
    if (image2) userContent.push({ type: 'image_url', image_url: { url: image2 } });
  } else {
    userContent = userText;
  }

  const url = `https://api.minimaxi.chat/v1/text/chatcompletion_v2${groupId ? '?GroupId=' + groupId : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }] })
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`MiniMax ${res.status}: ${rawText.slice(0, 200)}`);
  }

  let data;
  try { data = JSON.parse(rawText); } catch { throw new Error(`MiniMax response not JSON: ${rawText.slice(0, 200)}`); }
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`MiniMax empty response: ${rawText.slice(0, 200)}`);
  return parseJSON(text);
}
