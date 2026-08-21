import { getSpreadsheetId } from './buyer-sheets.js';
import { syncApprovedSheetItems } from './sheet-maintenance.js';

async function main() {
  console.log(JSON.stringify(await syncApprovedSheetItems(getSpreadsheetId()), null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

