const express = require('express');
const router = express.Router();
const passport = require('../config/passport');

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
