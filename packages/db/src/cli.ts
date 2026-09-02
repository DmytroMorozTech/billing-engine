import { connectionStringFromEnv, createPool } from './connection.js';
import { migrate, status } from './migrate.js';

const command = process.argv[2] ?? 'up';
const pool = createPool({ connectionString: connectionStringFromEnv() });

try {
  if (command === 'up') {
    const applied = await migrate(pool);
    console.error(
      applied.length === 0
        ? 'No pending migrations.'
        : `Applied ${applied.length}:\n  ${applied.join('\n  ')}`,
    );
  } else if (command === 'status') {
    for (const row of await status(pool)) {
      const state = row.drifted ? 'DRIFTED' : row.applied ? 'applied' : 'pending';
      console.error(`${state.padEnd(8)} ${row.name}`);
    }
  } else {
    console.error(`Unknown command: ${command}. Use "up" or "status".`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
