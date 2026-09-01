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

export function cleanTerm(input: unknown): string {
  const term = String(input ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
