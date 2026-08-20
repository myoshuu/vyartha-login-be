import { Elysia } from 'elysia';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';

const app = new Elysia();

// @note Login Backend database (for tracking registrations synced from Growtopia Server)
const pool = mysql.createPool(process.env.DATABASE_URL || 'mysql://root:password@localhost:3306/growtopia');

// @note rate limiter
const ipAttempts = new Map<string, { count: number; blockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 30 * 60 * 1000;

// @note middleware (CORS is built into Elysia now)

// @note helper functions
function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  return (
    forwarded?.split(',')[0]?.trim() ||
    realIp ||
    'unknown'
  );
}

function checkIpBlocked(clientIp: string): { blocked: boolean; remaining: number } {
  const record = ipAttempts.get(clientIp);
  if (!record) return { blocked: false, remaining: MAX_ATTEMPTS };

  const now = Date.now();
  if (record.blockedUntil > now) {
    return { blocked: true, remaining: 0 };
  }

  if (record.blockedUntil > 0 && record.blockedUntil <= now) {
    ipAttempts.delete(clientIp);
    return { blocked: false, remaining: MAX_ATTEMPTS };
  }

  return { blocked: false, remaining: MAX_ATTEMPTS - record.count };
}

function recordFailedAttempt(clientIp: string): number {
  const record = ipAttempts.get(clientIp) || { count: 0, blockedUntil: 0 };
  const now = Date.now();

  if (record.blockedUntil > now) {
    return 0;
  }

  record.count += 1;
  const remaining = MAX_ATTEMPTS - record.count;

  if (record.count >= MAX_ATTEMPTS) {
    record.blockedUntil = now + COOLDOWN_MS;
    console.log(`[BLOCKED] IP ${clientIp} blocked for 30 minutes`);
  }

  ipAttempts.set(clientIp, record);
  return Math.max(0, remaining);
}

function resetAttempts(clientIp: string): void {
  ipAttempts.delete(clientIp);
}

// @note root endpoint
app.get('/', () => {
  return 'Hello, world!';
});

// @note dashboard endpoint - serves login HTML page with client data
app.post('/player/login/dashboard', async ({ request }) => {
  let clientData = '';

  // @note Read body manually
  const bodyText = await request.text();
  console.log(`[DASHBOARD] Body: ${bodyText.substring(0, 100)}...`);

  // @note Parse as URLSearchParams
  const params = new URLSearchParams(bodyText);
  const _token = params.get('_token') || '';

  if (_token) {
    // @note If _token exists, use it directly
    clientData = _token;
  } else {
    // @note Otherwise, use the raw body as client data
    try {
      clientData = decodeURIComponent(bodyText);
    } catch (e) {
      clientData = bodyText;
    }
  }

  console.log(`[DASHBOARD] clientData length: ${clientData.length}`);

  const encodedClientData = Buffer.from(clientData).toString('base64');
  const templatePath = path.join(process.cwd(), 'template', 'dashboard.html');
  const templateContent = fs.readFileSync(templatePath, 'utf-8');
  const htmlContent = templateContent.replace('{{ data }}', encodedClientData);

  return new Response(htmlContent, {
    headers: { 'Content-Type': 'text/html' },
  });
});

// @note validate login endpoint (handles both login and register)
app.post('/player/growid/login/validate', async ({ request }) => {
  const clientIp = getClientIp(request);

  const { blocked } = checkIpBlocked(clientIp);
  if (blocked) {
    const clientData = '';
    const errorMessage = 'Login attempts exhausted from your IP, Please try again later after 30 mins';
    const templatePath = path.join(process.cwd(), 'template', 'dashboard.html');
    const templateContent = fs.readFileSync(templatePath, 'utf-8');
    const errorHtml = `<div class="text-danger text-danger-wrapper"><ul><li>${errorMessage}</li></ul></div>`;
    let htmlContent = templateContent.replace('{{ data }}', Buffer.from(clientData).toString('base64'));
    htmlContent = htmlContent.replace('<div class="row div-content-center">', `${errorHtml}<div class="row div-content-center">`);

    return new Response(htmlContent, {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  try {
    // @note Read body manually
    const bodyText = await request.text();
    const params = new URLSearchParams(bodyText);

    const email = params.get('email') || undefined;
    const _token = params.get('_token') || '';
    const growId = params.get('growId') || '';
    const password = params.get('password') || '';
    const passwordConfirmation = params.get('password_confirmation') || '';

    console.log(`[LOGIN] Body: ${bodyText.substring(0, 100)}...`);
    console.log(`[LOGIN] Parsed - email: ${email ? 'yes' : 'no'}, growId: ${growId}, _token length: ${_token.length}`);

    // @note Registration flow (when email is present)
    if (email) {
      // @note Validate required fields
      if (!growId || !password || !passwordConfirmation) {
        return new Response(JSON.stringify({ status: 'error', message: 'All fields are required' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // @note Validate password match
      if (password !== passwordConfirmation) {
        return new Response(JSON.stringify({ status: 'error', message: 'Passwords do not match' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // @note Validate GrowID format (alphanumeric, max 18 chars)
      if (!/^[A-Za-z0-9]+$/.test(growId) || growId.length > 18) {
        return new Response(JSON.stringify({ status: 'error', message: 'Invalid GrowID format' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // @note Check if IP is blocked (too many registrations from same IP)
      const { blocked, remaining } = checkIpBlocked(clientIp);
      if (blocked) {
        return new Response(JSON.stringify({
          status: 'error',
          message: 'Too many registration attempts. Please try again later.'
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      console.log(`[REGISTER] User registered: ${growId} (${email})`);

      // @note Return success - Growtopia Server handles actual user creation
      // The server will sync to login backend via /api/sync/register
      const token = Buffer.from(
        `_token=${_token}&growId=${growId}&password=${password}&reg=1`,
      ).toString('base64');

      return new Response(JSON.stringify({
        status: 'success',
        message: 'Account created successfully.',
        token,
        url: '',
        accountType: 'growtopia',
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // @note Login flow (no email field)
    if (!growId || !password) {
      return new Response(JSON.stringify({ status: 'error', message: 'Missing growId or password' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // @note Check if IP is blocked
    const { blocked } = checkIpBlocked(clientIp);
    if (blocked) {
      return new Response(JSON.stringify({
        status: 'error',
        message: 'Too many login attempts. Please try again in 30 minutes.'
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // @note For login, we return success and let Growtopia Server validate
    // If user doesn't exist on server, server auto-creates them
    // But we still track this as a potential "failed" attempt if we want
    // For now, we trust the client since Growtopia Server does real validation
    resetAttempts(clientIp);

    const token = Buffer.from(
      `_token=${_token}&growId=${growId}&password=${password}&reg=0`,
    ).toString('base64');

    return new Response(JSON.stringify({
      status: 'success',
      message: 'Account Validated.',
      token,
      url: '',
      accountType: 'growtopia',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.log(`[ERROR]: ${error}`);
    return new Response(JSON.stringify({ status: 'error', message: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});

// @note checktoken endpoint - validates token and returns game server info in Growtopia format
// This is the SINGLE handler for checktoken - consolidated from duplicate handlers
app.post('/player/growid/validate/checktoken', async ({ body, request }) => {
  try {
    let refreshToken: string | undefined;
    let clientData: string | undefined;

    // @note Read body manually since Elysia doesn't auto-parse form data
    const bodyText = await request.text();
    console.log(`[CHECKTOKEN] Body: ${bodyText}`);

    if (bodyText) {
      const params = new URLSearchParams(bodyText);
      refreshToken = params.get('refreshToken') || undefined;
      clientData = params.get('clientData') || undefined;
    }

    console.log(`[CHECKTOKEN] Parsed - refreshToken: ${refreshToken ? 'exists' : 'missing'}, clientData: ${clientData ? 'exists' : 'missing'}`);

    if (!refreshToken || !clientData) {
      console.log(`[ERROR]: Missing refreshToken or clientData`);
      // @note Return error in Growtopia format so client handles it properly
      return new Response('error|Missing login credentials', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // @note Decode and extract credentials from refreshToken
    let decodedRefreshToken: string;
    try {
      decodedRefreshToken = Buffer.from(refreshToken, 'base64').toString('utf-8');
      console.log(`[CHECKTOKEN] Decoded refreshToken: ${decodedRefreshToken}`);
    } catch (e) {
      console.log(`[ERROR]: Failed to decode refreshToken: ${e}`);
      return new Response('error|Invalid token format', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // @note Parse the refreshToken to get growId and password
    const refreshParams = new URLSearchParams(decodedRefreshToken);
    const growId = refreshParams.get('growId') || '';
    const password = refreshParams.get('password') || '';

    if (!growId || !password) {
      console.log(`[ERROR]: Missing growId or password in token`);
      return new Response('error|Missing credentials', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // @note Skip database validation since the game server does its own validation
    // The login backend database is only for tracking registrations, not authentication
    // The game server's vyartha database has the actual peer credentials
    console.log(`[CHECKTOKEN] Skipping DB validation - game server will validate credentials`);

    // @note Get the _token from clientData (it's the base64 encoded client info)
    const originalToken = Buffer.from(clientData).toString('base64');

    // @note Build the new token with current client data
    const newToken = Buffer.from(
      `_token=${originalToken}&growId=${growId}&password=${password}&reg=0`
    ).toString('base64');

    // @note Return game server info in Growtopia format
    // The Growtopia client expects this specific format to connect to the game server
    const gameServerHost = process.env.GAMESERVER_HOST || 'vyartha-login.ratival.com';
    const gameServerPort = process.env.GAMESERVER_PORT || '17091';

    // @note Growtopia client expects this format
    const gtResponse = `server|${gameServerHost}\nport|${gameServerPort}\ntype|1\n`;

    console.log(`[CHECKTOKEN] Returning GT format response: ${gtResponse.replace('\n', ' ')}`);

    return new Response(gtResponse, {
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (error) {
    console.log(`[ERROR]: ${error}`);
    return new Response('error|Internal server error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
});

// @note Alternative checktoken route - some Growtopia clients use this path
app.post('/player/growid/checktoken', async ({ request }) => {
  try {
    let refreshToken: string | undefined;
    let clientData: string | undefined;

    // @note Read body manually since Elysia doesn't auto-parse form data
    const bodyText = await request.text();
    console.log(`[CHECKTOKEN-ALT] Body: ${bodyText}`);

    if (bodyText) {
      const params = new URLSearchParams(bodyText);
      refreshToken = params.get('refreshToken') || undefined;
      clientData = params.get('clientData') || undefined;
    }

    console.log(`[CHECKTOKEN-ALT] Parsed - refreshToken: ${refreshToken ? 'exists' : 'missing'}, clientData: ${clientData ? 'exists' : 'missing'}`);

    if (!refreshToken || !clientData) {
      console.log(`[ERROR-ALT]: Missing refreshToken or clientData`);
      return new Response('error|Missing login credentials', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // @note Decode and extract credentials from refreshToken
    let decodedRefreshToken: string;
    try {
      decodedRefreshToken = Buffer.from(refreshToken, 'base64').toString('utf-8');
      console.log(`[CHECKTOKEN-ALT] Decoded refreshToken: ${decodedRefreshToken}`);
    } catch (e) {
      console.log(`[ERROR-ALT]: Failed to decode refreshToken: ${e}`);
      return new Response('error|Invalid token format', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // @note Parse the refreshToken to get growId and password
    const refreshParams = new URLSearchParams(decodedRefreshToken);
    const growId = refreshParams.get('growId') || '';
    const password = refreshParams.get('password') || '';

    if (!growId || !password) {
      console.log(`[ERROR-ALT]: Missing growId or password in token`);
      return new Response('error|Missing credentials', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // @note Skip database validation since the game server does its own validation
    // The login backend database is only for tracking registrations, not authentication
    // The game server's vyartha database has the actual peer credentials
    console.log(`[CHECKTOKEN-ALT] Skipping DB validation - game server will validate credentials`);

    // @note Return game server info in Growtopia format
    const gameServerHost = process.env.GAMESERVER_HOST || 'vyartha-login.ratival.com';
    const gameServerPort = process.env.GAMESERVER_PORT || '17091';

    const gtResponse = `server|${gameServerHost}\nport|${gameServerPort}\ntype|1\n`;

    console.log(`[CHECKTOKEN-ALT] Returning GT format response: ${gtResponse.replace('\n', ' ')}`);

    return new Response(gtResponse, {
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (error) {
    console.log(`[ERROR-ALT]: ${error}`);
    return new Response('error|Internal server error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
});

// @note sync/register endpoint - called by Growtopia Server when user auto-creates
// This records registration data for tracking (emails, etc)
app.post('/api/sync/register', async ({ body }) => {
  try {
    const bodyObj = body as Record<string, string>;
    const growId = bodyObj.growid;
    const email = bodyObj.email || null;

    if (!growId) {
      return new Response(JSON.stringify({ status: 'error', message: 'Missing growid' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // @note Check if already synced (avoid duplicates)
    const [existing]: any = await pool.query('SELECT id FROM peer WHERE growid = ? LIMIT 1', [growId]);
    if (existing.length > 0) {
      return new Response(JSON.stringify({ status: 'success', message: 'Already synced' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // @note Save registration data for tracking
    await pool.query(
      'INSERT INTO peer (growid, email) VALUES (?, ?)',
      [growId, email]
    );

    console.log(`[SYNC] Registration synced: ${growId}${email ? ` (${email})` : ''}`);

    return new Response(JSON.stringify({ status: 'success', message: 'Registration synced' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error(`[SYNC ERROR]: ${error}`);
    return new Response(JSON.stringify({ status: 'error', message: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});

// @note start server
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Running on http://0.0.0.0:${PORT}`);
});

export default app;
