import { getSpreadsheetId } from './buyer-sheets.js';
import { refreshOperationalViews, syncApprovedSheetItems } from './sheet-maintenance.js';

async function main() {
  const startedAt = new Date().toISOString();
  const spreadsheetId = getSpreadsheetId();
  const sync = await syncApprovedSheetItems(spreadsheetId);
  const refresh = await refreshOperationalViews(spreadsheetId, sync, startedAt);
  console.log(JSON.stringify({ sync, refresh }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
