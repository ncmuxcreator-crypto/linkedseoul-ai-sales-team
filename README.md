# Linked Seoul AI Sales Team

AI-assisted automotive sales intelligence for Linked Seoul / LINKED MOTOR.

## V1 scope

V1 deliberately starts with one production agent: **Market Agent**.

Flow:

`Market Agent -> Web research -> Structured candidate -> Approval Queue -> Human approval`

The agent does **not** send email, contact prospects, approve suppliers, or write directly into final sales-action records.

It writes proposed items into the existing Google Sheet tabs:

- `AI Team` — agent status / last run
- `Agent Inbox` — internal work handoff
- `Approval Queue` — human approval boundary

Existing operational tabs remain authoritative:

- `주간_레이더`
- `주간_브리프`
- `후보_검토`
- `기회_피드`
- `계정_관계`
- `Tier1_마스터`
- `담당자`
- `액션`

## Required GitHub Actions secrets

Add these under **Repository Settings -> Secrets and variables -> Actions**:

- `OPENAI_API_KEY`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
- `GOOGLE_SHEETS_ID`

For this project, `GOOGLE_SHEETS_ID` should be:

`1WHcPdMLArf0wGbII7BzAa7E5Dx1JVu9h_RAj66qGZPI`

Do not commit any API key or private key into this repository.

## Google permissions

Share the Weekly Radar spreadsheet with the service account email as **Editor**. The service account only needs spreadsheet access for V1.

## Run locally

```bash
npm install
npm run typecheck
npm run market
```

Environment variables are documented in `.env.example`.

## Scoring

The Market Agent does not equate application fit with sales opportunity. It scores:

- Application fit: 0-30
- External sourcing probability: 0-25
- Timing: 0-20
- Buyer accessibility: 0-15
- Evidence quality: 0-10
- Vertical integration penalty: 0-25 deduction

This is specifically intended to prevent vertically integrated groups from ranking too highly simply because they use relevant motors or actuators.

## Current safety boundary

All new AI-originated commercial proposals enter `Approval Queue` with status `대기`.

V1 does **not**:

- send Gmail or LinkedIn messages
- scrape authenticated LinkedIn sessions
- change approval status
- create final outreach actions automatically
- fabricate RFQs, buyer names, OEM programs, or sourcing events

## Weekly schedule

The included GitHub Actions workflow is scheduled for Friday 07:00 KST (Thursday 22:00 UTC). It performs a secret preflight first; if required secrets are missing, it exits safely without running the agent.
