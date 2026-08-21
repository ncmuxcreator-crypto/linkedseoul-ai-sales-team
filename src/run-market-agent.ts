import { runMarketAgent } from './market-agent.js';
import {
  appendPendingApprovals,
  ensureAiColumns,
  getSpreadsheetId,
  updateMarketAgentStatus
} from './google-sheets.js';

async function main() {
  const spreadsheetId = getSpreadsheetId();

  await ensureAiColumns(spreadsheetId);
  await updateMarketAgentStatus(
    spreadsheetId,
    '실행 중',
    '주간 Tier-1 공개 리서치 실행 중',
    0
  );

  try {
    const output = await runMarketAgent();
    const queued = await appendPendingApprovals(spreadsheetId, output);

    await updateMarketAgentStatus(
      spreadsheetId,
      queued > 0 ? '검토 필요' : '대기',
      `${output.candidates.length}개 후보 조사 · 신규 승인대기 ${queued}건`,
      queued,
      output.notes.join(' | ')
    );

    console.log(JSON.stringify({
      generatedAt: output.generatedAt,
      researched: output.candidates.length,
      queued,
      notes: output.notes
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await updateMarketAgentStatus(
      spreadsheetId,
      '오류',
      'Market Agent 실행 실패',
      0,
      message
    );

    throw error;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
