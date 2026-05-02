const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { isAdmin, isAdminOrTherapist } = require('../middleware/auth');
const { upsertGoogleEvent, deleteGoogleEvent } = require('./calendar');

const BUFFER_MINUTES = 15; // רבע שעה מינימום בין פגישות של מטפלים שונים
const LATE_CANCEL_HOURS = 24;

// בדיקת חפיפה + בופר 15 דקות — רק בין מטפלים שונים
async function hasConflict(therapistId, startTime, endTime, excludeId = null) {
  const bufferMs = BUFFER_MINUTES * 60 * 1000;
  const bufferedStart = new Date(new Date(startTime).getTime() - bufferMs);
  const bufferedEnd = new Date(new Date(endTime).getTime() + bufferMs);

  // חפיפה מדויקת עם אותו מטפל (ללא בופר)
  const sameTherapistConflict = await pool.query(`
    SELECT id FROM sessions
    WHERE therapist_id = $1
      AND status != 'cancelled'
      AND id != $2
      AND start_time < $3
      AND end_time > $4
  `, [therapistId, excludeId || 0, endTime, startTime]);

  if (sameTherapistConflict.rows.length > 0) return true;

  // חפיפה עם בופר עם מטפלים אחרים (חדר משותף)
  const otherTherapistConflict = await pool.query(`
    SELECT id FROM sessions
    WHERE therapist_id != $1
      AND status != 'cancelled'
      AND id != $2
      AND start_time < $3
      AND end_time > $4
  `, [therapistId, excludeId || 0, bufferedEnd, bufferedStart]);

  return otherTherapistConflict.rows.length > 0;
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
