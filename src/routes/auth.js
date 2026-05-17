const express = require('express');
const router = express.Router();
const passport = require('../config/passport');
const { isAdmin } = require('../middleware/auth');

// התחברות אדמין — עם הרשאות קאלנדר
router.get('/google/admin', passport.authenticate('google-admin', {
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar'],
  accessType: 'offline',
  prompt: 'consent',
}));

// התחברות מטפל — ללא הרשאות קאלנדר
router.get('/google', passport.authenticate('google-therapist', {
  scope: ['profile', 'email'],
  accessType: 'online',
}));

router.get('/google/callback/admin',
  passport.authenticate('google-admin', { failureRedirect: '/login?error=not_registered' }),
  (req, res) => {
    res.redirect('/admin');
  }
);

// רענון טוקן + הגדרת אדמין ראשי — מפנה ל-OAuth ומחזיר להגדרות
router.get('/google/admin/refresh', isAdmin, passport.authenticate('google-admin-refresh', {
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar'],
  accessType: 'offline',
  prompt: 'consent',
}));

router.get('/google/callback/admin/refresh',
  passport.authenticate('google-admin-refresh', { failureRedirect: '/admin/settings.html?error=1' }),
  async (req, res) => {
    const pool = require('../config/db');
    try {
      await pool.query('UPDATE admins SET is_calendar_primary = false');
      await pool.query('UPDATE admins SET is_calendar_primary = true WHERE id = $1', [req.user.id]);
    } catch (e) {
      console.error('set primary error:', e.message);
    }
    res.redirect('/admin/settings.html?refreshed=1');
  }
);

router.get('/google/callback',
  passport.authenticate('google-therapist', { failureRedirect: '/login?error=not_registered' }),
  (req, res) => {
    if (req.user.role === 'admin') return res.redirect('/admin');
    res.redirect('/therapist');
  }
);

router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/login');
  });
});

router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'לא מחובר' });
  const { id, name, email, role } = req.user;
  res.json({ id, name, email, role });
});

module.exports = router;
