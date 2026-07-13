/**
 * Cloudflare Worker: 태국어<->한국어 교실 번역 프록시.
 *
 * 이 Worker가 하는 일은 단 하나, "OpenAI API 키를 절대 브라우저에 노출하지 않고
 * 대신 번역을 대행해주는 것" 뿐입니다. index.html은 이 Worker의 주소만 알고 있고,
 * OPENAI_API_KEY는 오직 Cloudflare의 암호화된 시크릿 저장소에만 존재합니다
 * (wrangler secret put OPENAI_API_KEY 로 등록, 코드/저장소 어디에도 평문으로 남지 않음).
 *
 * 요청: POST { text: string, direction: 'teacher' | 'parent' }
 *   - direction 'teacher' -> 한국어 원문을 정중한 태국어로 번역
 *   - direction 'parent'  -> 태국어 원문(서툰 표현 포함)을 정중한 한국어 존댓말로 번역
 * 응답: { translatedText: string } 또는 { error: string }
 */

const TEACHER_TO_PARENT_PROMPT = `
You are a professional Korean-to-Thai translator for a multicultural elementary
school classroom. The input is a message from a Korean teacher addressed to a
Thai-speaking parent. Translate it into natural, warm, and RESPECTFUL Thai using
polite particles (ค่ะ/ครับ as appropriate) and a register appropriate for a
teacher addressing a student's parent. Preserve all factual details exactly
(dates, times, item names, amounts). Do not add information that is not in the
original. Output ONLY the Thai translation, no explanations, no quotation marks.
`.trim();

const PARENT_TO_TEACHER_PROMPT = `
You are a professional Thai-to-Korean translator for a multicultural elementary
school classroom. The input is a message from a Thai-speaking parent, possibly
written in imperfect, informal, or broken Thai. Infer the parent's intended
meaning as best you can and translate it into natural, polite Korean using
formal 존댓말 (해요체/합쇼체 register), suitable for a parent addressing a
teacher. If the Thai is ambiguous, translate the most likely intended meaning
rather than a literal word-for-word rendering. Output ONLY the Korean
translation, no explanations, no quotation marks.
`.trim();

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, origin);
    }

    const { text, direction } = body || {};
    if (typeof text !== 'string' || text.length === 0 || text.length > 2000) {
      return json({ error: 'text must be a non-empty string under 2000 characters' }, 400, origin);
    }
    if (direction !== 'teacher' && direction !== 'parent') {
      return json({ error: "direction must be 'teacher' or 'parent'" }, 400, origin);
    }

    const systemPrompt = direction === 'teacher' ? TEACHER_TO_PARENT_PROMPT : PARENT_TO_TEACHER_PROMPT;

    let openaiResp;
    try {
      openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          temperature: 0.3,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
          ]
        })
      });
    } catch (err) {
      return json({ error: `OpenAI request failed: ${err.message}` }, 502, origin);
    }

    if (!openaiResp.ok) {
      const detail = await openaiResp.text();
      return json({ error: `OpenAI API error ${openaiResp.status}: ${detail}` }, 502, origin);
    }

    const data = await openaiResp.json();
    const translatedText = data.choices?.[0]?.message?.content?.trim();
    if (!translatedText) {
      return json({ error: 'Empty translation result' }, 502, origin);
    }

    return json({ translatedText }, 200, origin);
  }
};
