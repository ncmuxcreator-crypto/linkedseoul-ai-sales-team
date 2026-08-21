import crypto from 'node:crypto';
import { google } from 'googleapis';
import type { BuyerAgentOutput, BuyerContactCandidate } from './buyer-schema.js';

const APPROVAL_SHEET = 'Approval Queue';
const CONTACT_SHEET = '담당자';
const AI_TEAM_SHEET = 'AI Team';
const MASTER_SHEET = 'Tier1_마스터';
const CONTACT_SCAN_LAST_ROW = 1200;
const APPROVAL_LAST_ROW = 1000;

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

export function getSpreadsheetId(): string {
  return required('GOOGLE_SHEETS_ID');
}

export type BuyerTargetAccount = {
  company: string;
  makerOem: string;
  applications: string[];
  attackScore: number;
  marketSummary: string;
  sourceUrls: string[];
  approvalIds: string[];
};

export type ExistingContact = {
  contactId: string;
  linkedinUrl: string;
  tier1: string;
  personName: string;
  company: string;
  title: string;
  region: string;
};

type MasterRow = {
  masterId: string;
  company: string;
  makerOem: string;
  relevance: string;
  priority: string;
};

type ContactInsertionPoint = {
  maxId: number;
  nextRow: number;
};

type PromotionResult = {
  promoted: number;
  skippedDuplicates: number;
  legacySkipped: number;
  promotedIds: string[];
};

function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, '')
    .replace(/[\s._\-–—/()]+/g, '')
    .trim();
}

function roleLabel(role: BuyerContactCandidate['roleCategory']): string {
  switch (role) {
    case 'direct-buyer': return '직접 구매 후보';
    case 'purchasing-leader': return '구매 연결자';
    case 'supplier-development': return '공급사 등록 연결자';
    case 'project-purchasing': return '프로젝트 구매 후보';
    case 'engineering-routing': return '기술/조직 연결자';
  }
}

function verificationLabel(level: BuyerContactCandidate['verificationLevel']): string {
  return level === 'public-confirmed' ? '공개정보 검증' : '유력 후보';
}

function priorityFromScore(score: number): string {
  if (score >= 90) return 'P1';
  if (score >= 80) return 'P2';
  return 'P3';
}

function dateOnly(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

function contactDedupeKey(candidate: BuyerContactCandidate): string {
  return crypto
    .createHash('sha256')
    .update(`${norm(candidate.linkedinUrl)}|${norm(candidate.personName)}|${norm(candidate.company)}`)
    .digest('hex')
    .slice(0, 20);
}

function parseQueueCompanyPerson(value: string): { company: string; personName: string } {
  const [company = '', ...rest] = value.split('/');
  return { company: company.trim(), personName: rest.join('/').trim() };
}

export async function readBuyerTargets(
  spreadsheetId: string,
  maxAccounts: number
): Promise<BuyerTargetAccount[]> {
  const sheets = api();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${APPROVAL_SHEET}'!A2:W${APPROVAL_LAST_ROW}`
  });

  const rows = result.data.values ?? [];
  const grouped = new Map<string, BuyerTargetAccount>();

  for (const row of rows) {
    const approvalId = String(row[0] ?? '').trim();
    const requestingAgent = String(row[2] ?? '');
    const targetType = String(row[3] ?? '');
    const company = String(row[4] ?? '').trim();
    const approvalStatus = String(row[7] ?? '');
    const executionStatus = String(row[12] ?? '');
    const makerOem = String(row[15] ?? '');
    const application = String(row[16] ?? '');
    const attackScore = Number(row[17] ?? 0);
    const sources = String(row[20] ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const summary = String(row[21] ?? '');

    if (requestingAgent !== 'Market Agent') continue;
    if (targetType !== '공략 후보') continue;
    if (approvalStatus !== '승인') continue;
    if (executionStatus === '적용완료' || executionStatus === '진행중') continue;
    if (!company || attackScore < 50) continue;

    const key = norm(company);
    const previous = grouped.get(key);
    if (!previous) {
      grouped.set(key, {
        company,
        makerOem,
        applications: application ? [application] : [],
        attackScore,
        marketSummary: summary,
        sourceUrls: sources,
        approvalIds: approvalId ? [approvalId] : []
      });
      continue;
    }

    if (application && !previous.applications.includes(application)) previous.applications.push(application);
    previous.sourceUrls = [...new Set([...previous.sourceUrls, ...sources])];
    if (approvalId && !previous.approvalIds.includes(approvalId)) previous.approvalIds.push(approvalId);
    if (attackScore > previous.attackScore) {
      previous.attackScore = attackScore;
      previous.marketSummary = summary;
      previous.makerOem = makerOem || previous.makerOem;
    }
  }

  return [...grouped.values()]
    .sort((a, b) => b.attackScore - a.attackScore)
    .slice(0, maxAccounts);
}

async function readActualContacts(spreadsheetId: string): Promise<ExistingContact[]> {
  const sheets = api();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${CONTACT_SHEET}'!A2:Z${CONTACT_SCAN_LAST_ROW}`
  });

  return (result.data.values ?? [])
    .filter(row => String(row[6] ?? '').trim())
    .map(row => ({
      contactId: String(row[0] ?? ''),
      linkedinUrl: String(row[4] ?? ''),
      tier1: String(row[5] ?? ''),
      personName: String(row[6] ?? ''),
      company: String(row[7] ?? ''),
      title: String(row[8] ?? ''),
      region: String(row[9] ?? '')
    }));
}

export async function readExistingContacts(spreadsheetId: string): Promise<ExistingContact[]> {
  const actual = await readActualContacts(spreadsheetId);
  const sheets = api();
  const queue = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${APPROVAL_SHEET}'!A2:AE${APPROVAL_LAST_ROW}`
  });

  const queued: ExistingContact[] = [];
  for (const row of queue.data.values ?? []) {
    if (String(row[3] ?? '') !== '신규 담당자 후보') continue;
    const parsed = parseQueueCompanyPerson(String(row[4] ?? ''));
    const personName = String(row[27] ?? parsed.personName).trim();
    const company = String(row[26] ?? parsed.company).trim();
    if (!personName || !company) continue;
    queued.push({
      contactId: String(row[14] ?? ''),
      linkedinUrl: String(row[6] ?? ''),
      tier1: company,
      personName,
      company: String(row[23] ?? company),
      title: String(row[24] ?? ''),
      region: String(row[25] ?? '')
    });
  }

  return [...actual, ...queued];
}

async function readMasterRows(spreadsheetId: string): Promise<MasterRow[]> {
  const sheets = api();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${MASTER_SHEET}'!A2:Q1000`
  });

  return (result.data.values ?? []).map(row => ({
    masterId: String(row[0] ?? ''),
    company: String(row[1] ?? ''),
    makerOem: String(row[2] ?? ''),
    relevance: String(row[7] ?? ''),
    priority: String(row[8] ?? '')
  }));
}

function findDuplicate(candidate: BuyerContactCandidate, existing: ExistingContact[]): ExistingContact | undefined {
  const candidateUrl = norm(candidate.linkedinUrl || '');
  const candidateNameCompany = `${norm(candidate.personName)}|${norm(candidate.company)}`;

  return existing.find(row => {
    if (candidateUrl && norm(row.linkedinUrl) === candidateUrl) return true;
    const existingNameCompany = `${norm(row.personName)}|${norm(row.tier1 || row.company)}`;
    return existingNameCompany === candidateNameCompany;
  });
}

function isDuplicate(candidate: BuyerContactCandidate, existing: ExistingContact[]): boolean {
  return Boolean(findDuplicate(candidate, existing));
}

export async function queuePendingContactApprovals(
  spreadsheetId: string,
  output: BuyerAgentOutput,
  targets: BuyerTargetAccount[],
  existing: ExistingContact[]
): Promise<{ queued: number; duplicatesSkipped: number; candidateIds: string[] }> {
  const sheets = api();
  const workingExisting = [...existing];
  const fresh: BuyerContactCandidate[] = [];
  let duplicatesSkipped = 0;

  for (const candidate of output.contacts) {
    if (isDuplicate(candidate, workingExisting)) {
      duplicatesSkipped += 1;
      continue;
    }
    fresh.push(candidate);
    workingExisting.push({
      contactId: '',
      linkedinUrl: candidate.linkedinUrl,
      tier1: candidate.company,
      personName: candidate.personName,
      company: candidate.currentCompany,
      title: candidate.currentTitle,
      region: candidate.region
    });
  }

  if (!fresh.length) return { queued: 0, duplicatesSkipped, candidateIds: [] };

  const batchId = Date.now();
  const candidateIds: string[] = [];
  const rows = fresh.map((candidate, index) => {
    const candidateId = `BUY-CAND-${batchId}-${String(index + 1).padStart(2, '0')}`;
    candidateIds.push(candidateId);
    const target = targets.find(item => norm(item.company) === norm(candidate.company));
    const summary = [
      candidate.whyRelevant,
      `First question: ${candidate.firstQuestion}`,
      `Evidence: ${candidate.evidenceSummary}`
    ].join('\n');

    return [
      `AI-BUY-${batchId}-${String(index + 1).padStart(2, '0')}`,
      new Date().toISOString(),
      'Buyer Agent',
      '신규 담당자 후보',
      `${candidate.company} / ${candidate.personName}`,
      `신규 담당자 검토: ${candidate.currentTitle} · ${candidate.region}`,
      candidate.linkedinUrl || candidate.publicProfileUrls[0] || '',
      '대기',
      '',
      '',
      '',
      'CONTACT_REVIEW',
      '대기',
      '',
      candidateId,
      target?.makerOem ?? '',
      candidate.relevantApplication,
      candidate.recommendedScore,
      candidate.confidence,
      roleLabel(candidate.roleCategory),
      candidate.publicProfileUrls.join('\n'),
      summary,
      contactDedupeKey(candidate),
      candidate.currentCompany,
      candidate.currentTitle,
      candidate.region,
      candidate.company,
      candidate.personName,
      candidate.roleCategory,
      candidate.firstQuestion,
      JSON.stringify(candidate)
    ];
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${APPROVAL_SHEET}'!A:AE`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });

  return { queued: rows.length, duplicatesSkipped, candidateIds };
}

export async function markBuyerTargetsExecution(
  spreadsheetId: string,
  targets: BuyerTargetAccount[],
  status: '진행중' | '적용완료' | '오류'
): Promise<void> {
  const approvalIds = new Set(targets.flatMap(target => target.approvalIds));
  if (!approvalIds.size) return;

  const sheets = api();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${APPROVAL_SHEET}'!A2:O${APPROVAL_LAST_ROW}`
  });
  const data = (result.data.values ?? []).flatMap((row, index) => {
    const approvalId = String(row[0] ?? '');
    if (!approvalIds.has(approvalId)) return [];
    const rowNumber = index + 2;
    return [{
      range: `'${APPROVAL_SHEET}'!M${rowNumber}:N${rowNumber}`,
      values: [[status, new Date().toISOString()]]
    }];
  });
  if (!data.length) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data }
  });
}

async function findContactInsertionPoint(
  sheets: ReturnType<typeof api>,
  spreadsheetId: string
): Promise<ContactInsertionPoint> {
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${CONTACT_SHEET}'!A2:A${CONTACT_SCAN_LAST_ROW}`
  });

  let maxId = 0;
  let maxIdRow = 1;
  (result.data.values ?? []).forEach((row, index) => {
    const match = String(row[0] ?? '').match(/^CON-(\d+)$/);
    if (!match) return;
    const numericId = Number(match[1]);
    if (numericId > maxId) {
      maxId = numericId;
      maxIdRow = index + 2;
    }
  });
  return { maxId, nextRow: maxIdRow + 1 };
}

function hasAnyCellValue(rows: unknown[][]): boolean {
  return rows.some(row => row.some(value => String(value ?? '').trim() !== ''));
}

async function getSheetId(
  sheets: ReturnType<typeof api>,
  spreadsheetId: string,
  title: string
): Promise<number> {
  const result = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)'
  });
  const sheet = result.data.sheets?.find(item => item.properties?.title === title);
  const sheetId = sheet?.properties?.sheetId;
  if (typeof sheetId !== 'number') throw new Error(`Sheet not found: ${title}`);
  return sheetId;
}

async function reserveContactRows(
  sheets: ReturnType<typeof api>,
  spreadsheetId: string,
  startRow: number,
  rowCount: number
): Promise<void> {
  const endRow = startRow + rowCount - 1;
  const target = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${CONTACT_SHEET}'!A${startRow}:Z${endRow}`
  });
  if (!hasAnyCellValue((target.data.values ?? []) as unknown[][])) return;

  const sheetId = await getSheetId(sheets, spreadsheetId, CONTACT_SHEET);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        insertDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: startRow - 1,
            endIndex: startRow - 1 + rowCount
          },
          inheritFromBefore: true
        }
      }]
    }
  });
}

function contactSheetRow(
  candidate: BuyerContactCandidate,
  contactId: string,
  master: MasterRow | undefined,
  makerOemFallback: string
): unknown[] {
  const memo = [
    '[AI 승인 적용]',
    candidate.evidenceSummary,
    candidate.publicProfileUrls.join(' | ')
  ].filter(Boolean).join(' ');

  return [
    contactId,
    '',
    candidate.recommendedScore,
    master?.priority ?? '',
    candidate.linkedinUrl,
    candidate.company,
    candidate.personName,
    candidate.currentCompany,
    candidate.currentTitle,
    candidate.region,
    roleLabel(candidate.roleCategory),
    priorityFromScore(candidate.recommendedScore),
    candidate.whyRelevant,
    verificationLabel(candidate.verificationLevel),
    dateOnly(),
    candidate.firstQuestion,
    '미착수',
    '',
    '현재 재직·직무 및 Commodity 소유권 재확인 후 접촉 검토',
    '',
    'Tracy',
    memo,
    master?.masterId ?? '',
    master?.makerOem ?? makerOemFallback,
    master?.relevance ?? '신호 기반',
    master ? '마스터 연계' : '마스터 외'
  ];
}

export async function stampApprovalMetadata(spreadsheetId: string): Promise<number> {
  const sheets = api();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${APPROVAL_SHEET}'!A2:J${APPROVAL_LAST_ROW}`
  });
  const now = new Date().toISOString();
  const data: Array<{ range: string; values: string[][] }> = [];

  (result.data.values ?? []).forEach((row, index) => {
    if (String(row[7] ?? '') !== '승인') return;
    const approver = String(row[8] ?? '').trim();
    const approvedAt = String(row[9] ?? '').trim();
    if (approver && approvedAt) return;
    const rowNumber = index + 2;
    data.push({
      range: `'${APPROVAL_SHEET}'!I${rowNumber}:J${rowNumber}`,
      values: [[approver || 'Tracy', approvedAt || now]]
    });
  });

  if (!data.length) return 0;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data }
  });
  return data.length;
}

export async function promoteApprovedContacts(spreadsheetId: string): Promise<PromotionResult> {
  const sheets = api();
  const queueResult = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${APPROVAL_SHEET}'!A2:AE${APPROVAL_LAST_ROW}`
  });
  const masterRows = await readMasterRows(spreadsheetId);
  const actualContacts = await readActualContacts(spreadsheetId);
  const promotionCandidates: Array<{ rowNumber: number; candidate: BuyerContactCandidate; makerOem: string }> = [];
  const statusUpdates: Array<{ rowNumber: number; status: '스킵'; linkId: string }> = [];
  let legacySkipped = 0;
  let skippedDuplicates = 0;

  for (const [index, row] of (queueResult.data.values ?? []).entries()) {
    const rowNumber = index + 2;
    if (String(row[3] ?? '') !== '신규 담당자 후보') continue;
    if (String(row[7] ?? '') !== '승인') continue;
    const executionStatus = String(row[12] ?? '');
    if (executionStatus === '적용완료' || executionStatus === '스킵') continue;

    const payload = String(row[30] ?? '').trim();
    if (!payload) {
      const legacyLinkId = String(row[14] ?? '');
      if (legacyLinkId.startsWith('CON-') && actualContacts.some(contact => contact.contactId === legacyLinkId)) {
        legacySkipped += 1;
        statusUpdates.push({ rowNumber, status: '스킵', linkId: legacyLinkId });
      }
      continue;
    }

    let candidate: BuyerContactCandidate;
    try {
      candidate = JSON.parse(payload) as BuyerContactCandidate;
    } catch {
      statusUpdates.push({ rowNumber, status: '스킵', linkId: 'INVALID_PAYLOAD' });
      continue;
    }

    const duplicate = findDuplicate(candidate, actualContacts);
    if (duplicate) {
      skippedDuplicates += 1;
      statusUpdates.push({ rowNumber, status: '스킵', linkId: duplicate.contactId || 'DUPLICATE' });
      continue;
    }

    promotionCandidates.push({
      rowNumber,
      candidate,
      makerOem: String(row[15] ?? '')
    });
  }

  const promotedIds: string[] = [];
  if (promotionCandidates.length) {
    const insertionPoint = await findContactInsertionPoint(sheets, spreadsheetId);
    let maxId = insertionPoint.maxId;
    const rows = promotionCandidates.map(item => {
      const contactId = `CON-${String(++maxId).padStart(3, '0')}`;
      promotedIds.push(contactId);
      const master = masterRows.find(row => norm(row.company) === norm(item.candidate.company));
      actualContacts.push({
        contactId,
        linkedinUrl: item.candidate.linkedinUrl,
        tier1: item.candidate.company,
        personName: item.candidate.personName,
        company: item.candidate.currentCompany,
        title: item.candidate.currentTitle,
        region: item.candidate.region
      });
      return contactSheetRow(item.candidate, contactId, master, item.makerOem);
    });

    await reserveContactRows(sheets, spreadsheetId, insertionPoint.nextRow, rows.length);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${CONTACT_SHEET}'!A${insertionPoint.nextRow}:Z${insertionPoint.nextRow + rows.length - 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: rows }
    });
  }

  const now = new Date().toISOString();
  const data: Array<{ range: string; values: string[][] }> = [];
  promotionCandidates.forEach((item, index) => {
    data.push({
      range: `'${APPROVAL_SHEET}'!M${item.rowNumber}:O${item.rowNumber}`,
      values: [['적용완료', now, promotedIds[index]]]
    });
  });
  statusUpdates.forEach(item => {
    data.push({
      range: `'${APPROVAL_SHEET}'!M${item.rowNumber}:O${item.rowNumber}`,
      values: [[item.status, now, item.linkId]]
    });
  });
  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });
  }

  return {
    promoted: promotedIds.length,
    skippedDuplicates,
    legacySkipped,
    promotedIds
  };
}

export async function updateBuyerAgentStatus(
  spreadsheetId: string,
  status: '대기' | '실행 중' | '검토 필요' | '오류',
  recentOutput: string,
  approvalNeeded: number,
  notes = ''
): Promise<void> {
  const sheets = api();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${AI_TEAM_SHEET}'!A2:J20`
  });
  const rows = result.data.values ?? [];
  let relativeIndex = rows.findIndex(row => row[0] === 'Buyer Agent');
  if (relativeIndex < 0) relativeIndex = rows.length;
  const rowNumber = relativeIndex + 2;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${AI_TEAM_SHEET}'!A${rowNumber}:J${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        'Buyer Agent',
        status,
        new Date().toISOString(),
        recentOutput,
        approvalNeeded,
        0,
        '승인된 공략기회만 신규 구매담당자 조사',
        'Approval Queue 승인=승인 · 담당자 기존/대기 후보 exclusion · 공개 웹',
        'Approval Queue 신규 담당자 후보',
        notes || '기회 승인 전 조사 금지 · 담당자 승인 전 담당자 시트 반영 금지 · 외부 접촉 금지'
      ]]
    }
  });
}
