import type { FastifyInstance } from 'fastify';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { attemptLogin, changePassword, logoutUser, resetPasswordWithToken } from '../authActions.js';
import { html } from '../html.js';
import { layout } from '../layout.js';

const CSRF_FAIL = 'Invalid or expired security token (CSRF). Please refresh the page and try again.';
const csrfFail = () => new WebText(CSRF_FAIL, 419);
const bytes = (s: string) => Buffer.byteLength(s);
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const field = (ctx: WebCtx, k: string) => (typeof body(ctx)[k] === 'string' ? (body(ctx)[k] as string) : '');

export const postLoginRedirect = (ctx: WebCtx) =>
  ctx.roleName() === 'Workshop Staff' ? 'modules/workshop/dashboard.php' : 'modules/dashboard/landing.php';

const BS_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/5.3.2/css/bootstrap.min.css';
const FA_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css';

export function registerAuthPages(app: FastifyInstance) {
  // ---- login -------------------------------------------------------------------------------
  webPage(app, '/modules/auth/login', { auth: 'public' }, async (ctx, req) => {
    if (ctx.isLoggedIn()) return new WebRedirect(postLoginRedirect(ctx));
    let error: string | null = null;
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const username = field(ctx, 'username').trim();
      const password = field(ctx, 'password');
      if (username === '' || password === '') error = 'Please enter both username and password.';
      else {
        const r = await attemptLogin(ctx, username, password);
        if (r.success) return new WebRedirect(postLoginRedirect(ctx));
        error = r.message;
      }
    }
    const timeout = (req.query as Record<string, string>).timeout;
    return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login - ${ctx.svc.env.APP_NAME}</title>
<link href="${BS_CSS}" rel="stylesheet">
<link href="${FA_CSS}" rel="stylesheet">
<link href="${ctx.baseUrl('assets/css/app.css')}" rel="stylesheet">
<style>
body{background:linear-gradient(135deg,#0b3d91 0%,#00b4d8 100%);min-height:100vh;display:flex;align-items:center;}
.login-card{max-width:400px;width:100%;margin:0 auto;border:0;border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.25);}
.brand-badge{width:64px;height:64px;border-radius:14px;background:#0b3d91;color:#fff;display:flex;align-items:center;justify-content:center;font-size:28px;margin:0 auto 12px;}
</style>
</head>
<body>
<div class="container">
  <div class="card login-card">
    <div class="card-body p-4 p-md-5">
      <div class="text-center mb-4">
        <div class="brand-badge"><i class="fa-solid fa-shirt"></i></div>
        <h4 class="fw-bold mb-0">URBAN DRY CLEAN</h4>
        <small class="text-muted">Laundry & Dry Cleaning Management</small>
      </div>
      ${timeout && timeout !== '0' ? html`
        <div class="alert alert-warning py-2">Your session expired. Please log in again.</div>` : ''}
      ${error ? html`
        <div class="alert alert-danger py-2">${error}</div>` : ''}
      <form method="POST" autocomplete="off">
        ${ctx.csrfField()}
        <div class="mb-3">
          <label class="form-label">Username or Email</label>
          <input type="text" name="username" class="form-control form-control-lg" required autofocus>
        </div>
        <div class="mb-3">
          <label class="form-label">Password</label>
          <input type="password" name="password" class="form-control form-control-lg" required>
        </div>
        <div class="d-flex justify-content-between align-items-center mb-3">
          <a href="${ctx.baseUrl('modules/auth/forgot-password.php')}" class="small">Forgot password?</a>
        </div>
        <button type="submit" class="btn btn-primary btn-lg w-100">Login</button>
      </form>
    </div>
  </div>
</div>
</body>
</html>`;
  });

  // ---- logout ------------------------------------------------------------------------------
  webPage(app, '/modules/auth/logout', { auth: 'public' }, async (ctx) => {
    await logoutUser(ctx);
    return new WebRedirect('modules/auth/login.php');
  });

  // ---- forgot / reset password -------------------------------------------------------------
  const smallHead = (ctx: WebCtx, title: string) => html`<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - ${ctx.svc.env.APP_NAME}</title>
<link href="${BS_CSS}" rel="stylesheet">
<style>body{background:#f1f5f9;min-height:100vh;display:flex;align-items:center;}</style>
</head>`;

  webPage(app, '/modules/auth/forgot-password', { auth: 'public' }, async (ctx, req) => {
    if (ctx.isLoggedIn()) return new WebRedirect('modules/dashboard/landing.php');
    let message: string | null = null;
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const identifier = (field(ctx, 'identifier') || field(ctx, 'email')).trim();
      message = (await ctx.svc.passwordReset.request(identifier, req.ip)).message;
    }
    return html`<!DOCTYPE html>
<html lang="en">
${smallHead(ctx, 'Forgot Password')}
<body>
<div class="container">
  <div class="card mx-auto" style="max-width:420px;">
    <div class="card-body p-4">
      <h5 class="fw-bold mb-3">Reset your password</h5>
      ${message ? html`
        <div class="alert alert-info">${message}</div>` : ''}
      <form method="POST">
        ${ctx.csrfField()}
        <div class="mb-3">
          <label class="form-label">Username, email or mobile</label>
          <input type="text" name="identifier" class="form-control" required autocomplete="username">
          <div class="form-text">The reset link is sent on WhatsApp to the mobile number saved on your account.</div>
        </div>
        <button class="btn btn-primary w-100" type="submit">Send Reset Link</button>
      </form>
      <div class="text-center mt-3">
        <a href="${ctx.baseUrl('modules/auth/login.php')}">Back to login</a>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;
  });

  webPage(app, '/modules/auth/reset-password', { auth: 'public' }, async (ctx, req) => {
    if (ctx.isLoggedIn()) return new WebRedirect('modules/dashboard/landing.php');
    const qToken = (req.query as Record<string, unknown>).token;
    const token = (typeof qToken === 'string' ? qToken : field(ctx, 'token')).trim();
    let message: string | null = null;
    let success = false;
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const pw1 = field(ctx, 'password');
      const pw2 = field(ctx, 'password_confirm');
      if (bytes(pw1) < 8) message = 'Password must be at least 8 characters.';
      else if (pw1 !== pw2) message = 'Passwords do not match.';
      else {
        const r = await resetPasswordWithToken(ctx.svc, token, pw1, req.ip);
        message = r.message;
        success = r.success;
      }
    }
    return html`<!DOCTYPE html>
<html lang="en">
${smallHead(ctx, 'Reset Password')}
<body>
<div class="container">
  <div class="card mx-auto" style="max-width:420px;">
    <div class="card-body p-4">
      <h5 class="fw-bold mb-3">Set a new password</h5>
      ${message ? html`
        <div class="alert alert-${success ? 'success' : 'danger'}">${message}</div>` : ''}
      ${!success ? html`
      <form method="POST">
        ${ctx.csrfField()}
        <input type="hidden" name="token" value="${token}">
        <div class="mb-3">
          <label class="form-label">New Password</label>
          <input type="password" name="password" class="form-control" minlength="8" required>
        </div>
        <div class="mb-3">
          <label class="form-label">Confirm Password</label>
          <input type="password" name="password_confirm" class="form-control" minlength="8" required>
        </div>
        <button class="btn btn-primary w-100" type="submit">Reset Password</button>
      </form>` : html`
        <a href="${ctx.baseUrl('modules/auth/login.php')}" class="btn btn-primary w-100">Go to Login</a>`}
    </div>
  </div>
</div>
</body>
</html>`;
  });

  // ---- change password ---------------------------------------------------------------------
  webPage(app, '/modules/auth/change-password', { auth: 'login' }, async (ctx, req) => {
    let message: string | null = null;
    let success = false;
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const current = field(ctx, 'current_password');
      const n1 = field(ctx, 'new_password');
      const n2 = field(ctx, 'new_password_confirm');
      if (bytes(n1) < 8) message = 'New password must be at least 8 characters.';
      else if (n1 !== n2) message = 'New passwords do not match.';
      else {
        const r = await changePassword(ctx.svc, ctx.data.user_id!, current, n1, req.ip);
        message = r.message;
        success = r.success;
      }
    }
    return layout(ctx, { title: 'Change Password' }, html`
<div class="col-md-6">
  <div class="card">
    <div class="card-body">
      ${message ? html`
        <div class="alert alert-${success ? 'success' : 'danger'}">${message}</div>` : ''}
      <form method="POST">
        ${ctx.csrfField()}
        <div class="mb-3">
          <label class="form-label">Current Password</label>
          <input type="password" name="current_password" class="form-control" required>
        </div>
        <div class="mb-3">
          <label class="form-label">New Password</label>
          <input type="password" name="new_password" class="form-control" minlength="8" required>
        </div>
        <div class="mb-3">
          <label class="form-label">Confirm New Password</label>
          <input type="password" name="new_password_confirm" class="form-control" minlength="8" required>
        </div>
        <button class="btn btn-primary" type="submit">Update Password</button>
      </form>
    </div>
  </div>
</div>`);
  });
}
