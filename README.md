# Linked Seoul AI Sales Team

AI-assisted automotive sales intelligence for Linked Seoul / LINKED MOTOR.

## V1 flow

`Market Agent -> Approval Queue -> Human approval -> 후보/액션 반영 -> Buyer Agent -> Approval Queue -> Human approval -> 담당자 -> Radar/Brief refresh`

The system does **not** send email, contact prospects, approve suppliers, or perform LinkedIn outreach automatically. Human-approved items are promoted into internal candidate, contact, and action records by the weekly sheet-maintenance script.

## Approval Queue — user action

1. Open `Approval Queue` and review the evidence/link, score and AI summary.
2. In column **H (`승인 상태`)**, choose only one of: `대기`, `승인`, `반려`, `보류`.
3. Market opportunities move to Buyer Agent research **only when H = `승인`**.
4. New buyer/contact candidates move into `담당자` **only when H = `승인`**.
5. `승인` means permission for the **next internal AI step only**. It never authorizes external email or LinkedIn sending.

Columns M-O track internal execution: `대기`, `진행중`, `적용완료`, `스킵`, `오류`.
If an approved row has no approver/timestamp, the gate records `Tracy` and the current timestamp without changing the approval decision itself.

Legacy contacts created before the strict gate remain in `담당자`; the strict gate applies to new Buyer Agent results from this version forward.

## Sheets

- `AI Team` — agent status / last run
- `Approval Queue` — human approval boundary
- `담당자` — approved contacts only for new strict-gate runs
- `주간_레이더`, `후보_검토`, `기회_피드`, `계정_관계`, `Tier1_마스터`, `액션` — operational data

## Required GitHub Actions secrets

Add these under **Repository Settings -> Secrets and variables -> Actions**:

- `OPENAI_API_KEY`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
- `GOOGLE_SHEETS_ID`

`GOOGLE_SHEETS_ID`:

`1WHcPdMLArf0wGbII7BzAa7E5Dx1JVu9h_RAj66qGZPI`

Do not commit API keys or private keys into this repository.

## Run locally

```bash
npm install
npm run typecheck
npm run market
npm run gate
npm run sheet:sync
npm run buyer
npm run sheet:refresh
```

## Scoring

The Market Agent scores opportunity quality rather than application fit alone:

- Application fit: 0-30
- External sourcing probability: 0-25
- Timing: 0-20
- Buyer accessibility: 0-15
- Evidence quality: 0-10
- Vertical integration penalty: 0-25 deduction

## Safety boundary

The agents do not:

- send Gmail or LinkedIn messages
- scrape authenticated LinkedIn sessions
- change column H approval status
- promote an unapproved new contact into `담당자`
- fabricate RFQs, buyer names, OEM programs, or sourcing events

## Weekly schedule

The GitHub Actions workflow runs Friday 07:00 KST (Thursday 22:00 UTC):

`Market Agent -> approved contact promotion gate -> approved opportunity/action sync -> Buyer Agent for approved opportunities only -> operational view refresh`

If there is no approved opportunity, Buyer Agent exits safely without an OpenAI research call.

The weekly sheet-maintenance steps update only cell values in operational ranges and copy existing row presentation to newly inserted rows. Existing formulas, fills, conditional formatting, and dropdown rules are not replaced. Maker/OEM links remain explicitly labeled as estimates until an official source confirms them.
