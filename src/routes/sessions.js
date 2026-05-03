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
    WHERE therapist_id = $1 AND status != 'cancelled' AND id != $2
      AND start_time < $3 AND end_time > $4
    LIMIT 1
  `, [therapistId, excludeId || 0, endTime, startTime]);
  if (sameTherapist.rows.length > 0) return sameTherapist.rows[0];

  const otherTherapist = await pool.query(`
    SELECT s.id, s.start_time, s.end_time, t.name AS therapist_name
    FROM sessions s
    LEFT JOIN therapists t ON s.therapist_id = t.id
    WHERE s.therapist_id != $1 AND s.status != 'cancelled' AND s.id != $2
      AND s.start_time < $3 AND s.end_time > $4
    LIMIT 1
  `, [therapistId, excludeId || 0, bufferedEnd, bufferedStart]);
  if (otherTherapist.rows.length > 0) return otherTherapist.rows[0];

  return null;
}

async function hasConflict(therapistId, startTime, endTime, excludeId = null) {
  return (await getConflict(therapistId, startTime, endTime, excludeId)) !== null;
}

// GET /api/sessions — פגישות (מנהל: הכל, מטפל: שלו בלבד)
router.get('/', isAdminOrTherapist, async (req, res) => {
  try {
    const { from, to, therapist_id } = req.query;
    let params = [];
    let conditions = [];

    // מטפל רואה רק את שלו
    const therapistFilter =
      req.user.role === 'therapist' ? req.user.id : therapist_id;
    if (therapistFilter) {
      params.push(therapistFilter);
      conditions.push(`s.therapist_id = $${params.length}`);
    }
    if (from) {
      params.push(from);
      conditions.push(`s.start_time >= $${params.length}`);
    }
    if (to) {
      params.push(to);
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
    res.json(result.rows);
  } catch (err) {
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

    const result = await pool.query(
      `UPDATE sessions
       SET start_time = $1, end_time = $2, notes = COALESCE($3, notes)
       WHERE id = $4
       RETURNING *`,
      [newStart, newEnd, notes, req.params.id]
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

// POST /api/sessions/:id/cancel — ביטול פגישה
router.post('/:id/cancel', isAdmin, async (req, res) => {
  const { waive_charge } = req.body; // המנהל יכול לפטור מחיוב
  try {
    const existing = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'לא נמצא' });

    const session = existing.rows[0];
    const now = new Date();
    const sessionStart = new Date(session.start_time);
    const hoursUntil = (sessionStart - now) / (1000 * 60 * 60);

    const isLateCancel = hoursUntil < LATE_CANCEL_HOURS && hoursUntil > 0;
    let newStatus = 'cancelled';

    if (isLateCancel && !waive_charge) {
      // ביטול מחויב — פחות מ-24 שעות ללא פטור
      newStatus = 'cancelled_charged';
    }

    const result = await pool.query(
      `UPDATE sessions
       SET status = $1, cancelled_at = NOW(), cancellation_waived = $2
       WHERE id = $3
       RETURNING *`,
      [newStatus, waive_charge ? true : false, req.params.id]
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

module.exports = router;
