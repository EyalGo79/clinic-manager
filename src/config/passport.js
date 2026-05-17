const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const pool = require('./db');

passport.serializeUser((user, done) => {
  done(null, {
    id: user.id,
    role: user.role,
    access_token: user.access_token,
    refresh_token: user.refresh_token,
  });
});

passport.deserializeUser(async ({ id, role, access_token, refresh_token }, done) => {
  try {
    const tableMap = { admin: 'admins', therapist: 'therapists' };
    const table = tableMap[role];
    if (!table) return done(null, false);
    const result = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    if (!result.rows[0]) return done(null, false);
    done(null, { ...result.rows[0], role, access_token, refresh_token });
  } catch (err) {
    done(err);
  }
});

// Strategy לאדמינים — עם קאלנדר, שומר refresh_token
passport.use('google-admin',
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL_ADMIN,
    },
    async (accessToken, refreshToken, profile, done) => {
      const email = profile.emails[0].value.toLowerCase();
      const googleId = profile.id;
      try {
        const result = await pool.query('SELECT * FROM admins WHERE LOWER(email) = $1', [email]);
        if (!result.rows[0]) return done(null, false, { message: 'לא רשום כאדמין' });
        await pool.query(
          'UPDATE admins SET google_id = $1, refresh_token = COALESCE($2, refresh_token) WHERE id = $3',
          [googleId, refreshToken || null, result.rows[0].id]
        );
        return done(null, { ...result.rows[0], role: 'admin', access_token: accessToken, refresh_token: refreshToken });
      } catch (err) {
        return done(err);
      }
    }
  )
);

// Strategy לרענון טוקן — callback שונה, תמיד שומר refresh_token חדש
passport.use('google-admin-refresh',
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL_ADMIN_REFRESH,
    },
    async (accessToken, refreshToken, profile, done) => {
      const email = profile.emails[0].value.toLowerCase();
      const googleId = profile.id;
      try {
        const result = await pool.query('SELECT * FROM admins WHERE LOWER(email) = $1', [email]);
        if (!result.rows[0]) return done(null, false, { message: 'לא רשום כאדמין' });
        await pool.query(
          'UPDATE admins SET google_id = $1, refresh_token = $2 WHERE id = $3',
          [googleId, refreshToken, result.rows[0].id]
        );
        return done(null, { ...result.rows[0], role: 'admin', access_token: accessToken, refresh_token: refreshToken });
      } catch (err) {
        return done(err);
      }
    }
  )
);

// Strategy למטפלים — ללא קאלנדר
passport.use('google-therapist',
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    async (accessToken, refreshToken, profile, done) => {
      const email = profile.emails[0].value.toLowerCase();
      const googleId = profile.id;
      try {
        // בדוק אדמין קודם
        const adminResult = await pool.query('SELECT * FROM admins WHERE LOWER(email) = $1', [email]);
        if (adminResult.rows[0]) {
          await pool.query('UPDATE admins SET google_id = $1 WHERE id = $2', [googleId, adminResult.rows[0].id]);
          return done(null, { ...adminResult.rows[0], role: 'admin', access_token: accessToken, refresh_token: null });
        }
        // מטפל
        const therapistResult = await pool.query('SELECT * FROM therapists WHERE LOWER(email) = $1', [email]);
        if (therapistResult.rows[0]) {
          if (!therapistResult.rows[0].google_id) {
            await pool.query('UPDATE therapists SET google_id = $1 WHERE id = $2', [googleId, therapistResult.rows[0].id]);
          }
          return done(null, { ...therapistResult.rows[0], role: 'therapist', access_token: accessToken, refresh_token: null });
        }
        return done(null, false, { message: 'לא רשום במערכת' });
      } catch (err) {
        return done(err);
      }
    }
  )
);

module.exports = passport;
