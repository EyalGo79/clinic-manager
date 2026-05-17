const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { isAdmin } = require('../middleware/auth');

// GET /api/settings/rate-tiers
router.get('/rate-tiers', isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, max_hours, rate FROM rate_tiers ORDER BY max_hours ASC NULLS LAST'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/rate-tiers
router.put('/rate-tiers', isAdmin, async (req, res) => {
  const { tiers } = req.body;
  if (!Array.isArray(tiers) || !tiers.length) {
    return res.status(400).json({ error: 'נדרש מערך של מדרגות' });
  }
  try {
    await Promise.all(
      tiers.map(t =>
        pool.query(
          'UPDATE rate_tiers SET rate = $1, effective_from = CURRENT_DATE WHERE id = $2',
          [t.rate, t.id]
        )
      )
    );
    const result = await pool.query(
      'SELECT id, max_hours, rate FROM rate_tiers ORDER BY max_hours ASC NULLS LAST'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/admins
router.get('/admins', isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, is_calendar_primary, refresh_token IS NOT NULL AS has_token, created_at FROM admins ORDER BY created_at'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/admins/:id/calendar-primary — הגדר אדמין ראשי לגוגל
router.put('/admins/:id/calendar-primary', isAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE admins SET is_calendar_primary = false');
    await pool.query('UPDATE admins SET is_calendar_primary = true WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/admins
router.post('/admins', isAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'אימייל הוא שדה חובה' });
  try {
    const result = await pool.query(
      'INSERT INTO admins (email) VALUES ($1) RETURNING id, email, created_at',
      [email.trim().toLowerCase()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'אימייל כבר קיים' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/admins/:id
router.delete('/admins/:id', isAdmin, async (req, res) => {
  if (req.user.id === parseInt(req.params.id)) {
    return res.status(400).json({ error: 'לא ניתן למחוק את עצמך' });
  }
  try {
    await pool.query('DELETE FROM admins WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
