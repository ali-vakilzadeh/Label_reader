/**
 * Operator account management, driven the way the Web UI drives it.
 *
 * The security-critical properties here are the revocation ones: a 30-day JWT
 * must not outlive a disable or a password change.
 *
 * Usage: npx tsx tests/userManagement.ts
 */
process.env.GEMINI_API_KEY = '';
process.env.CONTROL_HEARTBEAT_MS = '3600000';
process.env.CONTROL_POLL_MS = '3600000';
process.env.QUEUE_DRAIN_MS = '3600000';
process.env.RENDER_CRON_ENABLED = 'false';
process.env.PASSWORD_MIN_LENGTH = '8';
// This suite logs in many times; it is not testing the rate limiter.
process.env.LOGIN_RATE_LIMIT_MAX = '10000';

import type { Server } from 'node:http';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}`, detail ?? '');
  }
}
function section(name: string): void {
  console.log(`\n== ${name} ==`);
}

async function main(): Promise<void> {
  const { controlDb } = await import('../src/db/controlDb');
  const { submitUserRequest, getUser, listUsers } = await import('../src/db/appUsers');
  const { processPendingUserRequests } = await import('../src/services/userService');
  const { createApp } = await import('../src/app');
  const { env } = await import('../src/config/env');

  controlDb.exec('DELETE FROM app_users; DELETE FROM app_user_requests; DELETE FROM server_events;');

  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = (username: string, password: string) =>
    fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

  const lastRequest = () =>
    controlDb.prepare('SELECT * FROM app_user_requests ORDER BY id DESC LIMIT 1').get() as {
      status: string;
      result_detail: string;
      password: string | null;
    };

  // A cheap authenticated call to test whether a token is still accepted.
  const ping = (token: string) =>
    fetch(`${base}/api/v1/vision/result/NO-SUCH-SCAN`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  // ------------------------------------------------------------------------
  section('UI creates an operator');
  submitUserRequest({
    action: 'CREATE',
    username: 'operator_01',
    password: 'correct-horse-battery',
    displayName: 'Anahit G.',
    submittedBy: 'ui:admin',
  });
  processPendingUserRequests();

  const created = lastRequest();
  check('request APPLIED', created.status === 'APPLIED', created);
  check('plaintext password erased from the request', created.password === null, created.password);

  const stored = getUser('operator_01');
  check('account exists and is ACTIVE', stored?.status === 'ACTIVE', stored?.status);
  check('password is not stored in the clear',
    !JSON.stringify(stored).includes('correct-horse-battery'));
  check('salt is per-user', typeof stored?.password_salt === 'string' && stored.password_salt.length > 10);
  check('display name kept', stored?.display_name === 'Anahit G.', stored?.display_name);

  section('The new operator can log in');
  const good = await login('operator_01', 'correct-horse-battery');
  const goodBody = (await good.json()) as { token: string };
  check('login succeeds', good.status === 200, good.status);
  check('token issued', typeof goodBody.token === 'string');
  check('last_login_at recorded', typeof getUser('operator_01')?.last_login_at === 'number');

  const wrong = await login('operator_01', 'wrong-password');
  const wrongBody = (await wrong.json()) as { error_code: string };
  check('wrong password rejected', wrong.status === 401, wrong.status);
  check('generic error code', wrongBody.error_code === 'INVALID_CREDENTIALS', wrongBody);

  section('Validation');
  submitUserRequest({ action: 'CREATE', username: 'ab', password: 'longenough1', submittedBy: 'ui:admin' });
  processPendingUserRequests();
  check('short username rejected', lastRequest().status === 'REJECTED', lastRequest());

  submitUserRequest({ action: 'CREATE', username: 'operator_02', password: 'short', submittedBy: 'ui:admin' });
  processPendingUserRequests();
  const shortPw = lastRequest();
  check('short password rejected', shortPw.status === 'REJECTED', shortPw.status);
  check('rejection says why', /at least 8/.test(shortPw.result_detail), shortPw.result_detail);
  check('no account created for it', getUser('operator_02') === undefined);

  submitUserRequest({
    action: 'CREATE',
    username: 'operator_01',
    password: 'another-password',
    submittedBy: 'ui:admin',
  });
  processPendingUserRequests();
  check('duplicate username rejected', lastRequest().status === 'REJECTED', lastRequest().status);

  submitUserRequest({ action: 'SET_PASSWORD', username: 'ghost_user', password: 'whatever12', submittedBy: 'ui:admin' });
  processPendingUserRequests();
  check('operating on an unknown user is rejected', lastRequest().status === 'REJECTED');

  // ------------------------------------------------------------------------
  section('Disable signs the operator out IMMEDIATELY');
  submitUserRequest({ action: 'CREATE', username: 'operator_02', password: 'second-operator-pw', submittedBy: 'ui:admin' });
  processPendingUserRequests();
  const secondLogin = await login('operator_02', 'second-operator-pw');
  const secondToken = ((await secondLogin.json()) as { token: string }).token;

  const beforeDisable = await ping(secondToken);
  check('token works before disable', beforeDisable.status === 404, beforeDisable.status);

  submitUserRequest({ action: 'DISABLE', username: 'operator_02', submittedBy: 'ui:admin' });
  processPendingUserRequests();
  check('disable APPLIED', lastRequest().status === 'APPLIED', lastRequest());
  check('account is DISABLED', getUser('operator_02')?.status === 'DISABLED');

  const afterDisable = await ping(secondToken);
  const afterBody = (await afterDisable.json()) as { error_code: string };
  check(
    'existing token refused straight away (not in 30 days)',
    afterDisable.status === 401,
    afterDisable.status,
  );
  check('error code is ACCOUNT_DISABLED', afterBody.error_code === 'ACCOUNT_DISABLED', afterBody);

  const disabledLogin = await login('operator_02', 'second-operator-pw');
  const disabledBody = (await disabledLogin.json()) as { error_code: string };
  check('disabled operator cannot log back in', disabledLogin.status === 401);
  check('told the account is disabled', disabledBody.error_code === 'ACCOUNT_DISABLED', disabledBody);

  section('Re-enable restores access');
  submitUserRequest({ action: 'ENABLE', username: 'operator_02', submittedBy: 'ui:admin' });
  processPendingUserRequests();
  const reLogin = await login('operator_02', 'second-operator-pw');
  check('re-enabled operator can log in', reLogin.status === 200, reLogin.status);

  // ------------------------------------------------------------------------
  section('Password change revokes existing sessions');
  const beforeChange = ((await (await login('operator_01', 'correct-horse-battery')).json()) as {
    token: string;
  }).token;
  check('token valid before the change', (await ping(beforeChange)).status === 404);

  // tokens_valid_from is compared at second granularity; wait past the boundary
  // so the assertion tests revocation rather than clock resolution.
  await new Promise((r) => setTimeout(r, 1100));
  submitUserRequest({
    action: 'SET_PASSWORD',
    username: 'operator_01',
    password: 'a-brand-new-password',
    submittedBy: 'ui:admin',
  });
  processPendingUserRequests();

  const afterChange = await ping(beforeChange);
  const revokedBody = (await afterChange.json()) as { error_code: string };
  check('old token refused after password change', afterChange.status === 401, afterChange.status);
  check('error code is TOKEN_REVOKED', revokedBody.error_code === 'TOKEN_REVOKED', revokedBody);
  check('old password no longer works', (await login('operator_01', 'correct-horse-battery')).status === 401);
  check('new password works', (await login('operator_01', 'a-brand-new-password')).status === 200);

  // ------------------------------------------------------------------------
  section('Delete is a soft delete, and signs out');
  const thirdLogin = await login('operator_02', 'second-operator-pw');
  const thirdToken = ((await thirdLogin.json()) as { token: string }).token;

  submitUserRequest({ action: 'DELETE', username: 'operator_02', submittedBy: 'ui:admin' });
  processPendingUserRequests();
  check('delete APPLIED', lastRequest().status === 'APPLIED', lastRequest());
  check('row retained for audit', getUser('operator_02')?.status === 'DELETED');
  check('hidden from the operator list', !listUsers().some((u) => u.username === 'operator_02'));
  check('deleted operator signed out', (await ping(thirdToken)).status === 401);
  check('deleted operator cannot log in', (await login('operator_02', 'second-operator-pw')).status === 401);

  const publicRows = controlDb.prepare('SELECT * FROM app_users_public').all() as Record<
    string,
    unknown
  >[];
  check('public view hides deleted accounts', !publicRows.some((r) => r.username === 'operator_02'));
  check(
    'public view exposes no credential columns',
    publicRows.every((r) => !('password_hash' in r) && !('password_salt' in r)),
    publicRows[0] ? Object.keys(publicRows[0]) : [],
  );

  section('Recreating a deleted operator restores the record');
  submitUserRequest({
    action: 'CREATE',
    username: 'operator_02',
    password: 'restored-password',
    submittedBy: 'ui:admin',
  });
  processPendingUserRequests();
  check('restore APPLIED', lastRequest().status === 'APPLIED', lastRequest());
  check('account ACTIVE again', getUser('operator_02')?.status === 'ACTIVE');
  check('restored operator can log in', (await login('operator_02', 'restored-password')).status === 200);

  // ------------------------------------------------------------------------
  section('Cannot strand the fleet');
  submitUserRequest({ action: 'DELETE', username: 'operator_02', submittedBy: 'ui:admin' });
  processPendingUserRequests();
  submitUserRequest({ action: 'DISABLE', username: 'operator_01', submittedBy: 'ui:admin' });
  processPendingUserRequests();
  const lastOne = lastRequest();
  check('refuses to disable the last active operator', lastOne.status === 'REJECTED', lastOne);
  check('reason explains it', /last active operator/.test(lastOne.result_detail), lastOne.result_detail);
  check('that operator is still ACTIVE', getUser('operator_01')?.status === 'ACTIVE');

  // ------------------------------------------------------------------------
  section('Legacy shared password still works during migration');
  const legacy = await login('never_registered', env.masterPassword);
  check(
    'unknown username falls back to the master password',
    legacy.status === 200,
    legacy.status,
  );
  const legacyBad = await login('never_registered', 'not-the-master-password');
  check('but only with the correct master password', legacyBad.status === 401, legacyBad.status);
  check(
    'a registered operator does NOT accept the master password',
    (await login('operator_01', env.masterPassword)).status === 401,
  );

  await new Promise<void>((r) => server.close(() => r()));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
