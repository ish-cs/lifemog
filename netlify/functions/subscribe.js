const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { idToken, subscription, timezone, reminders } = body;

  if (!idToken) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let uid;
  try {
    uid = await verifyFirebaseToken(idToken);
  } catch (e) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: ' + e.message }) };
  }

  // Validate inputs
  if (!subscription?.endpoint || !subscription?.keys) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid subscription: missing endpoint or keys' }) };
  }
  if (typeof timezone !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'timezone must be a string' }) };
  }
  if (!Array.isArray(reminders) || reminders.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'reminders must be a non-empty array' }) };
  }

  // Sanitize reminders
  const sanitized = reminders.map(r => ({
    id: (typeof r.id === 'string' && r.id) ? r.id : 'r_' + crypto.randomBytes(6).toString('hex'),
    time: (typeof r.time === 'string' && r.time) ? r.time : '10:00',
    label: (typeof r.label === 'string') ? r.label.trim().slice(0, 50) : '',
    lastNotified: r.lastNotified || null,
  }));

  try {
    await writeSubscription(uid, subscription, timezone, sanitized);
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

async function verifyFirebaseToken(idToken) {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error('FIREBASE_API_KEY not configured');
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  const data = await res.json();
  if (!res.ok || !data.users?.length) throw new Error('Invalid or expired token');
  return data.users[0].localId;
}

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

function encodeReminder(r) {
  return {
    mapValue: {
      fields: {
        id: { stringValue: r.id },
        time: { stringValue: r.time },
        label: { stringValue: r.label },
        lastNotified: r.lastNotified ? { stringValue: r.lastNotified } : { nullValue: null },
      }
    }
  };
}

function encodeKeys(keys) {
  const fields = {};
  for (const [k, v] of Object.entries(keys)) {
    fields[k] = { stringValue: String(v) };
  }
  return { mapValue: { fields } };
}

async function writeSubscription(uid, subscription, timezone, reminders) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID not configured');

  const accessToken = await getServiceAccountToken();

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}` +
    `?updateMask.fieldPaths=pushSubscription`;

  const body = {
    fields: {
      pushSubscription: {
        mapValue: {
          fields: {
            endpoint: { stringValue: subscription.endpoint },
            keys: encodeKeys(subscription.keys),
            timezone: { stringValue: timezone },
            reminders: {
              arrayValue: {
                values: reminders.map(encodeReminder),
              }
            },
          }
        }
      }
    }
  };

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore PATCH failed ${res.status}: ${text.slice(0, 300)}`);
  }
}
