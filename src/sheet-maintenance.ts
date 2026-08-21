import { google } from 'googleapis';
import type { MarketCandidate } from './schema.js';

const APPROVAL_SHEET = 'Approval Queue';
const CANDIDATE_SHEET = '후보_검토';
const ACTION_SHEET = '액션';
const ACCOUNT_SHEET = '계정_관계';
const OPPORTUNITY_FEED_SHEET = '기회_피드';
const RADAR_SHEET = '주간_레이더';
const BRIEF_SHEET = '주간_브리프';
const AI_TEAM_SHEET = 'AI Team';
const AUTOMATION_LOG_SHEET = '자동화_로그';

type CandidateRecord = {
  rowNumber: number;
  id: string;
  type: string;
  company: string;
  signalType: string;
  title: string;
  buyerFunctions: string;
  score: number;
  band: string;
  confidence: string;
  reason: string;
  action: string;
  dueDate: string;
  owner: string;
  reviewStatus: string;
  sourceUrl: string;
  researchId: string;
};

export type SyncResult = {
  promotedMarketCandidates: number;
  createdActions: number;
  candidateIds: string[];
  actionIds: string[];
};

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
  return value.toLowerCase().replace(/https?:\/\/(www\.)?/g, '')
    .replace(/[\s._\-–—/()]+/g, '').trim();
}

function kstDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(date);
}

function addDays(dateText: string, days: number): string {
  const date = new Date(`${dateText}T12:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return kstDate(date);
}

function mondayOf(dateText: string): string {
  const date = new Date(`${dateText}T12:00:00+09:00`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return kstDate(date);
}

function confidenceLabel(value: string): string {
  if (value === 'high' || value === '높음') return '높음';
  if (value === 'medium' || value === '중간') return '중간';
  return '낮음';
}

function candidateBand(score: number): string {
  if (score >= 80) return '이번 주 공략';
  if (score >= 60) return '조직 확인';
  return '관찰';
}

function signalLabel(signalType: string, summary: string): string {
  const labels: Record<string, string> = {
    purchasing: '구매·채용', hiring: '구매·채용',
    'supplier-entry': '공급사 진입', plant: '공장·투자',
    program: '프로그램·수상', technology: '제품·기술',
    organization: '조직·M&A', other: '업계 트렌드'
  };
  if (labels[signalType]) return labels[signalType];
  const text = summary.toLowerCase();
  if (/buyer|purchas|채용|구매/.test(text)) return '구매·채용';
  if (/plant|공장|investment|투자/.test(text)) return '공장·투자';
  if (/award|program|수주|sop/.test(text)) return '프로그램·수상';
  return '제품·기술';
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map(item => item.trim()).find(Boolean) ?? '';
}

function summaryPart(summary: string, label: string): string {
  const line = summary.split(/\r?\n/).map(item => item.trim())
    .find(item => item.toLowerCase().startsWith(label.toLowerCase()));
  return line ? line.slice(label.length).trim() : '';
}

function marketPayload(row: unknown[]): MarketCandidate | undefined {
  const raw = String(row[32] ?? '').trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as MarketCandidate;
    return parsed?.company ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function nextNumericId(ids: string[], pattern: RegExp): number {
  return ids.reduce((max, id) => {
    const match = id.match(pattern);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

async function getSheetId(spreadsheetId: string, title: string): Promise<number> {
  const result = await api().spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)'
  });
  const sheet = result.data.sheets?.find(item => item.properties?.title === title);
  const id = sheet?.properties?.sheetId;
  if (typeof id !== 'number') throw new Error(`Sheet not found: ${title}`);
  return id;
}

async function copyRowPresentation(
  spreadsheetId: string,
  title: string,
  templateRow: number,
  startRow: number,
  rowCount: number,
  columnCount: number
): Promise<void> {
  if (rowCount < 1 || templateRow < 2) return;
  const sheetId = await getSheetId(spreadsheetId, title);
  const source = { sheetId, startRowIndex: templateRow - 1, endRowIndex: templateRow,
    startColumnIndex: 0, endColumnIndex: columnCount };
  const destination = { sheetId, startRowIndex: startRow - 1,
    endRowIndex: startRow - 1 + rowCount, startColumnIndex: 0, endColumnIndex: columnCount };
  await api().spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [
      { copyPaste: { source, destination, pasteType: 'PASTE_FORMAT', pasteOrientation: 'NORMAL' } },
      { copyPaste: { source, destination, pasteType: 'PASTE_DATA_VALIDATION', pasteOrientation: 'NORMAL' } }
    ] }
  });
}

async function readCandidates(spreadsheetId: string): Promise<CandidateRecord[]> {
  const result = await api().spreadsheets.values.get({
    spreadsheetId, range: `'${CANDIDATE_SHEET}'!A2:AB1000`
  });
  return (result.data.values ?? []).flatMap((row, index) => {
    const id = String(row[0] ?? '').trim();
    if (!id) return [];
    return [{
      rowNumber: index + 2, id, type: String(row[2] ?? ''), company: String(row[3] ?? ''),
      signalType: String(row[5] ?? ''), title: String(row[6] ?? ''),
      buyerFunctions: String(row[7] ?? ''), score: Number(row[14] ?? 0),
      band: String(row[15] ?? ''), confidence: String(row[16] ?? ''),
      reason: String(row[17] ?? ''), action: String(row[18] ?? ''),
      dueDate: String(row[19] ?? ''), owner: String(row[20] ?? ''),
      reviewStatus: String(row[21] ?? ''), sourceUrl: String(row[22] ?? ''),
      researchId: String(row[23] ?? '')
    }];
  });
}

export async function promoteApprovedMarketCandidates(spreadsheetId: string) {
  const sheets = api();
  const [queueResult, existing] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: `'${APPROVAL_SHEET}'!A2:AG1000` }),
    readCandidates(spreadsheetId)
  ]);
  const researchIds = new Set(existing.map(item => item.researchId).filter(Boolean));
  const eligible = (queueResult.data.values ?? []).flatMap((row, index) => {
    const approvalId = String(row[0] ?? '').trim();
    if (String(row[2] ?? '') !== 'Market Agent' || String(row[3] ?? '') !== '공략 후보') return [];
    if (String(row[7] ?? '') !== '승인' || String(row[14] ?? '').trim()) return [];
    if (!approvalId || researchIds.has(approvalId)) return [];
    return [{ row, rowNumber: index + 2, approvalId }];
  });
  if (!eligible.length) return { promoted: 0, ids: [] as string[] };

  const today = kstDate();
  let serial = nextNumericId(existing.map(item => item.id), /^C-AI-\d{8}-(\d+)$/);
  const ids: string[] = [];
  const rows = eligible.map(({ row, approvalId }) => {
    const payload = marketPayload(row);
    const summary = String(row[21] ?? '');
    const score = payload?.score ?? Number(row[17] ?? 0);
    const makerOem = payload?.estimatedMakerOems.join(', ') || String(row[15] ?? '').trim();
    const sourceUrls = payload?.sourceUrls ?? String(row[20] ?? row[6] ?? '')
      .split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const reason = payload?.whyNow || summaryPart(summary, 'Why now:') || firstLine(summary);
    const action = payload?.recommendedAction || String(row[5] ?? '').trim();
    const buyers = payload?.recommendedBuyerFunctions.join(' / ')
      || summaryPart(summary, 'Recommended buyer:')
      || 'Project Purchasing / Commodity Buyer / Supplier Development';
    const title = payload?.signalSummary || firstLine(summary) || action;
    const signal = signalLabel(payload?.signalType ?? '', `${title} ${summary}`);
    const productFit = payload?.applicationFit ?? Math.min(30, Math.max(10, Math.round(score * 0.30)));
    const timing = payload?.timing ?? Math.min(25, Math.max(5, Math.round(score * 0.22)));
    const evidence = payload?.evidenceQuality !== undefined ? Math.min(20, payload.evidenceQuality * 2)
      : Math.min(20, Math.max(5, Math.round(score * 0.20)));
    const access = payload?.buyerAccessibility ?? Math.min(15, Math.max(2, Math.round(score * 0.15)));
    const recency = Math.min(10, Math.max(1, score - productFit - timing - evidence - access));
    const id = `C-AI-${today.replaceAll('-', '')}-${String(++serial).padStart(3, '0')}`;
    ids.push(id);
    const memo = [
      'Approval Queue 사람 승인 자동 반영.',
      makerOem ? `추정 Maker/OEM: ${makerOem} (추정값·공식 확인 필요).` : 'Maker/OEM 연계 미확인.',
      payload?.makeBuyNote || String(row[19] ?? ''), payload?.makerEvidenceNote || '',
      String(row[22] ?? '') ? `중복키 ${String(row[22])}` : ''
    ].filter(Boolean).join(' ');
    return [
      id, mondayOf(today), signal === '공급사 진입' ? '공급사 진입' : '기회',
      payload?.company ?? String(row[4] ?? '').trim(), score >= 60 ? '1차 공략' : '차기 공략',
      signal, title, buyers, payload?.application || String(row[16] ?? ''),
      productFit, timing, evidence, access, recency, score, candidateBand(score),
      confidenceLabel(payload?.confidence ?? String(row[18] ?? 'low')), reason, action,
      addDays(today, 7), 'Tracy', '승인', sourceUrls[0] ?? String(row[6] ?? ''), approvalId,
      new Date().toISOString(), new Date().toISOString(), memo, ''
    ];
  });
  const nextRow = Math.max(1, ...existing.map(item => item.rowNumber)) + 1;
  await copyRowPresentation(spreadsheetId, CANDIDATE_SHEET, nextRow - 1, nextRow, rows.length, 28);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${CANDIDATE_SHEET}'!A${nextRow}:AB${nextRow + rows.length - 1}`,
    valueInputOption: 'USER_ENTERED', requestBody: { values: rows }
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: eligible.map((item, index) => ({
      range: `'${APPROVAL_SHEET}'!O${item.rowNumber}`, values: [[ids[index]]]
    })) }
  });
  return { promoted: rows.length, ids };
}

async function accountMap(spreadsheetId: string): Promise<Map<string, string>> {
  const result = await api().spreadsheets.values.get({ spreadsheetId, range: `'${ACCOUNT_SHEET}'!A2:C1000` });
  const map = new Map<string, string>();
  (result.data.values ?? []).forEach(row => {
    const id = String(row[0] ?? '').trim();
    const names = [String(row[1] ?? ''), ...String(row[2] ?? '').split('|')];
    if (id) names.map(value => value.trim()).filter(Boolean).forEach(value => map.set(norm(value), id));
  });
  return map;
}

export async function promoteApprovedCandidatesToActions(spreadsheetId: string) {
  const sheets = api();
  const [candidates, actionsResult, accounts] = await Promise.all([
    readCandidates(spreadsheetId),
    sheets.spreadsheets.values.get({ spreadsheetId, range: `'${ACTION_SHEET}'!A2:N1000` }),
    accountMap(spreadsheetId)
  ]);
  const actionRows = actionsResult.data.values ?? [];
  const linked = new Set(actionRows.map(row => String(row[12] ?? '')).filter(Boolean));
  const eligible = candidates.filter(item => item.reviewStatus === '승인' && !linked.has(item.id));
  if (!eligible.length) return { created: 0, ids: [] as string[] };
  let maxId = nextNumericId(actionRows.map(row => String(row[0] ?? '')), /^ACT-(\d+)$/);
  const ids: string[] = [];
  const rows = eligible.map((candidate, index) => {
    const id = `ACT-${String(++maxId).padStart(3, '0')}`;
    ids.push(id);
    return [
      id, accounts.get(norm(candidate.company)) ?? '', candidate.company, '', '',
      /담당자|구매·채용/.test(`${candidate.type} ${candidate.signalType}`) ? 'LinkedIn/조사' : '기술·구매 조사',
      candidate.action, candidate.dueDate || addDays(kstDate(), 7), '진행', '', candidate.owner || 'Tracy',
      `후보 ${candidate.id}에서 사람 승인 후 자동 생성`, candidate.id, actionRows.length + index + 1
    ];
  });
  const nextRow = Math.max(1, ...actionRows.map((row, index) => String(row[0] ?? '').trim() ? index + 2 : 0)) + 1;
  await copyRowPresentation(spreadsheetId, ACTION_SHEET, nextRow - 1, nextRow, rows.length, 14);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${ACTION_SHEET}'!A${nextRow}:N${nextRow + rows.length - 1}`,
    valueInputOption: 'USER_ENTERED', requestBody: { values: rows }
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: eligible.map(candidate => ({
      range: `'${CANDIDATE_SHEET}'!V${candidate.rowNumber}`, values: [['액션화']]
    })) }
  });
  return { created: rows.length, ids };
}

export async function syncApprovedSheetItems(spreadsheetId: string): Promise<SyncResult> {
  const market = await promoteApprovedMarketCandidates(spreadsheetId);
  const actions = await promoteApprovedCandidatesToActions(spreadsheetId);
  return { promotedMarketCandidates: market.promoted, createdActions: actions.created,
    candidateIds: market.ids, actionIds: actions.ids };
}

function uniqueJoined(values: string[], maxItems = 3): string {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, maxItems).join(' / ');
}

async function refreshOpportunityFeed(spreadsheetId: string, candidates: CandidateRecord[]) {
  const sheets = api();
  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.company.localeCompare(b.company));
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${OPPORTUNITY_FEED_SHEET}'!A5:L1000`, requestBody: {} });
  if (!ranked.length) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${OPPORTUNITY_FEED_SHEET}'!A5:L${ranked.length + 4}`,
    valueInputOption: 'USER_ENTERED', requestBody: { values: ranked.map((item, index) => [
      index + 1, item.company, item.type, item.score, item.band, item.reason, item.buyerFunctions,
      item.action, item.dueDate, item.reviewStatus, item.sourceUrl, item.id
    ]) }
  });
}

async function refreshRadarAndBrief(spreadsheetId: string, candidates: CandidateRecord[]): Promise<string[]> {
  const groups = new Map<string, CandidateRecord[]>();
  candidates.forEach(item => groups.set(norm(item.company), [...(groups.get(norm(item.company)) ?? []), item]));
  const top = [...groups.values()].map(group => [...group].sort((a, b) => b.score - a.score))
    .sort((a, b) => b[0].score - a[0].score).slice(0, 5);
  const radarRows: unknown[][] = top.map((group, index) => {
    const best = group[0];
    return [index + 1, best.company, best.score, uniqueJoined(group.map(item => item.type)),
      uniqueJoined(group.map(item => item.reason)), uniqueJoined(group.map(item => item.action)),
      group.map(item => item.dueDate).filter(Boolean).sort()[0] ?? '', best.reviewStatus];
  });
  const briefRows: unknown[][] = top.map((group, index) => {
    const best = group[0];
    return [index + 1, best.company, best.score, uniqueJoined(group.map(item => item.reason)),
      uniqueJoined(group.map(item => item.buyerFunctions)), uniqueJoined(group.map(item => item.action)),
      group.map(item => item.dueDate).filter(Boolean).sort()[0] ?? '', best.reviewStatus];
  });
  while (radarRows.length < 5) radarRows.push(['', '', '', '', '', '', '', '']);
  while (briefRows.length < 5) briefRows.push(['', '', '', '', '', '', '', '']);
  const signalRows: unknown[][] = [...candidates].sort((a, b) => b.score - a.score).slice(0, 5)
    .map(item => [item.signalType, item.company, item.title, item.confidence, item.action]);
  while (signalRows.length < 5) signalRows.push(['', '', '', '', '']);
  const headline = top.length
    ? `이번 주에는 ${top.length}개사를 우선 검토합니다. 가장 높은 후보는 ${top[0][0].company}이며, 핵심 이유는 ${top[0][0].reason}`
    : '이번 주 활성 후보가 없습니다.';
  await api().spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: [
      { range: `'${RADAR_SHEET}'!A11:H15`, values: radarRows },
      { range: `'${RADAR_SHEET}'!J11:N15`, values: signalRows },
      { range: `'${BRIEF_SHEET}'!A2`, values: [[`주간 기준: ${kstDate()} | 회사별 통합 요약 — 사실과 영업 해석을 분리합니다.`]] },
      { range: `'${BRIEF_SHEET}'!A5`, values: [[headline]] },
      { range: `'${BRIEF_SHEET}'!A11:H15`, values: briefRows }
    ] }
  });
  return top.map(group => group[0].company);
}

async function refreshAiTeam(spreadsheetId: string): Promise<number> {
  const sheets = api();
  const [team, approvals] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: `'${AI_TEAM_SHEET}'!A2:J20` }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: `'${APPROVAL_SHEET}'!A2:H1000` })
  ]);
  const pending = new Map<string, number>();
  (approvals.data.values ?? []).forEach(row => {
    const agent = String(row[2] ?? '').trim();
    if (agent && ['대기', '승인 대기'].includes(String(row[7] ?? '').trim())) {
      pending.set(agent, (pending.get(agent) ?? 0) + 1);
    }
  });
  const data = (team.data.values ?? []).flatMap((row, index) => {
    const agent = String(row[0] ?? '').trim();
    if (!agent) return [];
    const count = pending.get(agent) ?? 0;
    const current = String(row[1] ?? '대기');
    const status = ['실행 중', '오류'].includes(current) ? current
      : count > 0 ? '검토 필요' : agent === 'Action Agent' ? current : '대기';
    return [{ range: `'${AI_TEAM_SHEET}'!B${index + 2}:F${index + 2}`,
      values: [[status, row[2] ?? '', row[3] ?? '', count, row[5] ?? 0]] }];
  });
  if (data.length) await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId, requestBody: { valueInputOption: 'RAW', data }
  });
  return [...pending.values()].reduce((sum, value) => sum + value, 0);
}

export async function refreshOperationalViews(
  spreadsheetId: string,
  sync: SyncResult,
  startedAt = new Date().toISOString()
) {
  const candidates = (await readCandidates(spreadsheetId))
    .filter(item => item.company && item.reviewStatus !== '제외' && item.score > 0);
  await refreshOpportunityFeed(spreadsheetId, candidates);
  const topCompanies = await refreshRadarAndBrief(spreadsheetId, candidates);
  const pendingApprovals = await refreshAiTeam(spreadsheetId);
  await api().spreadsheets.values.append({
    spreadsheetId, range: `'${AUTOMATION_LOG_SHEET}'!A:L`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[`GHA-${Date.now()}`, 'GITHUB_WEEKLY', startedAt, new Date().toISOString(),
      0, candidates.length, 0, sync.promotedMarketCandidates, sync.createdActions, 0, 0, false]] }
  });
  return { activeCandidates: candidates.length, topCompanies, pendingApprovals };
}
