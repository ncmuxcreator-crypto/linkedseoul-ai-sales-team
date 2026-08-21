import {
  getSpreadsheetId,
  promoteApprovedContacts,
  stampApprovalMetadata,
  updateBuyerAgentStatus
} from './buyer-sheets.js';

async function main() {
  const spreadsheetId = getSpreadsheetId();
  const stamped = await stampApprovalMetadata(spreadsheetId);
  const result = await promoteApprovedContacts(spreadsheetId);

  if (result.promoted > 0) {
    await updateBuyerAgentStatus(
      spreadsheetId,
      '대기',
      `승인된 신규 담당자 ${result.promoted}명 담당자 시트 반영`,
      0,
      `Approval Queue 승인 적용 완료: ${result.promotedIds.join(', ')}. 중복 스킵 ${result.skippedDuplicates}, legacy 스킵 ${result.legacySkipped}. 외부 접촉 없음.`
    );
  }

  console.log(JSON.stringify({
    stampedApprovalMetadata: stamped,
    promotedContacts: result.promoted,
    skippedDuplicates: result.skippedDuplicates,
    legacySkipped: result.legacySkipped,
    promotedIds: result.promotedIds
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
