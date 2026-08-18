// ============================================================
// LLM copywriter — generates ad-copy variations from a brief.
// Uses your own API key (Anthropic by default). This is the
// "creative generation" layer; the math/decisions stay
// deterministic elsewhere. If no key is set, it's disabled.
// ============================================================
import { config, llmReady } from "./config.js";

// Ask the model for N {headline, primaryText} variations and parse JSON.
export async function generateCopy({ product = "", offer = "", angle = "", audience = "", tone = "ישיר ומשכנע", language = "עברית", count = 5 } = {}) {
  if (!llmReady()) throw new Error("שכבת ה-LLM לא מוגדרת — הזן LLM_API_KEY ו-LLM_MODEL ב-Railway");
  count = Math.max(1, Math.min(10, parseInt(count) || 5));

  const prompt =
`אתה קופירייטר בכיר של direct-response ל-Meta Ads עם 10 שנות ניסיון.
כתוב ${count} וריאציות מודעה ב${language}, בטון ${tone}.
מוצר/שירות: ${product || "—"}
הצעה: ${offer || "—"}
זווית/מסר: ${angle || "—"}
קהל יעד: ${audience || "—"}

חוקים: כותרת קצרה וקולעת (עד ~40 תווים), טקסט ראשי שעוצר גלילה עם הוק חזק ב-3 השניות הראשונות וקריאה לפעולה. בלי הבטחות מוגזמות שיפרו את מדיניות Meta.
החזר אך ורק JSON תקין במבנה: [{"headline":"...","primaryText":"..."}], בלי טקסט נוסף.`;

  const provider = config.llmProvider || "anthropic";
  let text = "";
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": config.llmApiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: config.llmModel, max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await res.json();
    if (j.error) throw new Error("LLM: " + (j.error.message || JSON.stringify(j.error)));
    text = (j.content && j.content[0] && j.content[0].text) || "";
  } else if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + config.llmApiKey, "content-type": "application/json" },
      body: JSON.stringify({ model: config.llmModel, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await res.json();
    if (j.error) throw new Error("LLM: " + (j.error.message || JSON.stringify(j.error)));
    text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  } else {
    throw new Error("ספק LLM לא נתמך: " + provider);
  }

  return parseVariations(text, count);
}

function parseVariations(text, count) {
  // extract the JSON array even if the model wrapped it in prose/```json fences
  let s = text.trim().replace(/^```(json)?/i, "").replace(/```$/,"").trim();
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  let arr;
  try { arr = JSON.parse(s); } catch (e) { throw new Error("לא הצלחתי לפענח את התשובה מה-LLM"); }
  if (!Array.isArray(arr)) throw new Error("תשובת ה-LLM אינה רשימה");
  return arr.filter((x) => x && (x.headline || x.primaryText))
    .slice(0, count)
    .map((x) => ({ headline: String(x.headline || "").slice(0, 120), primaryText: String(x.primaryText || "").slice(0, 600) }));
}
