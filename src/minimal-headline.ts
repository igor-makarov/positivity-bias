import { plainText } from './text.ts';

/** Remove standalone publisher click prompts while preserving every factual clause.
 * This is a candidate only: full article context and native validation are required.
 */
export function minimalHeadline(original: string): string | null {
  const clean = plainText(original, 300);
  const edited = clean
    .replace(/\s*[|–—]\s*(?:צפו(?: בסרטון)?|תיעוד|כל הפרטים|לכל הפרטים|כל מה שצריך לדעת|התיעוד המלא|הסיפור המלא|התחזית המלאה)\s*$/u, '')
    .trim();
  return edited && edited !== clean ? edited : null;
}
