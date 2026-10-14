import test from 'node:test';
import assert from 'node:assert/strict';
import { materialHeadlineSafe } from '../src/headline-guard.ts';
import { policyFingerprint, retireStaleRewrites } from '../src/policy.ts';

test('Hebrew acronyms cannot be clipped at a JSON quotation boundary', () => {
  for (const [source, broken, complete] of [
    ['טיסה מניו יורק לנתב"ג', 'טיסה לנתב', 'טיסה לנתב״ג'],
    ['חוקים נגד להט"בים', 'חוקים נגד להט', 'חוקים נגד להט״בים'],
    ['סיוע מנאט"ו', 'סיוע מנאט', 'סיוע מנאטו']
  ]) {
    assert.equal(materialHeadlineSafe(source, broken), false);
    assert.equal(materialHeadlineSafe(source, complete), true);
  }
});
test('A material denial or rebuttal cannot disappear', () => {
  const source = 'נתניהו הודה שראש המודיעין המצרי ביקר לפני 7/10 אך הכחיש שנפגש איתו';
  assert.equal(materialHeadlineSafe(source, 'נתניהו הודה שראש המודיעין המצרי ביקר לפני 7/10'), false);
  assert.equal(materialHeadlineSafe(source, 'נתניהו הודה בביקור ראש המודיעין המצרי לפני 7/10 והכחיש שנפגש איתו'), true);
  assert.equal(materialHeadlineSafe('טענתו שהסרטון מפריך', 'נתניהו הודה בביקור'), false);
});
test('Critical injury and a demand to withdraw retain their material meaning', () => {
  assert.equal(materialHeadlineSafe('בן 9 חודשים נפצע אנושות במשחקייה', 'תינוק בן 9 חודשים פונה לבית חולים'), false);
  assert.equal(materialHeadlineSafe('בן 9 חודשים נפצע אנושות במשחקייה', 'תינוק בן 9 חודשים נפצע אנושות במשחקייה'), true);
  const source = '400 עובדים בגופי השידור הציבורי בהולנד דורשים לפרוש מהאירוויזיון';
  assert.equal(materialHeadlineSafe(source, '400 עובדים בהולנד מחו על האירוויזיון'), false);
  assert.equal(materialHeadlineSafe(source, '400 עובדי השידור הציבורי בהולנד קוראים לפרישה מהאירוויזיון'), true);
});
test('Source hype is removed and quoted claims keep attribution', () => {
  assert.equal(materialHeadlineSafe('הכי אכזרי: מכבי הפסידה', 'מכבי ספגה הפסד אכזרי'), false);
  assert.equal(materialHeadlineSafe('אינפנטינו: "קיבל 1.7 מיליון דולר ללא דיווח לציבור"', 'אינפנטינו קיבל 1.7 מיליון דולר ללא דיווח'), false);
  assert.equal(materialHeadlineSafe('אינפנטינו: "קיבל 1.7 מיליון דולר ללא דיווח לציבור"', 'דיווח: אינפנטינו קיבל 1.7 מיליון דולר ללא דיווח לציבור'), true);
  assert.equal(materialHeadlineSafe('אמילי מואטי: "חליתי בסרטן, החלק הקשה מאחוריי"', 'אמילי מואטי חשפה שהיא חלתה בסרטן'), true);
});
test('A court ruling about serving as prime minister retains the office', () => {
  const source = 'לא מצטער על פסק הדין שאפשר לנתניהו לכהן כרה"מ';
  assert.equal(materialHeadlineSafe(source, 'השופט מלצר: לא מצטער על פסק הדין שמאפשר לנתניהו לכהן'), false);
  assert.equal(materialHeadlineSafe(source, 'השופט מלצר: לא מצטער על פסק הדין שמאפשר לנתניהו לכהן כראש ממשלה'), true);
});
test('Serve-time checks retire malformed current-policy titles without retiring valid siblings', () => {
  const fingerprint = policyFingerprint();
  const common = { rewriteStatus: 'rewritten', rewriteFingerprint: fingerprint };
  const articles = [
    { ...common, id: 'bad', originalHeadline: 'טיסה לנתב"ג', headline: 'טיסה לנתב' },
    { ...common, id: 'good', originalHeadline: 'המועצה אישרה תוכנית חדשה', headline: 'תוכנית חדשה אושרה במועצה' }
  ];
  const result = retireStaleRewrites(articles, fingerprint);
  assert.equal(result.changed, true);
  assert.equal(result.articles[0].headline, articles[0].originalHeadline);
  assert.equal(result.articles[0].rewriteStatus, 'original');
  assert.equal(result.articles[1], articles[1]);
});

test('Professional role qualifiers and an explicit electoral purpose must survive', () => {
  const original = 'הקבלנים: בגלל מחסור בממוני בטיחות אתרי בנייה יושבתו';
  assert.equal(materialHeadlineSafe(original, 'הקבלנים מזהירים על עיכובים במסירת דירות בגלל מחסור בממונים'), false);
  assert.equal(materialHeadlineSafe(original, 'הקבלנים מזהירים מהשבתת אתרים בשל מחסור בממוני בטיחות'), true);
  const purpose = 'איראן משנה טקטיקה כדי להשפיע על הבחירות';
  assert.equal(materialHeadlineSafe(purpose, 'איראן משנה טקטיקה ומגבירה תקיפות'), false);
  assert.equal(materialHeadlineSafe(purpose, 'איראן מאמצת טקטיקה חדשה בניסיון להשפיע על הבחירות'), true);
});
