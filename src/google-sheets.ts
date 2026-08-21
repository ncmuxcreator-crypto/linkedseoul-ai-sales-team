import crypto from 'node:crypto';
import { google } from 'googleapis';
import type { MarketAgentOutput, MarketCandidate } from './schema.js';

const APPROVAL_SHEET = 'Approval Queue';
const AI_TEAM_SHEET = 'AI Team';

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

export async function ensureAiColumns(spreadsheetId: string): Promise<void> {
  const sheets = api();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${APPROVAL_SHEET}'!P1:W1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        '추정 Maker/OEM',
        'Application',
        'Attack Score',
        'AI Confidence',
        'Make/Buy 메모',
        '근거 URL',
        'AI 영업 요약',
        'AI 중복키'
      ]]
    }
  });
}

function dedupeKey(c: MarketCandidate): string {
  const normalizedSources = [...c.sourceUrls].sort().join('|');
  return crypto
    .createHash('sha256')
    .update(`${c.company}|${c.application}|${c.signalType}|${normalizedSources}`)
    .digest('hex')
    .slice(0, 20);
}

async function existingDedupeKeys(spreadsheetId: string): Promise<Set<string>> {
  const sheets = api();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${APPROVAL_SHEET}'!W2:W1000`
  });
  return new Set((result.data.values ?? []).flat().map(String).filter(Boolean));
}

function approvalRow(c: MarketCandidate, index: number): unknown[] {
  const createdAt = new Date().toISOString();
  const key = dedupeKey(c);
  const summary = [
    c.signalSummary,
    `Why now: ${c.whyNow}`,
    `Recommended buyer: ${c.recommendedBuyerFunctions.join(', ') || '-'}`,
    `Recommended action: ${c.recommendedAction}`,
    c.makerEvidenceNote ? `Maker/OEM note: ${c.makerEvidenceNote}` : ''
  ].filter(Boolean).join('\n');

  return [
    `AI-MKT-${Date.now()}-${String(index + 1).padStart(2, '0')}`,
    createdAt,
    'Market Agent',
    '공략 후보',
    c.company,
    c.recommendedAction,
    c.sourceUrls[0] ?? '',
    '대기',
    '',
    '',
    '',
    'AI_RESEARCH_REVIEW',
    '대기',
    '',
    '',
    c.estimatedMakerOems.join(', '),
    c.application,
    c.score,
    c.confidence,
    c.makeBuyNote,
    c.sourceUrls.join('\n'),
    summary,
    key
  ];
}

export async function appendPendingApprovals(
  spreadsheetId: string,
  output: MarketAgentOutput
): Promise<number> {
  const sheets = api();
  const seen = await existingDedupeKeys(spreadsheetId);

  const candidates = output.candidates.filter(c => !seen.has(dedupeKey(c)));
  if (!candidates.length) return 0;

  const rows = candidates.map(approvalRow);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${APPROVAL_SHEET}'!A:W`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });

  return rows.length;
}

export async function updateMarketAgentStatus(
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
  let relativeIndex = rows.findIndex(row => row[0] === 'Market Agent');
  if (relativeIndex < 0) relativeIndex = rows.length;
  const rowNumber = relativeIndex + 2;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${AI_TEAM_SHEET}'!A${rowNumber}:J${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        'Market Agent',
        status,
        new Date().toISOString(),
        recentOutput,
        approvalNeeded,
        0,
        'OEM·Tier-1·Plant·투자·채용·업계 신호 조사',
        '공개 웹·Tier1_마스터·검색_설정',
        'Approval Queue의 영업 후보 초안',
        notes || '사람 승인 전 외부 실행 금지'
      ]]
    }
  });
}
