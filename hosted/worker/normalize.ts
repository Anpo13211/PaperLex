export class ValidationError extends Error {
  statusCode: number;
  details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
    this.details = details;
  }
}

// PDF から選択した語には、文末のピリオドや引用符、注記記号、行末ハイフンが混ざる。
// 残したまま辞書を引くと定義が空で返るため、保存前に見出し語の形へ揃える。
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/gu;
const INVISIBLE_CHARACTERS = /[\u00AD\u200B-\u200D\u2060\uFEFF]/gu;
const LEADING_PUNCTUATION = /^[\s"'`()\[\]{}<>«»‹›“”‘’„‚〈〉《》「」『』【】〔〕,;:!?¿¡.…·•*†‡§¶/\\|、。]+/u;
const TRAILING_PUNCTUATION = /[\s"'`()\[\]{}<>«»‹›“”‘’„‚〈〉《》「」『』【】〔〕,;:!?¿¡…·•*†‡§¶/\\|、。\-‐‑‒–—−]+$/u;
const TRAILING_CITATION = /(?:\[[\d\s,;–—-]{1,20}\]|[\u2070-\u209F]+)$/u;

function trimEdgePunctuation(value: string): string {
  let term = value;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = term
      .replace(LEADING_PUNCTUATION, "")
      .replace(TRAILING_CITATION, "")
      .replace(TRAILING_PUNCTUATION, "")
      .trim();
    if (next === term) return term;
    term = next;
  }
  return term;
}

// 文末のピリオドだけを落とし、e.g. や Ph.D. のような省略形はそのまま残す。
function dropSentencePeriod(value: string): string {
  const withoutTrailingDots = value.replace(/\.+$/u, "");
  if (!withoutTrailingDots || withoutTrailingDots.includes(".")) return value;
  return withoutTrailingDots;
}

export function canonicalTerm(input: unknown): string {
  const collapsed = String(input ?? "")
    .normalize("NFKC")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(INVISIBLE_CHARACTERS, "")
    .replace(/\s+/gu, " ")
    .trim();
  return trimEdgePunctuation(dropSentencePeriod(trimEdgePunctuation(collapsed)));
}

export function cleanTerm(input: unknown): string {
  const term = canonicalTerm(input);

  if (!term) throw new ValidationError("単語または熟語を入力してください。");
  if (term.length > 160) throw new ValidationError("単語・熟語は160文字以内にしてください。");
  return term;
}

export function normalizeTerm(term: unknown): string {
  return cleanTerm(term).toLocaleLowerCase("en-US");
}

export function cleanOptionalText(value: unknown, maxLength: number, fieldName: string): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length > maxLength) {
    throw new ValidationError(`${fieldName}は${maxLength}文字以内にしてください。`);
  }
  return text;
}

export function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags = value
    .map((tag) => String(tag).normalize("NFKC").trim())
    .filter(Boolean)
    .map((tag) => tag.slice(0, 40));
  return [...new Set(tags)].slice(0, 20);
}
