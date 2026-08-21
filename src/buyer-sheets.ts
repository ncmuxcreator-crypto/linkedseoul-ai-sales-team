import { google } from 'googleapis';
import type { BuyerAgentOutput, BuyerContactCandidate } from './buyer-schema.js';

const APPROVAL_SHEET = 'Approval Queue';
const CONTACT_SHEET = '담당자';
const AI_TEAM_SHEET = 'AI Team';
const MASTER_SHEET = 'Tier1_마스터';

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

function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, '')
    .replace(/[\s._\-–—/()]+/g, '')
    .trim();
}

export async function readBuyerTargets(
  spreadsheetId: string,
  maxAccounts: number
): Promise<BuyerTargetAccount[]> {
  const sheets = api();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${APPROVAL_SHEET}'!A2:W1000`
  });

  const rows = result.data.values ?? [];
  const grouped = new Map<string, BuyerTargetAccount>();

  for (const row of rows) {
    const requestingAgent = String(row[2] ?? '');
    const targetType = String(row[3] ?? '');
    const company = String(row[4] ?? '').trim();
    const approvalStatus = String(row[7] ?? '');
    const makerOem = String(row[15] ?? '');
    const application = String(row[16] ?? '');
    const attackScore = Number(row[17] ?? 0);
    const sources = String(row[20] ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const summary = String(row[21] ?? '');

    if (requestingAgent !== 'Market Agent') continue;
    if (targetType !== '공략 후보') continue;
    if (approvalStatus !== '대기') continue;
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
        sourceUrls: sources
      });
      continue;
    }

    if (application && !previous.applications.includes(application)) {
      previous.applications.push(application);
    }
    previous.sourceUrls = [...new Set([...previous.sourceUrls, ...sources])];
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

export async function readExistingContacts(spreadsheetId: string): Promise<ExistingContact[]> {
  const sheets = api();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${CONTACT_SHEET}'!A2:Z1200`
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

function isDuplicate(candidate: BuyerContactCandidate, existing: ExistingContact[]): boolean {
  const candidateUrl = norm(candidate.linkedinUrl || '');
  const candidateNameCompany = `${norm(candidate.personName)}|${norm(candidate.company)}`;

  return existing.some(row => {
    if (candidateUrl && norm(row.linkedinUrl) === candidateUrl) return true;
    const existingNameCompany = `${norm(row.personName)}|${norm(row.tier1 || row.company)}`;
    return existingNameCompany === candidateNameCompany;
  });
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

export async function appendNewContacts(
  spreadsheetId: string,
  output: BuyerAgentOutput,
  targets: BuyerTargetAccount[],
  existing: ExistingContact[]
): Promise<{ inserted: number; duplicatesSkipped: number; insertedIds: string[] }> {
  const sheets = api();
  const masterRows = await readMasterRows(spreadsheetId);

  const fresh: BuyerContactCandidate[] = [];
  let duplicatesSkipped = 0;
  const workingExisting = [...existing];

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

  if (!fresh.length) return { inserted: 0, duplicatesSkipped, insertedIds: [] };

  const idResult = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${CONTACT_SHEET}'!A2:A1200`
  });
  const existingIds = (idResult.data.values ?? []).flat().map(String);
  let maxId = existingIds.reduce((max, id) => {
    const match = id.match(/^CON-(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

  const insertedIds: string[] = [];
  const rows = fresh.map(candidate => {
    const contactId = `CON-${String(++maxId).padStart(3, '0')}`;
    insertedIds.push(contactId);

    const master = masterRows.find(row => norm(row.company) === norm(candidate.company));
    const target = targets.find(row => norm(row.company) === norm(candidate.company));
    const memo = [
      '[AI 신규 발굴]',
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
      'AI 신규·검토대기',
      '',
      '현재 재직·직무 및 Commodity 소유권 재확인 후 접촉 검토',
      '',
      'Tracy',
      memo,
      master?.masterId ?? '',
      master?.makerOem ?? target?.makerOem ?? '',
      master?.relevance ?? '신호 기반',
      master ? '마스터 연계' : '마스터 외'
    ];
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${CONTACT_SHEET}'!A:Z`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });

  const approvalRows = fresh.map((candidate, index) => [
    `AI-BUY-${Date.now()}-${String(index + 1).padStart(2, '0')}`,
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
    insertedIds[index]
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${APPROVAL_SHEET}'!A:O`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: approvalRows }
  });

  return { inserted: rows.length, duplicatesSkipped, insertedIds };
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
        'Commodity Buyer·Supplier Development·Project Purchasing·Engineering 담당자 신규 발굴',
        'Approval Queue · 담당자 기존 목록 · 공개 웹',
        '담당자 신규 행 · Approval Queue CONTACT_REVIEW',
        notes || '기존 담당자 중복 금지 · 공개근거 확인 · 외부 접촉 금지'
      ]]
    }
  });
}
