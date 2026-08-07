import { Elysia } from 'elysia';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';

const app = new Elysia();

// @note database setup
const pool = mysql.createPool(process.env.DATABASE_URL || 'mysql://root:password@10.60.71.208:3306/growtopia');

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
app.post('/player/login/dashboard', async ({ body, request }) => {
  let clientData = '';

  if (body && typeof body === 'object') {
    const bodyObj = body as Record<string, string>;
    const keys = Object.keys(bodyObj);
    if (keys.length > 0) {
      clientData = keys[0];
    }
  }

  const encodedClientData = Buffer.from(clientData).toString('base64');
  const templatePath = path.join(process.cwd(), 'template', 'dashboard.html');
  const templateContent = fs.readFileSync(templatePath, 'utf-8');
  const htmlContent = templateContent.replace('{{ data }}', encodedClientData);

  return new Response(htmlContent, {
    headers: { 'Content-Type': 'text/html' },
  });
});

// @note validate login endpoint
app.post('/player/growid/login/validate', async ({ body, request }) => {
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
    const bodyObj = body as Record<string, string>;
    const email = bodyObj.email;

    if (email) {
      return new Response(JSON.stringify({ status: 'error', message: 'Email not allowed' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const _token = bodyObj._token;
    const growId = bodyObj.growId;
    const password = bodyObj.password;

    if (!growId || !password) {
      return new Response(JSON.stringify({ status: 'error', message: 'Missing growId or password' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const [rows]: any = await pool.query('SELECT * FROM peer WHERE growid = ? LIMIT 1', [growId]);

    if (rows.length === 0) {
      const attemptsLeft = recordFailedAttempt(clientIp);
      const clientData = btoa(`${growId}`);
      const errorMessage = `Account credentials missmatched. You have ${attemptsLeft} attempt(s) left.`;
      const templatePath = path.join(process.cwd(), 'template', 'dashboard.html');
      const templateContent = fs.readFileSync(templatePath, 'utf-8');
      const errorHtml = `<div class="text-danger text-danger-wrapper"><ul><li>${errorMessage}</li></ul></div>`;
      let htmlContent = templateContent.replace('{{ data }}', Buffer.from(clientData).toString('base64'));
      htmlContent = htmlContent.replace('<div class="row div-content-center">', `${errorHtml}<div class="row div-content-center">`);

      return new Response(htmlContent, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const user = rows[0];
    if (user.password !== password) {
      const attemptsLeft = recordFailedAttempt(clientIp);
      const clientData = btoa(`${growId}`);
      const errorMessage = `Account credentials missmatched. You have ${attemptsLeft} attempt(s) left.`;
      const templatePath = path.join(process.cwd(), 'template', 'dashboard.html');
      const templateContent = fs.readFileSync(templatePath, 'utf-8');
      const errorHtml = `<div class="text-danger text-danger-wrapper"><ul><li>${errorMessage}</li></ul></div>`;
      let htmlContent = templateContent.replace('{{ data }}', Buffer.from(clientData).toString('base64'));
      htmlContent = htmlContent.replace('<div class="row div-content-center">', `${errorHtml}<div class="row div-content-center">`);

      return new Response(htmlContent, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

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

// @note checktoken endpoint - validates token and returns updated token
app.post('/player/growid/validate/checktoken', async ({ body, request }) => {
  try {
    let refreshToken: string | undefined;
    let clientData: string | undefined;

    const contentType = request.headers.get('content-type') || '';

    if (body && typeof body === 'object') {
      const bodyObj = body as Record<string, string>;

      if ('refreshToken' in bodyObj || 'clientData' in bodyObj) {
        refreshToken = bodyObj.refreshToken;
        clientData = bodyObj.clientData;
      } else if (Object.keys(bodyObj).length === 1) {
        const rawPayload = Object.keys(bodyObj)[0];
        const params = new URLSearchParams(rawPayload);
        refreshToken = params.get('refreshToken') || undefined;
        clientData = params.get('clientData') || undefined;
      }
    } else if (typeof body === 'string' && body.length > 0) {
      const params = new URLSearchParams(body);
      refreshToken = params.get('refreshToken') || undefined;
      clientData = params.get('clientData') || undefined;
    }

    console.log(`[CHECKTOKEN] refreshToken: ${refreshToken}, clientData: ${clientData}`);

    if (!refreshToken || !clientData) {
      console.log(`[ERROR]: Missing refreshToken or clientData`);
      return new Response(JSON.stringify({ status: 'error', message: 'Missing refreshToken or clientData' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let decodedRefreshToken = Buffer.from(refreshToken, 'base64').toString('utf-8');

    // @note remove &reg=0/1 from decodedRefreshToken if available
    if (decodedRefreshToken.includes('&reg=0')) {
      decodedRefreshToken = decodedRefreshToken.replace('&reg=0', '');
    } else if (decodedRefreshToken.includes('&reg=1')) {
      decodedRefreshToken = decodedRefreshToken.replace('&reg=1', '');
    }

    const token = Buffer.from(
      decodedRefreshToken.replace(
        /(_token=)[^&]*/,
        `$1${Buffer.from(clientData).toString('base64')}`,
      ),
    ).toString('base64');

    return new Response(JSON.stringify({
      status: 'success',
      message: 'Account Validated.',
      token,
      url: '',
      accountType: 'growtopia',
      accountAge: 2,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.log(`[ERROR]: ${error}`);
    return new Response(JSON.stringify({ status: 'error', message: 'Internal Server Error' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
});

// @note checktoken redirect
app.all('/player/growid/checktoken', ({ redirect }) => {
  return redirect('/player/growid/validate/checktoken', 307);
});

// @note start server
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Running on http://0.0.0.0:${PORT}`);
});

export default app;
