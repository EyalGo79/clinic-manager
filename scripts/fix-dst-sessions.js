/**
 * תיקון חד-פעמי: פגישות חוזרות שנוצרו עם באג DST.
 *
 * הרקע: לולאת היצירה קידמה שבוע עם setDate(+7) שרץ בזמן השרת (UTC). כך ה-instant
 * ב-UTC נשמר קבוע, ואחרי מעבר לשעון קיץ (ישראל UTC+2 -> UTC+3) שעת-הקיר בישראל
 * קפצה שעה קדימה (10:00 -> 11:00).
 *
 * התיקון: לכל סדרה (series_id), העוגן הוא הפגישה המוקדמת ביותר — שעת-הקיר שלה בישראל
 * נכונה. לכל פגישה מאוחרת יותר מחשבים מחדש מה ה-instant הנכון (אותה שעת-קיר בישראל,
 * מודע ל-DST) ומעדכנים אם שונה. end_time מוזז באותו הפרש כמו start_time.
 *
 * הרצה:
 *   DRY RUN (ברירת מחדל, לא כותב):  node scripts/fix-dst-sessions.js
 *   כתיבה בפועל:                     node scripts/fix-dst-sessions.js --apply
 *
 * דורש DATABASE_URL בסביבה (כמו האפליקציה). משתמש בחיבור ה-DB של האפליקציה.
 */
require('dotenv').config();
const pool = require('../src/config/db');

const APPLY = process.argv.includes('--apply');

// הפרש (בדקות) בין UTC לשעון ישראל ב-instant נתון. חיובי = ישראל לפני UTC.
function israelOffsetMinutes(date) {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const il  = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  return Math.round((il - utc) / 60000);
}

// שעת-הקיר בישראל כמחרוזת להשוואה/דיווח
function ilWall(date) {
  return new Date(date).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', hour12: false });
}

// בהינתן instant עוגן (ששעת-הקיר שלו נכונה) ומספר שבועות קדימה,
// מחזיר את ה-instant הנכון שמשמר את אותה שעת-קיר בישראל.
function expectedInstant(anchor, weeks) {
  const anchorOffset = israelOffsetMinutes(anchor);
  const naive = new Date(anchor.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);
  const naiveOffset = israelOffsetMinutes(naive);
  return new Date(naive.getTime() - (naiveOffset - anchorOffset) * 60000);
}

async function main() {
  console.log(APPLY ? '>>> APPLY MODE — כותב שינויים ל-DB' : '>>> DRY RUN — לא כותב כלום (הוסף --apply כדי לכתוב)');

  // רק סדרות (יש series_id). פגישות בודדות לא הושפעו מהלולאה.
  const { rows } = await pool.query(
    `SELECT id, series_id, start_time, end_time
     FROM sessions
     WHERE series_id IS NOT NULL
     ORDER BY series_id, start_time`
  );

  // קבץ לפי series_id
  const bySeries = new Map();
  for (const r of rows) {
    if (!bySeries.has(r.series_id)) bySeries.set(r.series_id, []);
    bySeries.get(r.series_id).push(r);
  }

  const toFix = [];
  for (const [seriesId, occ] of bySeries) {
    // occ כבר ממוין לפי start_time; העוגן הוא הראשון
    const anchor = new Date(occ[0].start_time);
    for (let i = 1; i < occ.length; i++) {
      const row = occ[i];
      const curStart = new Date(row.start_time);
      const expStart = expectedInstant(anchor, i);
      const diffMs = curStart.getTime() - expStart.getTime();
      if (diffMs !== 0) {
        const curEnd = new Date(row.end_time);
        const newEnd = new Date(curEnd.getTime() - diffMs);
        toFix.push({
          id: row.id,
          seriesId,
          oldStart: curStart, newStart: expStart,
          oldEnd: curEnd, newEnd,
          diffMin: Math.round(diffMs / 60000),
        });
      }
    }
  }

  if (toFix.length === 0) {
    console.log('לא נמצאו פגישות לתיקון. ✔');
    await pool.end();
    return;
  }

  console.log(`\nנמצאו ${toFix.length} פגישות עם שעה שגויה:\n`);
  for (const f of toFix) {
    console.log(
      `  session ${f.id} [series ${f.seriesId.slice(0, 8)}] ` +
      `${ilWall(f.oldStart)} -> ${ilWall(f.newStart)} (${f.diffMin > 0 ? '-' : '+'}${Math.abs(f.diffMin)} דק')`
    );
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — לא בוצעו שינויים. הרץ שוב עם --apply כדי לתקן.`);
    await pool.end();
    return;
  }

  console.log(`\nמעדכן ${toFix.length} שורות...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const f of toFix) {
      await client.query(
        'UPDATE sessions SET start_time = $1, end_time = $2 WHERE id = $3',
        [f.newStart.toISOString(), f.newEnd.toISOString(), f.id]
      );
    }
    await client.query('COMMIT');
    console.log(`✔ עודכנו ${toFix.length} פגישות.`);
    console.log('שים לב: ייתכן שצריך לסנכרן מחדש את גוגל קאלנדר מדף היומן.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('שגיאה — בוצע ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
