import { env } from '../config/env';
import {
  countActiveUsers,
  createUser,
  getUser,
  resolveUserRequest,
  setDisplayName,
  setUserPassword,
  setUserStatus,
  takePendingUserRequests,
  type AppUserRequestRow,
} from '../db/appUsers';
import { raiseEvent, resolveEvent } from '../db/controlDb';
import { logger } from '../utils/logger';

/**
 * Applies operator-account changes submitted by the Web UI.
 *
 * Every request is validated before it takes effect and always resolves to
 * APPLIED or REJECTED with a reason, so the UI can report the outcome rather
 * than leaving an administrator guessing.
 */

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateUsername(username: string): ValidationResult {
  if (!USERNAME_PATTERN.test(username)) {
    return {
      ok: false,
      reason:
        'Username must be 3-64 characters, letters/digits/dot/underscore/hyphen only.',
    };
  }
  return { ok: true };
}

export function validatePassword(password: string): ValidationResult {
  if (password.length < env.passwordMinLength) {
    return { ok: false, reason: `Password must be at least ${env.passwordMinLength} characters.` };
  }
  if (password.trim() !== password) {
    // Leading/trailing spaces survive a copy-paste and then fail at the keypad.
    return { ok: false, reason: 'Password must not begin or end with whitespace.' };
  }
  return { ok: true };
}

function reject(request: AppUserRequestRow, reason: string): void {
  resolveUserRequest(request.id, 'REJECTED', reason);
  raiseEvent('USER_REQUEST_REJECTED', `${request.action} ${request.username}: ${reason}`);
  logger.warn(`User request ${request.id} rejected: ${reason}`);
}

function apply(request: AppUserRequestRow, detail: string, eventCode: string): void {
  resolveUserRequest(request.id, 'APPLIED', detail);
  resolveEvent('USER_REQUEST_REJECTED');
  raiseEvent(eventCode, detail);
  resolveEvent(eventCode);
  logger.info(`User request ${request.id} applied: ${detail}`);
}

/**
 * Drains queued account changes. Called on the same poll as the other UI
 * commands. Never throws: one malformed request must not stall the queue.
 */
export function processPendingUserRequests(): void {
  for (const request of takePendingUserRequests()) {
    try {
      handleRequest(request);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(`User request ${request.id} failed`, error);
      resolveUserRequest(request.id, 'REJECTED', detail);
    }
  }
}

function handleRequest(request: AppUserRequestRow): void {
  const username = request.username.trim();

  const usernameCheck = validateUsername(username);
  if (!usernameCheck.ok) {
    reject(request, usernameCheck.reason!);
    return;
  }

  const existing = getUser(username);

  switch (request.action) {
    case 'CREATE': {
      if (existing && existing.status !== 'DELETED') {
        reject(request, `An operator named "${username}" already exists.`);
        return;
      }
      const password = request.password ?? '';
      const passwordCheck = validatePassword(password);
      if (!passwordCheck.ok) {
        reject(request, passwordCheck.reason!);
        return;
      }

      if (existing) {
        // Reviving a soft-deleted account keeps its history rather than losing
        // the audit trail to a new row.
        setUserPassword(username, password, request.submitted_by);
        setDisplayName(username, request.display_name, request.submitted_by);
        setUserStatus(username, 'ACTIVE', request.submitted_by);
        apply(request, `Operator "${username}" restored.`, 'USER_CREATED');
        return;
      }

      createUser(username, password, request.display_name, request.submitted_by);
      apply(request, `Operator "${username}" created.`, 'USER_CREATED');
      return;
    }

    case 'SET_PASSWORD': {
      if (!existing || existing.status === 'DELETED') {
        reject(request, `No operator named "${username}".`);
        return;
      }
      const password = request.password ?? '';
      const passwordCheck = validatePassword(password);
      if (!passwordCheck.ok) {
        reject(request, passwordCheck.reason!);
        return;
      }
      setUserPassword(username, password, request.submitted_by);
      apply(
        request,
        `Password changed for "${username}". Existing sessions were signed out.`,
        'USER_PASSWORD_CHANGED',
      );
      return;
    }

    case 'DISABLE': {
      if (!existing || existing.status === 'DELETED') {
        reject(request, `No operator named "${username}".`);
        return;
      }
      if (!wouldLeaveAnActiveOperator(username)) {
        reject(request, 'Refusing to disable the last active operator.');
        return;
      }
      setUserStatus(username, 'DISABLED', request.submitted_by);
      apply(
        request,
        `Operator "${username}" disabled and signed out.`,
        'USER_DISABLED',
      );
      return;
    }

    case 'ENABLE': {
      if (!existing || existing.status === 'DELETED') {
        reject(request, `No operator named "${username}".`);
        return;
      }
      setUserStatus(username, 'ACTIVE', request.submitted_by);
      apply(request, `Operator "${username}" re-enabled.`, 'USER_ENABLED');
      return;
    }

    case 'DELETE': {
      if (!existing || existing.status === 'DELETED') {
        reject(request, `No operator named "${username}".`);
        return;
      }
      if (!wouldLeaveAnActiveOperator(username)) {
        reject(request, 'Refusing to delete the last active operator.');
        return;
      }
      // Soft delete. Scans carry the operator's username for attribution, so a
      // hard delete would orphan the audit trail on records that must be kept.
      setUserStatus(username, 'DELETED', request.submitted_by);
      apply(
        request,
        `Operator "${username}" deleted and signed out. Their scan history is retained.`,
        'USER_DELETED',
      );
      return;
    }

    case 'RENAME': {
      if (!existing || existing.status === 'DELETED') {
        reject(request, `No operator named "${username}".`);
        return;
      }
      setDisplayName(username, request.display_name, request.submitted_by);
      apply(request, `Display name updated for "${username}".`, 'USER_UPDATED');
      return;
    }

    default:
      reject(request, `Unknown action "${request.action}".`);
  }
}

/**
 * Guards against an administrator locking the entire fleet out. Only meaningful
 * once accounts exist at all — while the deployment is still on the legacy
 * shared password there is nothing to strand.
 */
function wouldLeaveAnActiveOperator(username: string): boolean {
  const active = countActiveUsers();
  if (active <= 1) {
    const user = getUser(username);
    if (user?.status === 'ACTIVE') return false;
  }
  return true;
}
