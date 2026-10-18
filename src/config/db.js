const { Pool } = require('pg');

// אימות תעודת ה-SSL: אם סופקה תעודת CA (DATABASE_CA_CERT) — נאמת מולה.
// אחרת נופלים ל-rejectUnauthorized:false כפי שנדרש אצל חלק מספקי ה-PG המנוהלים
// (Render/Heroku). ניתן לאכוף אימות מלא ע"י הגדרת DATABASE_CA_CERT.
const ssl = process.env.DATABASE_CA_CERT
  ? { ca: process.env.DATABASE_CA_CERT, rejectUnauthorized: true }
  : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
});

module.exports = pool;
