const crypto = require('crypto');
const webpush = require('web-push');

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

exports.handler = async () => {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    console.error('FIREBASE_PROJECT_ID not configured');
    return { statusCode: 500, body: 'misconfigured' };
  }

  let token;
  try {
    token = await getServiceAccountToken();
  } catch (e) {
    console.error('Failed to get service account token:', e.message);
    return { statusCode: 500, body: 'auth error' };
  }

  let users;
  try {
    users = await getAllUsersWithSubscriptions(token, projectId);
  } catch (e) {
    console.error('Failed to fetch users:', e.message);
    return { statusCode: 500, body: 'firestore error' };
  }

  const nowUtc = new Date();

  for (const user of users) {
    const { uid, pushSubscription } = user;
    const { endpoint, keys, timezone, reminders } = pushSubscription;

    if (!endpoint || !keys || !timezone || !Array.isArray(reminders)) continue;

    const localDate = getLocalDate(nowUtc, timezone);
    const localHHMM = getLocalHHMM(nowUtc, timezone);

    let changed = false;

    for (const reminder of reminders) {
      if (!reminder.time) continue;
      if (reminder.lastNotified === localDate) continue;
      if (!isInWindow(localHHMM, reminder.time)) continue;

      const label = typeof reminder.label === 'string' ? reminder.label.trim() : '';
      const body = label ? `🍽 Log your ${label}!` : `🍽 Time to log your meals!`;

      try {
        await webpush.sendNotification(
          { endpoint, keys },
          JSON.stringify({ title: 'LifeMog', body, icon: '/icon-192.png', url: '/' })
        );
        reminder.lastNotified = localDate;
        changed = true;
      } catch (e) {
        if (e.statusCode === 410) {
          console.log(`Subscription gone for uid=${uid}, deleting`);
          if (changed) {
            try { await updateReminders(uid, reminders, token, projectId); } catch (_) {}
          }
          try { await deleteSubscription(uid, token, projectId); } catch (de) {
            console.error('Failed to delete subscription:', de.message);
          }
          changed = false;
          break;
        }
        console.error(`Push failed for uid=${uid} reminder=${reminder.id}:`, e.message);
      }
    }

    if (changed) {
      try {
        await updateReminders(uid, reminders, token, projectId);
      } catch (e) {
        console.error(`Failed to update reminders for uid=${uid}:`, e.message);
      }
    }
  }

  return { statusCode: 200, body: 'ok' };
};

// ---- time helpers ----

function getLocalDate(utcDate, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(utcDate);
}

function getLocalHHMM(utcDate, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(utcDate); // returns "HH:MM"
}

function isInWindow(currentHHMM, targetHHMM) {
  const [ch, cm] = currentHHMM.split(':').map(Number);
  const [th, tm] = targetHHMM.split(':').map(Number);
  const currentMins = ch * 60 + cm;
  const targetMins = th * 60 + tm;
  return currentMins >= targetMins && currentMins < targetMins + 15;
}

// ---- JWT / auth ----

async function getServiceAccountToken() {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore',
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(sa.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Failed to get service account token: ' + JSON.stringify(data));
  return data.access_token;
}

// ---- Firestore helpers ----

function fromFirestoreFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) {
    if ('stringValue' in v) obj[k] = v.stringValue;
    else if ('integerValue' in v) obj[k] = Number(v.integerValue);
    else if ('booleanValue' in v) obj[k] = v.booleanValue;
    else if ('nullValue' in v) obj[k] = null;
    else if ('mapValue' in v) obj[k] = fromFirestoreFields(v.mapValue.fields || {});
    else if ('arrayValue' in v) obj[k] = (v.arrayValue.values || []).map(item =>
      item.mapValue ? fromFirestoreFields(item.mapValue.fields || {}) :
      item.stringValue ?? item.integerValue ?? item.nullValue ?? null
    );
  }
  return obj;
}

async function getAllUsersWithSubscriptions(token, projectId) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore GET users failed ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const docs = data.documents || [];
  const results = [];
  for (const doc of docs) {
    if (!doc.fields?.pushSubscription?.mapValue) continue;
    const uid = doc.name.split('/').pop();
    const parsed = fromFirestoreFields(doc.fields);
    results.push({ uid, ...parsed });
  }
  return results;
}

function encodeReminder(r) {
  return {
    mapValue: {
      fields: {
        id: { stringValue: r.id || '' },
        time: { stringValue: r.time || '' },
        label: { stringValue: r.label || '' },
        lastNotified: r.lastNotified ? { stringValue: r.lastNotified } : { nullValue: 0 },
      }
    }
  };
}

async function updateReminders(uid, reminders, token, projectId) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}` +
    `?updateMask.fieldPaths=pushSubscription.reminders`;
  const body = {
    fields: {
      pushSubscription: {
        mapValue: {
          fields: {
            reminders: {
              arrayValue: { values: reminders.map(encodeReminder) }
            }
          }
        }
      }
    }
  };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore PATCH reminders failed ${res.status}: ${text.slice(0, 300)}`);
  }
}

async function deleteSubscription(uid, token, projectId) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}` +
    `?updateMask.fieldPaths=pushSubscription`;
  const body = {
    fields: {
      pushSubscription: { nullValue: 0 }
    }
  };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore PATCH delete subscription failed ${res.status}: ${text.slice(0, 300)}`);
  }
}
