import { runBuyerAgent } from './buyer-agent.js';
import {
  appendNewContacts,
  getSpreadsheetId,
  readBuyerTargets,
  readExistingContacts,
  updateBuyerAgentStatus
} from './buyer-sheets.js';

async function main() {
  const spreadsheetId = getSpreadsheetId();
  const maxAccounts = Number(process.env.MAX_BUYER_ACCOUNTS || '6');
  const maxNewContacts = Number(process.env.MAX_NEW_CONTACTS || '12');

  const targets = await readBuyerTargets(spreadsheetId, maxAccounts);
  const existing = await readExistingContacts(spreadsheetId);

  if (!targets.length) {
    await updateBuyerAgentStatus(
      spreadsheetId,
      '대기',
      '신규 Buyer Agent 대상 계정 없음',
      0,
      'Market Agent Approval Queue에서 대기 중이면서 Attack Score 50+인 계정이 없습니다.'
    );
    console.log(JSON.stringify({ targets: 0, researched: 0, inserted: 0 }, null, 2));
    return;
  }

  await updateBuyerAgentStatus(
    spreadsheetId,
    '실행 중',
    `${targets.length}개 계정 신규 담당자 조사 중`,
    0,
    `기존 담당자 ${existing.length}명은 hard exclusion 처리`
  );

  try {
    const output = await runBuyerAgent(targets, existing, maxNewContacts);
    const result = await appendNewContacts(spreadsheetId, output, targets, existing);

    await updateBuyerAgentStatus(
      spreadsheetId,
      result.inserted > 0 ? '검토 필요' : '대기',
      `${output.contacts.length}명 조사 · 신규 ${result.inserted}명 추가 · 중복 ${result.duplicatesSkipped}명 제외`,
      result.inserted,
      output.notes.join(' | ') || '신규 담당자는 AI 신규·검토대기 상태로 추가됨. 외부 접촉은 수행하지 않음.'
    );

    console.log(JSON.stringify({
      targets: targets.map(t => ({ company: t.company, score: t.attackScore })),
      researched: output.contacts.length,
      inserted: result.inserted,
      duplicatesSkipped: result.duplicatesSkipped,
      insertedIds: result.insertedIds,
      notes: output.notes
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateBuyerAgentStatus(
      spreadsheetId,
      '오류',
      'Buyer Agent 실행 실패',
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
