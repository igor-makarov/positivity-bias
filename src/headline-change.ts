import { plainText } from './text.ts';

// Cosmetic changes to quotation marks, separators, spacing or bidi controls are
// not a rewrite. Word order and factual/wording changes remain distinguishable.
export function headlineWords(value: string): string {
  return plainText(value, 300).normalize('NFKC')
    .replace(/\p{M}/gu, '')
    .match(/[\p{L}\p{N}]+/gu)?.join(' ').toLocaleLowerCase('he') || '';
}
export function meaningfulRewrite(original: string, headline: string): boolean {
  return headlineWords(original) !== headlineWords(headline);
}
