// run-cypress.mjs passes the settings through the Node API. The `record` task hands each check's result back to the runner
// through a file (a function cannot travel in the Node API's config object).
import { appendFileSync } from 'node:fs';

export default {
  e2e: {
    setupNodeEvents(on) {
      on('task', { record(r) { appendFileSync(process.env.CY_RECORDS, `${JSON.stringify(r)}\n`); return null; } });
    },
  },
};
