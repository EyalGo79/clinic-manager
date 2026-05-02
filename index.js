require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const passport = require('./src/config/passport');

const authRoutes = require('./src/routes/auth');
const therapistRoutes = require('./src/routes/therapists');
const sessionRoutes = require('./src/routes/sessions');
const billingRoutes = require('./src/routes/billing');
const calendarRoutes = require('./src/routes/calendar').router;
const settingsRoutes = require('./src/routes/settings');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.CLIENT_ORIGIN || `http://localhost:${PORT}`, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 ימים
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// Static files
app.use(express.static(path.join(__dirname, 'src/public')));

// API Routes
app.use('/auth', authRoutes);
app.use('/api/therapists', therapistRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/settings', settingsRoutes);

// Page routes
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect(req.user.role === 'admin' ? '/admin' : '/therapist');
  }
  res.sendFile(path.join(__dirname, 'src/public/login.html'));
});

app.get(['/admin', '/admin/*path'], (req, res, next) => {
  if (!req.isAuthenticated() || req.user.role !== 'admin') return res.redirect('/login');
  next();
});

app.get(['/therapist', '/therapist/*path'], (req, res, next) => {
  if (!req.isAuthenticated() || req.user.role !== 'therapist') return res.redirect('/login');
  next();
});

app.get('/', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/login');
  res.redirect(req.user.role === 'admin' ? '/admin' : '/therapist');
});

app.listen(PORT, () => {
  console.log(`Clinic Manager running on http://localhost:${PORT}`);
});
