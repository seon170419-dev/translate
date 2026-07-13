/**
 * Cloudflare Worker: 태국어<->한국어 교실 번역 프록시.
 *
 * 이 Worker가 하는 일은 단 하나, "OpenAI API 키를 절대 브라우저에 노출하지 않고
 * 대신 번역을 대행해주는 것" 뿐입니다. index.html은 이 Worker의 주소만 알고 있고,
 * OPENAI_API_KEY는 오직 Cloudflare의 암호화된 시크릿 저장소에만 존재합니다
 * (wrangler secret put OPENAI_API_KEY 로 등록, 코드/저장소 어디에도 평문으로 남지 않음).
 *
 * 요청: POST { text: string, direction: 'teacherToParent' | 'parentToTeacher' | 'teacherToStudent' | 'studentToTeacher' }
 *   - teacherToParent -> 한국어 원문을 정중한 태국어로 번역 (교사 -> 학부모)
 *   - parentToTeacher -> 태국어 원문(서툰 표현 포함)을 정중한 한국어 존댓말로 번역 (학부모 -> 교사)
 *   - teacherToStudent -> 한국어 원문을 다정하고 쉬운 태국어로 번역 (교사 -> 학생)
 *   - studentToTeacher -> 태국어 원문(아동의 표현)을 자연스러운 한국어로 번역 (학생 -> 교사)
 * 응답: { translatedText: string, englishGloss: string } 또는 { error: string }
 *
 * englishGloss는 교사/학부모/학생이 태국어나 한국어를 모국어로 읽지 못하더라도 번역이
 * 원래 뜻과 맞는지 영어로 한 번 더 대조 확인할 수 있도록 함께 반환하는 참고용 영어 대역문입니다.
 */

const JSON_OUTPUT_INSTRUCTION = `
Respond ONLY with a single JSON object with exactly two keys, no other text,
explanation, or markdown formatting:
{
  "translatedText": "<the translation>",
  "englishGloss": "<a plain English translation of the same original message, for verification purposes only>"
}
`.trim();

const FAITHFULNESS_RULE = `
CRITICAL: Translate ONLY what is actually written in the original message.
Never add, invent, expand, or guess at content that is not explicitly present
in the original. Do not turn a short phrase or single word into a longer
sentence, and do not add extra context, reasons, feelings, or scenarios that
the original does not state. The length and content of the translation must
correspond directly to the original — a one-word message must translate to a
one-word (or equivalently minimal) translation. You may only adjust grammar,
word order, and polite sentence-ending particles as needed for natural,
correct phrasing in the target language.
`.trim();

const TEACHER_TO_PARENT_PROMPT = `
You are a professional Korean-to-Thai translator for a multicultural elementary
school classroom. The input is a message from a Korean teacher addressed to a
Thai-speaking parent. Translate it into natural, warm, and RESPECTFUL Thai using
polite particles (ค่ะ/ครับ as appropriate) and a register appropriate for a
teacher addressing a student's parent. Preserve all factual details exactly
(dates, times, item names, amounts).

${FAITHFULNESS_RULE}

${JSON_OUTPUT_INSTRUCTION}
`.trim();

const PARENT_TO_TEACHER_PROMPT = `
You are a professional Thai-to-Korean translator for a multicultural elementary
school classroom. The input is a message from a Thai-speaking parent, possibly
written in imperfect or informal Thai. Translate it into natural, polite Korean
using formal 존댓말 (해요체/합쇼체 register), suitable for a parent addressing a
teacher. Correct only obvious grammar/spelling issues in your understanding of
the source text; do not reinterpret or embellish the message's content.

${FAITHFULNESS_RULE}

${JSON_OUTPUT_INSTRUCTION}
`.trim();

const TEACHER_TO_STUDENT_PROMPT = `
You are a professional Korean-to-Thai translator for a multicultural elementary
school classroom. The input is a message from a Korean teacher addressed
directly to a young Thai-speaking student. Translate it into warm, friendly
Thai using simple vocabulary appropriate for a child, while still being polite
(ค่ะ/ครับ as appropriate). Preserve all factual details exactly (dates, times,
item names, amounts).

${FAITHFULNESS_RULE}

${JSON_OUTPUT_INSTRUCTION}
`.trim();

const STUDENT_TO_TEACHER_PROMPT = `
You are a professional Thai-to-Korean translator for a multicultural elementary
school classroom. The input is a message from a young Thai-speaking student,
possibly written in simple, informal, or childlike Thai. Translate it into
natural, friendly Korean that still reads respectfully to the teacher (light
해요체 register is fine), keeping the simplicity and tone of a child's message
rather than making it sound overly formal or adult. Correct only obvious
grammar/spelling issues in your understanding of the source text; do not
reinterpret or embellish the message's content.

${FAITHFULNESS_RULE}

${JSON_OUTPUT_INSTRUCTION}
`.trim();

const PROMPTS_BY_DIRECTION = {
  teacherToParent: TEACHER_TO_PARENT_PROMPT,
  parentToTeacher: PARENT_TO_TEACHER_PROMPT,
  teacherToStudent: TEACHER_TO_STUDENT_PROMPT,
  studentToTeacher: STUDENT_TO_TEACHER_PROMPT
};

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
    const systemPrompt = PROMPTS_BY_DIRECTION[direction];
    if (!systemPrompt) {
      return json({ error: "direction must be one of teacherToParent, parentToTeacher, teacherToStudent, studentToTeacher" }, 400, origin);
    }

    let openaiResp;
    try {
      openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.3,
          response_format: { type: 'json_object' },
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
    const rawContent = data.choices?.[0]?.message?.content;
    if (!rawContent) {
      return json({ error: 'Empty translation result' }, 502, origin);
    }

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return json({ error: 'Failed to parse translation JSON' }, 502, origin);
    }

    const translatedText = typeof parsed.translatedText === 'string' ? parsed.translatedText.trim() : '';
    const englishGloss = typeof parsed.englishGloss === 'string' ? parsed.englishGloss.trim() : '';
    if (!translatedText) {
      return json({ error: 'Empty translation result' }, 502, origin);
    }

    return json({ translatedText, englishGloss }, 200, origin);
  }
};
