import { google } from 'googleapis';

const CONTACT_SHEET = '담당자';
const ACCOUNT_SHEET = '계정_관계';
const CONTACT_SCAN_LAST_ROW = 1200;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: required('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      private_key: required('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY').replace(/\\n/g, '\n')
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

function api() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, '')
    .replace(/[\s._\-–—/()]+/g, '')
    .trim();
}

type AccountRow = {
  accountId: string;
  company: string;
  aliases: string[];
};

function uniqueAccountId(aliasMap: Map<string, Set<string>>, value: string): string {
  const key = norm(value);
  if (!key) return '';
  const ids = aliasMap.get(key);
  if (!ids || ids.size !== 1) return '';
  return [...ids][0] ?? '';
}

export async function backfillMissingContactAccountIds(
  spreadsheetId: string
): Promise<{ updated: number; unresolved: string[] }> {
  const sheets = api();

  const [accountResult, contactResult] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${ACCOUNT_SHEET}'!A2:C1000`
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${CONTACT_SHEET}'!A2:H${CONTACT_SCAN_LAST_ROW}`
    })
  ]);

  const accounts: AccountRow[] = (accountResult.data.values ?? [])
    .map(row => ({
      accountId: String(row[0] ?? '').trim(),
      company: String(row[1] ?? '').trim(),
      aliases: String(row[2] ?? '')
        .split('|')
        .map(value => value.trim())
        .filter(Boolean)
    }))
    .filter(row => row.accountId && row.company);

  const aliasMap = new Map<string, Set<string>>();
  for (const account of accounts) {
    for (const alias of [account.company, ...account.aliases]) {
      const key = norm(alias);
      if (!key) continue;
      const existing = aliasMap.get(key) ?? new Set<string>();
      existing.add(account.accountId);
      aliasMap.set(key, existing);
    }
  }

  const data: Array<{ range: string; values: string[][] }> = [];
  const unresolved: string[] = [];

  for (const [index, row] of (contactResult.data.values ?? []).entries()) {
    const contactId = String(row[0] ?? '').trim();
    const existingAccountId = String(row[1] ?? '').trim();
    if (!/^CON-\d+$/.test(contactId) || existingAccountId) continue;

    const tier1 = String(row[5] ?? '').trim();
    const currentCompany = String(row[7] ?? '').trim();
    const accountId =
      uniqueAccountId(aliasMap, currentCompany) ||
      uniqueAccountId(aliasMap, tier1);

    if (!accountId) {
      unresolved.push(contactId);
      continue;
    }

    const rowNumber = index + 2;
    data.push({
      range: `'${CONTACT_SHEET}'!B${rowNumber}`,
      values: [[accountId]]
    });
  }

  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data
      }
    });
  }

  return { updated: data.length, unresolved };
}
