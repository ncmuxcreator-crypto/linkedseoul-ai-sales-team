import { runBuyerAgent } from './buyer-agent.js';
import {
  getSpreadsheetId,
  markBuyerTargetsExecution,
  queuePendingContactApprovals,
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
      '승인된 신규 Buyer Agent 대상 없음',
      0,
      'Approval Queue에서 공략 후보의 H열 승인 상태가 정확히 `승인`인 미처리 계정만 조사합니다. 대기/반려/보류는 안전하게 스킵합니다.'
    );
    console.log(JSON.stringify({ targets: 0, researched: 0, queued: 0, skipped: 'NO_APPROVED_OPPORTUNITY' }, null, 2));
    return;
  }

  await markBuyerTargetsExecution(spreadsheetId, targets, '진행중');
  await updateBuyerAgentStatus(
    spreadsheetId,
    '실행 중',
    `${targets.length}개 승인 계정 신규 담당자 조사 중`,
    0,
    `기존/대기 담당자 ${existing.length}명은 hard exclusion 처리`
  );

  try {
    const output = await runBuyerAgent(targets, existing, maxNewContacts);
    const result = await queuePendingContactApprovals(spreadsheetId, output, targets, existing);
    await markBuyerTargetsExecution(spreadsheetId, targets, '적용완료');

    await updateBuyerAgentStatus(
      spreadsheetId,
      result.queued > 0 ? '검토 필요' : '대기',
      `${output.contacts.length}명 조사 · 신규 승인대기 ${result.queued}명 · 중복 ${result.duplicatesSkipped}명 제외`,
      result.queued,
      output.notes.join(' | ') || '신규 담당자는 Approval Queue에만 기록됩니다. H열에서 승인되기 전에는 담당자 시트에 반영하지 않습니다.'
    );

    console.log(JSON.stringify({
      targets: targets.map(t => ({ company: t.company, score: t.attackScore, approvals: t.approvalIds })),
      researched: output.contacts.length,
      queued: result.queued,
      duplicatesSkipped: result.duplicatesSkipped,
      candidateIds: result.candidateIds,
      notes: output.notes
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markBuyerTargetsExecution(spreadsheetId, targets, '오류');
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
