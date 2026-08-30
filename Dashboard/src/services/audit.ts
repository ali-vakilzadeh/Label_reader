import { openDashboardDb } from '../db';

/**
 * Every write to `items`, every export and every command issued to the middleware lands
 * here. The order letter requires the workflow to be auditable, and a price that appeared
 * on an invoice must be explicable months later.
 */
export function audit(
  actor: string,
  action: string,
  entity: string,
  entityId: string | null,
  before?: unknown,
  after?: unknown,
): void {
  openDashboardDb()
    .prepare(
      `INSERT INTO audit_log (at, actor, action, entity, entity_id, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Date.now(),
      actor,
      action,
      entity,
      entityId,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
    );
}

export function recentAudit(limit = 200, entityId?: string) {
  const db = openDashboardDb();
  return entityId
    ? db.prepare('SELECT * FROM audit_log WHERE entity_id = ? ORDER BY at DESC LIMIT ?').all(entityId, limit)
    : db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(limit);
}
