// Gemini REST client with structured JSON output. Zero dependencies.
const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta/models';
const MOCK = !API_KEY;

const mode = () => (MOCK ? 'mock' : MODEL);

/**
 * Ask Gemini for JSON that matches `schema`.
 * @param {object} opts { system, prompt, schema, images: [{mimeType, data(base64)}], temperature }
 */
async function generateJSON({ system, prompt, schema, images = [], temperature = 0.2 }) {
  if (MOCK) throw new Error('Gemini is in mock mode');
  const parts = [{ text: prompt }, ...images.map((img) => ({ inline_data: { mime_type: img.mimeType, data: img.data } }))];
  const body = (withSchema) => ({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: withSchema ? parts : [{ text: `${prompt}\n\nReturn ONLY JSON matching this JSON Schema:\n${JSON.stringify(schema)}` }, ...parts.slice(1)] }],
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
      ...(withSchema ? { responseJsonSchema: schema } : {}),
    },
  });

  let res = await post(body(true));
  // Some models/API versions reject responseJsonSchema — retry with schema embedded in the prompt.
  if (res.status === 400) res = await post(body(false));
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${data.error?.message || JSON.stringify(data).slice(0, 300)}`);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return parseJSON(text);
}

async function post(body) {
  return fetch(`${BASE}/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify(body),
  });
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('Gemini returned non-JSON output');
}

module.exports = { generateJSON, mode, MOCK, MODEL };
