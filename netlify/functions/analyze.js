exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { systemPrompt, userText, image1, image2, minimaxKey, minimaxGroupId, forceMinimax } = body;

  if (!forceMinimax && process.env.GEMINI_API_KEY) {
    try {
      const result = await callGemini(systemPrompt, userText, image1, image2);
      return ok(result);
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
    return ok(result);
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

const ok = (data) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch {}
  let start = clean.indexOf('{'), depth = 0, end = -1;
  if (start !== -1) {
    for (let i = start; i < clean.length; i++) {
      if (clean[i] === '{') depth++;
      else if (clean[i] === '}' && --depth === 0) { end = i; break; }
    }
  }
  if (end !== -1) try { return JSON.parse(clean.slice(start, end + 1)); } catch {}
  throw new Error('Could not parse AI response.');
}

async function callGemini(systemPrompt, userText, image1, image2) {
  const parts = [];
  if (image1) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image1.split(',')[1] } });
  if (image2) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image2.split(',')[1] } });
  parts.push({ text: userText });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: 500, temperature: 0.1 }
      })
    }
  );

  if (res.status === 429) {
    const err = new Error('Gemini rate limited');
    err.isRateLimit = true;
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini ${res.status}: ${txt.slice(0, 150)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseJSON(text);
}

async function callMiniMax(systemPrompt, userText, image1, image2, apiKey, groupId) {
  const hasImages = !!(image1 || image2);
  const model = hasImages ? 'MiniMax-VL-01' : 'abab6.5s-chat';

  let userMsg;
  if (hasImages) {
    const content = [];
    if (image1) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image1.split(',')[1]}` } });
    if (image2) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image2.split(',')[1]}` } });
    content.push({ type: 'text', text: userText });
    userMsg = content;
  } else {
    userMsg = userText;
  }

  const url = `https://api.minimaxi.chat/v1/text/chatcompletion_v2${groupId ? '?GroupId=' + groupId : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: 500, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }] })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`MiniMax ${res.status}: ${txt.slice(0, 150)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return parseJSON(text);
}
