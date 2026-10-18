// פונקציות עזר משותפות לחישובי חיוב — כדי למנוע כפילות לוגיקה בין
// routes/billing.js, routes/therapists.js ו-routes/contracts.js.

function round2(n) {
  return Math.round(n * 100) / 100;
}

// בוחר תעריף לפי מדרגות (rate_tiers). tiers ממוינים לפי max_hours עולה, NULL אחרון.
// max_hours = NULL פירושו "ללא גבול עליון".
function calcRateFromTiers(hours, tiers) {
  for (const tier of tiers) {
    if (tier.max_hours === null || hours < parseFloat(tier.max_hours)) {
      return parseFloat(tier.rate);
    }
  }
  return tiers.length ? parseFloat(tiers[tiers.length - 1].rate) : 0;
}

// המרת שעה מ-TIME string (HH:MM[:SS]) לדקות מתחילת היום
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// סוכם דקות שבועיות פר-מטפל מתוך שורות therapist_slots פעילות.
// מקבל מערך שורות עם { therapist_id, start_time, end_time } ומחזיר מפה therapist_id -> דקות.
function weeklyMinutesByTherapist(slotRows) {
  const weeklyMinutes = {};
  for (const s of slotRows) {
    weeklyMinutes[s.therapist_id] =
      (weeklyMinutes[s.therapist_id] || 0) +
      (timeToMinutes(s.end_time) - timeToMinutes(s.start_time));
  }
  return weeklyMinutes;
}

module.exports = { round2, calcRateFromTiers, timeToMinutes, weeklyMinutesByTherapist };
