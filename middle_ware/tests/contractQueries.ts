/**
 * Runs every SQL statement published in control_channel_contract.md against a
 * real control.db, exactly as a UI developer would. A doc that ships queries
 * nobody executed is a doc that lies.
 *
 * Usage: npx tsx tests/contractQueries.ts
 */
import Database from 'better-sqlite3';
import path from 'node:path';

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

async function main(): Promise<void> {
  // Boot the middleware's schema, then connect the way the UI would.
  const { env } = await import('../src/config/env');
  await import('../src/db/controlDb');
  const { startControlService } = await import('../src/services/controlService');
  startControlService();

  const uiDb = new Database(path.join(env.dataDir, 'control.db'));
  uiDb.pragma('journal_mode = WAL');
  uiDb.pragma('busy_timeout = 5000');

  console.log('\n== UI connects as a second process would ==');
  check('journal mode is WAL', String(uiDb.pragma('journal_mode', { simple: true })) === 'wal');
  check('busy_timeout applied', Number(uiDb.pragma('busy_timeout', { simple: true })) === 5000);

  console.log('\n== §2 server_status ==');
  const status = uiDb.prepare('SELECT * FROM server_status WHERE id = 1').get() as Record<
    string,
    unknown
  >;
  check('status row readable', status !== undefined);
  for (const column of [
    'state',
    'vision_state',
    'active_fault',
    'active_fault_since',
    'detail',
    'heartbeat_at',
    'started_at',
    'queue_pending',
    'queue_parked',
    'flywheel_records',
    'flywheel_capacity',
  ]) {
    check(`documented column "${column}" exists`, column in status, Object.keys(status));
  }
  check('heartbeat is fresh', Date.now() - Number(status.heartbeat_at) < 60_000);

  console.log('\n== §3 open events, localised ==');
  const openEvents = uiDb
    .prepare(
      `SELECT e.*, d.severity, d.category, d.requires_action,
              COALESCE(t.text, d.default_text) AS text,
              COALESCE(t.hint, d.operator_hint) AS hint
       FROM server_events e
       JOIN message_dictionary d ON d.code = e.code
       LEFT JOIN message_translations t ON t.code = e.code AND t.locale = ?
       WHERE e.resolved_at IS NULL
       ORDER BY e.id ASC`,
    )
    .all('hy');
  check('documented join executes', Array.isArray(openEvents));

  console.log('\n== §3 translations survive a dictionary reseed ==');
  uiDb
    .prepare(
      `INSERT INTO message_translations (code, locale, text, hint, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(code, locale) DO UPDATE SET text = excluded.text, hint = excluded.hint`,
    )
    .run('VISION_BILLING_REQUIRED', 'hy', 'Վճարման ստուգում է անհրաժեշտ', 'Ստուգեք բիլինգը', Date.now());

  // Force the reseed the middleware performs on every boot.
  const { MESSAGE_CATALOGUE } = await import('../src/db/messageCatalogue');
  const reseed = uiDb.prepare(
    `INSERT INTO message_dictionary (code, severity, category, requires_action, default_text, operator_hint, updated_at)
     VALUES (@code,@severity,@category,@requires_action,@default_text,@operator_hint,@updated_at)
     ON CONFLICT(code) DO UPDATE SET default_text = excluded.default_text`,
  );
  for (const entry of MESSAGE_CATALOGUE) {
    reseed.run({
      code: entry.code,
      severity: entry.severity,
      category: entry.category,
      requires_action: entry.requiresAction ? 1 : 0,
      default_text: entry.defaultText,
      operator_hint: entry.operatorHint ?? null,
      updated_at: Date.now(),
    });
  }

  const translated = uiDb
    .prepare('SELECT text FROM message_translations WHERE code = ? AND locale = ?')
    .get('VISION_BILLING_REQUIRED', 'hy') as { text: string } | undefined;
  check(
    'Armenian text survived the reseed',
    translated?.text === 'Վճարման ստուգում է անհրաժեշտ',
    translated,
  );

  console.log('\n== §4 every catalogued code is resolvable ==');
  const codes = uiDb.prepare('SELECT code FROM message_dictionary').all() as { code: string }[];
  check(
    'dictionary holds the whole catalogue',
    codes.length === MESSAGE_CATALOGUE.length,
    `${codes.length} vs ${MESSAGE_CATALOGUE.length}`,
  );
  const actionable = uiDb
    .prepare('SELECT code FROM message_dictionary WHERE requires_action = 1')
    .all() as { code: string }[];
  check('actionable codes present', actionable.length > 0, actionable.length);

  console.log('\n== §5 command lifecycle from the UI side ==');
  const inserted = uiDb
    .prepare(
      `INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
       VALUES (?, ?, ?, ?, 'PENDING')`,
    )
    .run('PING', null, Date.now(), 'ui:contract_test');
  const commandId = Number(inserted.lastInsertRowid);
  check('UI can insert a command', commandId > 0);

  const beforePoll = uiDb.prepare('SELECT status FROM ui_commands WHERE id = ?').get(commandId) as {
    status: string;
  };
  check('starts PENDING', beforePoll.status === 'PENDING', beforePoll);

  const { processPendingCommands } = await import('../src/services/controlService');
  processPendingCommands();

  const afterPoll = uiDb
    .prepare('SELECT status, result_detail, completed_at FROM ui_commands WHERE id = ?')
    .get(commandId) as { status: string; result_detail: string; completed_at: number };
  check('middleware completed it', afterPoll.status === 'DONE', afterPoll);
  check('result_detail is populated', afterPoll.result_detail === 'pong', afterPoll);
  check('completed_at stamped', typeof afterPoll.completed_at === 'number');

  console.log('\n== §5 unknown commands are rejected, not ignored ==');
  const bogus = uiDb
    .prepare(
      `INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
       VALUES ('NOT_A_REAL_COMMAND', NULL, ?, 'ui:contract_test', 'PENDING')`,
    )
    .run(Date.now());
  processPendingCommands();
  const bogusRow = uiDb
    .prepare('SELECT status, result_detail FROM ui_commands WHERE id = ?')
    .get(Number(bogus.lastInsertRowid)) as { status: string; result_detail: string };
  check('unknown command REJECTED', bogusRow.status === 'REJECTED', bogusRow);
  check('rejection explains why', bogusRow.result_detail.includes('Unknown'), bogusRow);

  console.log('\n== §9 acknowledgement query ==');
  uiDb
    .prepare(
      `UPDATE server_events
       SET acknowledged_at = ?, acknowledged_by = 'ui:contract_test'
       WHERE acknowledged_at IS NULL`,
    )
    .run(Date.now());
  check('acknowledgement query runs', true);

  console.log('\n== §9 untranslated-codes query ==');
  const untranslated = uiDb
    .prepare(
      `SELECT d.code FROM message_dictionary d
       LEFT JOIN message_translations t ON t.code = d.code AND t.locale = 'hy'
       WHERE t.code IS NULL`,
    )
    .all() as { code: string }[];
  check(
    'reports codes still needing Armenian',
    untranslated.length === MESSAGE_CATALOGUE.length - 1,
    `${untranslated.length} untranslated of ${MESSAGE_CATALOGUE.length}`,
  );

  console.log('\n== §9 prioritised actionable query ==');
  const prioritised = uiDb
    .prepare(
      `SELECT e.code, d.severity
       FROM server_events e
       JOIN message_dictionary d ON d.code = e.code
       LEFT JOIN message_translations t ON t.code = e.code AND t.locale = 'hy'
       WHERE e.resolved_at IS NULL AND d.requires_action = 1
       ORDER BY CASE d.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, e.id`,
    )
    .all();
  check('prioritised query executes', Array.isArray(prioritised));

  console.log('\n== concurrent write from both processes ==');
  const { raiseEvent } = await import('../src/db/controlDb');
  let concurrentOk = true;
  try {
    for (let i = 0; i < 20; i += 1) {
      raiseEvent('VISION_TRANSIENT', `middleware write ${i}`);
      uiDb
        .prepare(
          `INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
           VALUES ('PING', NULL, ?, 'ui:contract_test', 'PENDING')`,
        )
        .run(Date.now());
    }
  } catch (error) {
    concurrentOk = false;
    console.log('   ', error);
  }
  check('interleaved writes from both sides succeed', concurrentOk);

  uiDb.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
