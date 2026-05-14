const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { isAdmin, isAdminOrTherapist } = require('../middleware/auth');
const { upsertGoogleEvent, deleteGoogleEvent } = require('./calendar');

const BUFFER_MINUTES = 15; // רבע שעה מינימום בין פגישות של מטפלים שונים
const LATE_CANCEL_HOURS = 24;

// בדיקת חפיפה + בופר — מחזיר את הפגישה המתנגשת או null
async function getConflict(therapistId, startTime, endTime, excludeId = null) {
  const bufferMs = BUFFER_MINUTES * 60 * 1000;
  const bufferedStart = new Date(new Date(startTime).getTime() - bufferMs);
  const bufferedEnd = new Date(new Date(endTime).getTime() + bufferMs);

  const sameTherapist = await pool.query(`
    SELECT id, start_time, end_time FROM sessions
    WHERE therapist_id = $1 AND status = 'confirmed' AND id != $2
      AND start_time < $3 AND end_time > $4
    LIMIT 1
  `, [therapistId, excludeId || 0, endTime, startTime]);
  if (sameTherapist.rows.length > 0) return sameTherapist.rows[0];

  const otherTherapist = await pool.query(`
    SELECT s.id, s.start_time, s.end_time, t.name AS therapist_name
    FROM sessions s
    LEFT JOIN therapists t ON s.therapist_id = t.id
    WHERE s.therapist_id != $1 AND s.status = 'confirmed' AND s.id != $2
      AND s.start_time < $3 AND s.end_time > $4
    LIMIT 1
  `, [therapistId, excludeId || 0, bufferedEnd, bufferedStart]);
  if (otherTherapist.rows.length > 0) return otherTherapist.rows[0];

  return null;
}

async function hasConflict(therapistId, startTime, endTime, excludeId = null) {
  return (await getConflict(therapistId, startTime, endTime, excludeId)) !== null;
}

// GET /api/sessions — מנהל: הכל עם פרטים. מטפל: הכל, אבל פגישות של אחרים ללא פרטים
router.get('/', isAdminOrTherapist, async (req, res) => {
  try {
    const { from, to, therapist_id } = req.query;
    // FullCalendar שולח תאריכים עם +03:00 שנהפך לרווח ב-URL — נשחזר ונמיר ל-UTC
    const parseDate = (s) => s ? new Date(s.replace(' ', '+')).toISOString() : null;
    const fromUTC = parseDate(from);
    const toUTC   = parseDate(to);
    let params = [];
    let conditions = [];

    // מנהל יכול לסנן לפי therapist_id; מטפל — שולף הכל
    if (req.user.role !== 'therapist' && therapist_id) {
      params.push(therapist_id);
      conditions.push(`s.therapist_id = $${params.length}`);
    }
    if (fromUTC) {
      params.push(fromUTC);
      conditions.push(`s.start_time >= $${params.length}`);
    }
    if (toUTC) {
      params.push(toUTC);
      conditions.push(`s.end_time <= $${params.length}`);
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(
      `SELECT s.*, t.name AS therapist_name
       FROM sessions s
       LEFT JOIN therapists t ON s.therapist_id = t.id
       ${whereClause}
       ORDER BY s.start_time`,
      params
    );

    if (req.user.role === 'therapist') {
      // פגישות של מטפלים אחרים — מסיר פרטים
      const myId = req.user.id;
      const rows = result.rows.map(s => {
        if (s.therapist_id === myId) return s;
        return {
          id: s.id,
          start_time: s.start_time,
          end_time: s.end_time,
          status: s.status,
          therapist_id: null,
          therapist_name: null,
          notes: null,
          google_event_id: null,
          series_id: null,
          _other: true,
        };
      });
      return res.json(rows);
    }

    res.json(result.rows);
  } catch (err) {
    console.error('[sessions GET] error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions — יצירת פגישה חדשה
router.post('/', isAdminOrTherapist, async (req, res) => {
  const { therapist_id, start_time, end_time, notes, google_event_id } = req.body;
  if (!therapist_id || !start_time || !end_time) {
    return res.status(400).json({ error: 'therapist_id, start_time ו-end_time הם חובה' });
  }
  // מטפל יכול ליצור רק עבור עצמו
  if (req.user.role === 'therapist' && req.user.id !== parseInt(therapist_id)) {
    return res.status(403).json({ error: 'אין הרשאה' });
  }
  if (new Date(start_time) >= new Date(end_time)) {
    return res.status(400).json({ error: 'שעת סיום חייבת להיות אחרי שעת התחלה' });
  }

  try {
    const conflict = await hasConflict(therapist_id, start_time, end_time);
    if (conflict) {
      return res.status(409).json({
        error: `קיימת פגישה קרובה מדי — נדרש מרווח של ${BUFFER_MINUTES} דקות לפחות`,
      });
    }

    const result = await pool.query(
      `INSERT INTO sessions (therapist_id, start_time, end_time, notes, google_event_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [therapist_id, start_time, end_time, notes || null, google_event_id || null]
    );
    const session = result.rows[0];
    // כתוב לגוגל ברקע
    const therapistRes = await pool.query('SELECT name FROM therapists WHERE id = $1', [therapist_id]);
    upsertGoogleEvent({ ...session, therapist_name: therapistRes.rows[0]?.name });
    res.status(201).json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sessions/:id — עדכון פגישה
router.put('/:id', isAdminOrTherapist, async (req, res) => {
  const { start_time, end_time, notes } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'לא נמצא' });

    const session = existing.rows[0];
    // מטפל יכול לערוך רק את הפגישות שלו
    if (req.user.role === 'therapist' && req.user.id !== session.therapist_id) {
      return res.status(403).json({ error: 'אין הרשאה' });
    }
    const newStart = start_time || session.start_time;
    const newEnd = end_time || session.end_time;

    if (new Date(newStart) >= new Date(newEnd)) {
      return res.status(400).json({ error: 'שעת סיום חייבת להיות אחרי שעת התחלה' });
    }

    const conflict = await hasConflict(session.therapist_id, newStart, newEnd, session.id);
    if (conflict) {
      return res.status(409).json({
        error: `קיימת פגישה קרובה מדי — נדרש מרווח של ${BUFFER_MINUTES} דקות לפחות`,
      });
    }

    // קיצור ברגע האחרון — שמור end_time מקורי לצורך חיוב
    const now = new Date();
    const sessionStart = new Date(newStart);
    const hoursUntil = (sessionStart - now) / (1000 * 60 * 60);
    const isLate = hoursUntil < LATE_CANCEL_HOURS && hoursUntil > -LATE_CANCEL_HOURS;
    const originalEnd = new Date(session.end_time);
    const newEndDate = new Date(newEnd);
    const isShorter = newEndDate < originalEnd;
    // שמור original_end_time רק אם זה קיצור ברגע האחרון ועדיין לא שמרנו
    const keepOriginalEnd = isLate && isShorter && !session.original_end_time;
    const originalEndToStore = keepOriginalEnd ? session.end_time : session.original_end_time || null;

    const result = await pool.query(
      `UPDATE sessions
       SET start_time = $1, end_time = $2, notes = COALESCE($3, notes), original_end_time = $4
       WHERE id = $5
       RETURNING *`,
      [newStart, newEnd, notes, originalEndToStore, req.params.id]
    );
    const updated = result.rows[0];
    const therapistRes = await pool.query('SELECT name FROM therapists WHERE id = $1', [session.therapist_id]);
    upsertGoogleEvent({ ...updated, therapist_name: therapistRes.rows[0]?.name });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/recurring — יצירת סדרת פגישות שבועיות
router.post('/recurring', isAdminOrTherapist, async (req, res) => {
  const { therapist_id, start_time, end_time, notes, repeat_until } = req.body;
  if (!therapist_id || !start_time || !end_time || !repeat_until) {
    return res.status(400).json({ error: 'therapist_id, start_time, end_time ו-repeat_until הם חובה' });
  }
  if (req.user.role === 'therapist' && req.user.id !== parseInt(therapist_id)) {
    return res.status(403).json({ error: 'אין הרשאה' });
  }
  const start = new Date(start_time);
  const end = new Date(end_time);
  const until = new Date(repeat_until);
  if (start >= end) {
    return res.status(400).json({ error: 'שעת סיום חייבת להיות אחרי שעת התחלה' });
  }
  if (until < start) {
    return res.status(400).json({ error: 'תאריך הסיום חייב להיות אחרי תאריך ההתחלה' });
  }

  // בנה רשימת כל המועדים השבועיים
  const duration = end - start;
  const occurrences = [];
  let cur = new Date(start);
  while (cur <= until) {
    const occStart = new Date(cur);
    const occEnd = new Date(cur.getTime() + duration);
    occurrences.push({ start: occStart, end: occEnd });
    cur.setDate(cur.getDate() + 7);
  }

  if (occurrences.length === 0) {
    return res.status(400).json({ error: 'לא נמצאו מועדים בטווח שנבחר' });
  }

  // בדוק קונפליקטים לכל המועדים לפני הכנסה
  for (const occ of occurrences) {
    const conflict = await getConflict(therapist_id, occ.start, occ.end);
    if (conflict) {
      const conflictDate = new Date(conflict.start_time).toLocaleDateString('he-IL', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      });
      const conflictStartTime = new Date(conflict.start_time).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      const conflictEndTime = new Date(conflict.end_time).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      const occDate = occ.start.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
      const who = conflict.therapist_name ? ` (${conflict.therapist_name})` : '';
      return res.status(409).json({
        error: `קונפליקט בתאריך ${occDate}: קיימת פגישה${who} בשעות ${conflictStartTime}–${conflictEndTime}`,
      });
    }
  }

  // הכנס את כל הפגישות עם series_id משותף
  const seriesId = require('crypto').randomUUID();
  const therapistRes = await pool.query('SELECT name FROM therapists WHERE id = $1', [therapist_id]);
  const therapistName = therapistRes.rows[0]?.name;

  const inserted = [];
  for (const occ of occurrences) {
    const result = await pool.query(
      `INSERT INTO sessions (therapist_id, start_time, end_time, notes, series_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [therapist_id, occ.start, occ.end, notes || null, seriesId]
    );
    const session = result.rows[0];
    inserted.push(session);
    upsertGoogleEvent({ ...session, therapist_name: therapistName });
  }

  res.status(201).json({ count: inserted.length, series_id: seriesId, sessions: inserted });
});

// POST /api/sessions/:id/cancel — ביטול פגישה (מנהל או מטפל שלו)
router.post('/:id/cancel', isAdminOrTherapist, async (req, res) => {
  const { waive_charge } = req.body; // רק מנהל יכול לפטור מחיוב
  try {
    const existing = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'לא נמצא' });

    const session = existing.rows[0];

    // מטפל יכול לבטל רק את שלו
    if (req.user.role === 'therapist' && req.user.id !== session.therapist_id) {
      return res.status(403).json({ error: 'אין הרשאה' });
    }

    const now = new Date();
    const sessionStart = new Date(session.start_time);
    const hoursUntil = (sessionStart - now) / (1000 * 60 * 60);

    const isLateCancel = hoursUntil < LATE_CANCEL_HOURS && hoursUntil > 0;
    let newStatus = 'cancelled';

    // ביטול מחויב — פחות מ-24 שעות, ורק מנהל יכול לפטור
    if (isLateCancel && !(req.user.role === 'admin' && waive_charge)) {
      newStatus = 'cancelled_charged';
    }

    const result = await pool.query(
      `UPDATE sessions
       SET status = $1, cancelled_at = NOW(), cancellation_waived = $2
       WHERE id = $3
       RETURNING *`,
      [newStatus, req.user.role === 'admin' && waive_charge ? true : false, req.params.id]
    );

    // מחק מגוגל קאלנדר ברקע
    if (session.google_event_id) {
      deleteGoogleEvent(session.google_event_id);
    }

    res.json({
      session: result.rows[0],
      charged: newStatus === 'cancelled_charged',
      message: newStatus === 'cancelled_charged'
        ? 'הפגישה בוטלה פחות מ-24 שעות מראש — תחויב'
        : 'הפגישה בוטלה ללא חיוב',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:id/waive — ביטול חיוב על פגישה מבוטלת (מנהל בלבד)
router.post('/:id/waive', isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE sessions
       SET status = 'cancelled', cancellation_waived = true
       WHERE id = $1 AND status = 'cancelled_charged'
       RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'לא נמצא או לא מחויב' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
