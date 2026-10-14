// Source-visible material facts must survive editing, including on cached titles.
// These checks complement model verification; they never fill in missing text.
const HYPE = /הלם|מזעזע|מטלטל|לא תאמינ|קשה להאמין|מדהימ|שערוריי|סנסציי|דרמטי|בלתי נתפס|בלתי יאומן|אסור לפספס|חובה לראות|אי אפשר להתעלם|אכזרי/u;
const ATTRIBUTION = /[\u05d0-\u05ea]["״']?:|(?:^|\s)(?:לפי|לדברי|לטענת|טען|טוען|טענ[וה]|טוענ(?:ים|ות)|אמר[וה]?|אומר(?:ים|ות)?|מסר[וה]?|סיפר[וה]?|מדבר(?:ים|ות)?|דיבר[וה]?|הדגיש[וה]?|תיאר[וה]?|מתאר(?:ים|ות)?|שוחח[וה]?|חש(?:ף|פה|פו))(?:\s|[:,]|ש)|^דיווח[: ,]|דיווח(?:ו|ה)? כי/u;

export function materialHeadlineSafe(original: string, headline: string) {
  const source = String(original || '');
  const result = String(headline || '');
  if (HYPE.test(result)) return false;
  if (/ממונ(?:י|ים|ות).*בטיחות/u.test(source) && !/בטיחות/u.test(result)) return false;
  if (/להשפיע על הבחירות/u.test(source) && !/בחירות/u.test(result)) return false;
  const words = result.replace(/["'״׳]/g, '').match(/[\u05d0-\u05ea]+/gu) || [];
  for (const match of source.matchAll(/([\u05d0-\u05ea]{2,10})["״']([\u05d0-\u05ea]+)/gu)) {
    const prefixes = new Set([match[1]]);
    if (match[1].length >= 4 && /^[ובכלמהש]/u.test(match[1])) prefixes.add(match[1].slice(1));
    for (const prefix of prefixes) {
      // A whole acronym or its full expansion is fine; its bare clipped prefix is not.
      if (words.some((word) => new RegExp(`^[ובכלמהש]{0,2}${prefix}$`, 'u').test(word))) return false;
    }
  }
  if (/הכחיש|מכחיש|הכחשה/u.test(source)
    && !/הכחיש|מכחיש|הכחשה|שלל|שולל|טען.*שלא|טוען.*שלא|אומר.*שלא|לדבריו.*לא|לטענתו.*לא|דחה.*טענ/u.test(result)) return false;
  if (/מפריך|הפריך|הופרך|סותר/u.test(source) && !/מפריך|הפריך|הופרך|סותר|סתיר|בניגוד/u.test(result)) return false;
  if (/נפצע|פצוע|פונה|אושפז|מצב|פציע|נפגע/u.test(source)) {
    if (/אנוש/u.test(source) && !/אנוש|סכנת חיים|נאבק.*חיי/u.test(result)) return false;
    if (!/אנוש/u.test(source) && /במצב קשה|נפצע.*קשה|פצוע.*קשה/u.test(source) && !/קשה/u.test(result)) return false;
  }
  if (/דורש(?:ים|ות|ת)?\s+לפרוש/u.test(source)
    && !/לפרוש|פריש|פרשו|לא להשתתף|להפסיק להשתתף|אי.?השתתפ|לבטל.*השתתפ/u.test(result)) return false;
  if (/גופי השידור הציבורי/u.test(source) && !/שידור|טלוויזי|תקשור/u.test(result)) return false;
  if (/בגלל היותה אישה/u.test(source) && !/בשל.*אישה|בגלל.*אישה|נשים|מגדר|אפליה|מינה/u.test(result)) return false;
  if (/מודים.*תקלה/u.test(source) && !/תקלה|טעות|חריג/u.test(result)) return false;
  if (/רה["״']מ|ראש ממשלה/u.test(source) && /לכהן|כהונה/u.test(result)
    && !/רה["״']?מ|ראש ממשלה|ראשות הממשלה/u.test(result)) return false;
  // Long source quotations are claims/opinions, not permission to assert them as facts.
  const quotes = [...source.matchAll(/["״“]([^"״”]+)["״”]/gu)].map((match) => match[1]);
  if (quotes.some((quote) => quote.trim().split(/\s+/).length >= 4) && !ATTRIBUTION.test(result)) return false;
  return true;
}
