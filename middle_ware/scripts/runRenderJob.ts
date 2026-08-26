/**
 * Manual trigger for the studio render batch — same code path the 20:00 cron
 * runs. Useful for catching up after downtime.
 *
 * Usage: npm run render:now
 */
import { runRenderJob } from '../src/services/renderService';
import { closeOperationalDb } from '../src/db/operationalDb';
import { closeFlywheelDb } from '../src/db/flywheelDb';

async function main(): Promise<void> {
  const result = await runRenderJob();
  console.log(JSON.stringify(result, null, 2));
  closeOperationalDb();
  closeFlywheelDb();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
