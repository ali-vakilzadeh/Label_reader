/**
 * Runs every SQL statement published in UI_messaging_protocol.md against a real
 * control.db, exactly as a UI developer would. A doc that ships queries nobody
 * executed is a doc that lies.
 *
 * Usage: npx tsx tests/contractQueries.ts
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
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

  // This suite exercises the taxonomy channel, which can write reference_data/.
  // Every request it sends is one that must be refused, but the files are
  // snapshotted anyway — a regression here must not leave the client's tables
  // edited.
  const referenceModule = await import('../src/data/referenceTables');
  const referenceSnapshots = new Map<string, Buffer>();
  for (const table of referenceModule.REFERENCE_TABLE_NAMES) {
    const file = path.join(
      referenceModule.REFERENCE_DIR,
      referenceModule.REFERENCE_FILES[table].file,
    );
    referenceSnapshots.set(file, fs.readFileSync(file));
  }
  const restoreReferenceData = (): void => {
    for (const [file, bytes] of referenceSnapshots) {
      if (!fs.readFileSync(file).equals(bytes)) fs.writeFileSync(file, bytes);
    }
    fs.rmSync(path.join(referenceModule.REFERENCE_DIR, '.backups'), {
      recursive: true,
      force: true,
    });
  };

  const uiDb = new Database(path.join(env.dataDir, 'control.db'));
  uiDb.pragma('journal_mode = WAL');
  uiDb.pragma('busy_timeout = 5000');

  console.log('\n== UI connects as a second process would ==');
  check('journal mode is WAL', String(uiDb.pragma('journal_mode', { simple: true })) === 'wal');
  check('busy_timeout applied', Number(uiDb.pragma('busy_timeout', { simple: true })) === 5000);

  console.log('\n== UIMP §3 server_status ==');
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

  console.log('\n== UIMP §4 open events, localised ==');
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

  console.log('\n== UIMP §8 translations survive a dictionary reseed ==');
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

  console.log('\n== UIMP §5 every catalogued code is resolvable ==');
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

  console.log('\n== UIMP §6 command lifecycle from the UI side ==');
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

  console.log('\n== UIMP §6 unknown commands are rejected, not ignored ==');
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

  console.log('\n== UIMP §11 acknowledgement query ==');
  uiDb
    .prepare(
      `UPDATE server_events
       SET acknowledged_at = ?, acknowledged_by = 'ui:contract_test'
       WHERE acknowledged_at IS NULL`,
    )
    .run(Date.now());
  check('acknowledgement query runs', true);

  console.log('\n== UIMP §11 untranslated-codes query ==');
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

  console.log('\n== UIMP §11 prioritised actionable query ==');
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

  console.log('\n== UIMP \u00a79.2 reference_data_status is published ==');
  const refStatus = uiDb
    .prepare('SELECT * FROM reference_data_status WHERE id = 1')
    .get() as Record<string, unknown> | undefined;
  check('reference status row readable', refStatus !== undefined);
  for (const column of ['version', 'counts_json', 'untranslated', 'loaded_at', 'updated_at']) {
    check(
      `documented column "${column}" exists`,
      refStatus !== undefined && column in refStatus,
      refStatus === undefined ? 'no row' : Object.keys(refStatus),
    );
  }
  check(
    'version matches what the middleware serves',
    refStatus?.version === (await import('../src/data/referenceTables')).referenceVersion(),
    refStatus?.version,
  );
  let counts: Record<string, { rows: number; armenian: number; bilingual: boolean }> = {};
  try {
    counts = JSON.parse(String(refStatus?.counts_json ?? '{}'));
  } catch {
    /* reported by the check below */
  }
  check('counts_json parses and covers all seven tables',
    Object.keys(counts).length === 7, Object.keys(counts));
  check('counts_json reports sub_category rows', counts.sub_category?.rows === 295,
    counts.sub_category);
  check('brand is published as English-only', counts.brand?.bilingual === false, counts.brand);

  console.log('\n== UIMP \u00a79.2 a taxonomy request round-trips ==');
  // Submitted exactly as the doc tells a UI developer to submit it.
  const reqId = Number(
    uiDb
      .prepare(
        `INSERT INTO reference_data_requests
           (action, table_name, english, armenian, entry_id, submitted_at, submitted_by, status)
         VALUES ('SET_ARMENIAN', 'sub_category', 'Hoodie', 'Hoodie', NULL, ?, 'ui:contract_test', 'PENDING')`,
      )
      .run(Date.now()).lastInsertRowid,
  );
  const { processPendingReferenceRequests } = await import('../src/services/controlService');
  processPendingReferenceRequests();
  const resolved = uiDb
    .prepare('SELECT status, result_detail, resolved_at FROM reference_data_requests WHERE id = ?')
    .get(reqId) as { status: string; result_detail: string | null; resolved_at: number | null };
  // "Hoodie" for "Hoodie" is the documented "stays English" form, but the table
  // already has real Armenian for it, so this must come back REJECTED with a
  // reason rather than overwriting the client's word.
  check('request reaches a terminal status', resolved.status !== 'PENDING', resolved);
  check('the English word is refused for an already-translated row',
    resolved.status === 'REJECTED', resolved);
  check('the rejection carries a readable reason', Boolean(resolved.result_detail), resolved);
  check('resolved_at is stamped', resolved.resolved_at !== null, resolved);

  // The point of the check above: a supervisor copying the English cell must not
  // be able to discard Armenian the client supplied. Nothing was written.
  const hoodie = (await import('../src/data/referenceTables'))
    .referenceEntries('sub_category')
    .find((entry) => entry.en === 'Hoodie');
  check('the client\u2019s Armenian for Hoodie is intact',
    hoodie?.hy === '\u0540\u0578\u0582\u0564\u056B', hoodie);

  console.log('\n== UIMP \u00a79.2 REFERENCE_DATA_RELOAD ==');
  const reloadId = Number(
    uiDb
      .prepare(
        `INSERT INTO ui_commands (command, payload_json, issued_at, issued_by, status)
         VALUES ('REFERENCE_DATA_RELOAD', NULL, ?, 'ui:contract_test', 'PENDING')`,
      )
      .run(Date.now()).lastInsertRowid,
  );
  processPendingCommands();
  const reloadRow = uiDb
    .prepare('SELECT status, result_detail FROM ui_commands WHERE id = ?')
    .get(reloadId) as { status: string; result_detail: string | null };
  check('reload command completes', reloadRow.status === 'DONE', reloadRow);
  check('reload reports the version', /version/i.test(reloadRow.result_detail ?? ''), reloadRow);

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
  restoreReferenceData();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
