# MilestonePay

**Get paid for work that's verifiably done.**

MilestonePay helps freelancers and their clients agree on what "done" means. The app then holds the client's money in PayPal until an AI verifier confirms the work matches that agreement.

- An **AI Planner** (Gemini) turns a messy client brief into milestones. Each milestone gets objective acceptance criteria and an explicit *not included* list.
- The client **funds each milestone as a PayPal authorization**. The money is held on their own PayPal account, not charged, and not sitting with a middleman.
- When the freelancer delivers, an **AI Verifier** (Gemini, multimodal) opens the links, reads GitHub repos, and looks at screenshots. It then scores the delivery against every criterion.
- The client **releases full or partial payment in one click** (PayPal capture). A partial capture automatically returns the rest of the hold.
- A **Scope Guard** reads client messages. When a request falls outside the agreement ("can you also add online booking?"), it drafts a priced change order, and the freelancer sends it as a **PayPal invoice** in one click.

> Built for the PayPal AI Hackathon 2026 ("Build what's next with PayPal and AI").

---

## The problem

Cross-border freelancing runs on trust that neither side has:

- **Freelancers** (e.g. a web developer in Indonesia working for a client in Australia) deliver the work and then chase payment, or get paid less because "it's not what I asked for."
- **Clients** don't want to pay upfront to someone they've never met.
- **Marketplaces** solve this with escrow, but take a large fee and own the relationship. Direct clients have nothing in between.
- **Scope creep** quietly turns a $900 project into $1,400 of unpaid work.

The hard part is not moving money. The hard part is deciding, fairly, when the money should move. That decision is what MilestonePay gives to AI, with the human always making the final click.

## How it works

```
 Client brief ──► AI Planner ──► Milestones + acceptance criteria + "not included" list
                                        │
         Client approves hold in PayPal ▼   (Orders v2, intent=AUTHORIZE)
                                  ┌───────────┐
                                  │ $ ON HOLD │  money stays in the client's PayPal account
                                  └─────┬─────┘
 Freelancer submits links/screenshots ──► AI Verifier ──► score + per-criterion evidence
                                        │
                     Client decides ──► Release 100% / partial (capture, final_capture=true)
                                        │          or Ask for changes (hold stays)
                                        ▼
                                 Freelancer is paid

 Client message ──► Scope Guard ──► out of scope? ──► priced change order ──► PayPal Invoice
```

## PayPal Developer Platform usage

| Capability | API | Where |
|---|---|---|
| Fund a milestone as a hold | `POST /v2/checkout/orders` with `intent: AUTHORIZE` + PayPal JS SDK Buttons (`intent=authorize`) | `lib/paypal.js` `createAuthorizeOrder`, `public/app.js` `mountPayPalButtons` |
| Place the hold | `POST /v2/checkout/orders/{id}/authorize` | `authorizeOrder` |
| Release full or partial payment | `POST /v2/payments/authorizations/{id}/capture` with `final_capture: true` | `captureAuthorization` |
| Return funds | `POST /v2/payments/authorizations/{id}/void` | `voidAuthorization` |
| Keep long milestones funded | `POST /v2/payments/authorizations/{id}/reauthorize` (after the 3-day honor period) | `reauthorize` |
| Bill out-of-scope work | `POST /v2/invoicing/invoices` → `POST /v2/invoicing/invoices/{id}/send` → `GET` for the payer link | `createAndSendInvoice` |
| Stay in sync | Webhooks + `POST /v1/notifications/verify-webhook-signature` | `verifyWebhook`, `/api/webhooks/paypal` |
| Safety | OAuth2 client credentials with token caching, `PayPal-Request-Id` idempotency keys on every write, PayPal `debug_id` surfaced in errors | `lib/paypal.js` |

**Why authorize/capture instead of escrow:** an authorization holds funds on the *payer's* PayPal account, and only the client's capture moves them. MilestonePay never holds money. It only decides, with evidence, when the client should capture.

## AI usage (Google Gemini)

All three agents use the Gemini REST API with **structured JSON output** (`responseMimeType: application/json` + `responseJsonSchema`), so the app always gets machine-checkable results (`lib/ai.js`).

| Agent | Input | Output | Why it matters |
|---|---|---|---|
| **Planner** | Raw brief, budget, timeline | 2–6 milestones, budget split, *verifiable* acceptance criteria, out-of-scope list, assumptions, risks | Turns a vague brief into a contract both sides can check against. Amounts are re-normalized server-side so they always add up to the budget. |
| **Verifier** | Criteria + freelancer notes + **fetched link content** (pages, GitHub README and file tree) + **screenshots** (multimodal) | Per-criterion `MET / PARTIAL / NOT_MET / UNVERIFIABLE` with evidence, score 0–100, verdict, recommended release %, items to check by hand | Gives the client a fair, evidence-based recommendation. Things it can't see are flagged for a human, never failed silently. |
| **Scope Guard** | Client message + milestones + out-of-scope list | `IN_SCOPE / CLARIFICATION / OUT_OF_SCOPE`, reasoning, itemized change order priced at the freelancer's effective rate, polite suggested reply | Stops unpaid scope creep without awkward conversations. The change order becomes a real PayPal invoice. |

**Guardrails:**
- The AI recommends and the client decides. Only the client can capture.
- Only the freelancer can void a hold, so a client can't pull funds after work has started.
- Fetched content and client messages are treated as untrusted data in prompts (prompt-injection hardening).
- Link fetching blocks private and loopback addresses (SSRF guard) and has size and time limits.

## Quick start

Requirements: **Node.js 18+**. There are **no npm dependencies** and no build step.

```bash
git clone https://github.com/<you>/milestonepay.git
cd milestonepay
cp .env.example .env      # fill in the keys below
node server.js            # → http://localhost:3000
```

### 1. PayPal sandbox credentials
1. Go to <https://developer.paypal.com/dashboard/> → **Apps & Credentials** → **Sandbox** → **Create App** (type: Merchant).
2. Copy the **Client ID** and **Secret** into `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`.
3. In **Testing Tools → Sandbox Accounts**, note the **Personal** account email and password. You will use them as the client when approving PayPal holds. Use that same email as the client email so change-order invoices arrive in the sandbox inbox.

### 2. Gemini key
Create a key at <https://aistudio.google.com/apikey> and set `GEMINI_API_KEY`. Change `GEMINI_MODEL` if you want a different model.

### 3. (Optional) Webhooks
Expose your server publicly (deploy it, or use a tunnel). Then in your sandbox app add a webhook to `https://<host>/api/webhooks/paypal` with the events `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `INVOICING.INVOICE.PAID`. Put the Webhook ID in `PAYPAL_WEBHOOK_ID` so signatures are verified.

### No keys? Explore in simulated mode
Without PayPal or Gemini keys the app still runs. PayPal calls are simulated and the AI uses simple heuristics. The header badges show **"simulated"** so it's always clear. The real experience needs the keys above.

## Try the full flow (about 3 minutes)

1. Open the app and click **Use a sample brief** (a surf school in Bali). Enter your sandbox personal email as the client email, then click **Draft milestones with AI**.
2. Review and edit the milestones and criteria, then click **Create agreement and client link**.
3. Click **Open the client's view in a new tab**. Pay milestone 1 with the PayPal button, logging in with the sandbox personal account. The money rail turns amber: **on hold**.
4. Back in the freelancer tab, submit the work: notes, a live URL or GitHub repo, and optionally a screenshot. The verifier stamps it with a score and evidence for each criterion.
5. In the client tab, write *"Can you also add online booking with a deposit?"* The freelancer tab shows Scope Guard flagging it as new work with a priced change order. Click **Send invoice via PayPal**.
6. In the client tab, adjust the release slider (the AI suggestion is preselected) and click **Release**. The rail turns green and the capture appears in your sandbox merchant account.

## Deploy

It's a single Node process, so it runs anywhere:

- **Render**: `render.yaml` is included (New → Blueprint), or create a Web Service with start command `node server.js`.
- **Railway / Fly.io / any VPS**: `node server.js` or the included `Dockerfile`.
- Set the environment variables from `.env.example`. Data is a JSON file in `DATA_DIR`, which is fine for a demo. Use a persistent disk or a database for anything more.

## Project structure

```
server.js          HTTP server, routes, state machine for milestones
lib/paypal.js      PayPal REST client: Orders v2 authorize/capture/void/reauthorize, Invoicing, Webhooks
lib/gemini.js      Gemini REST client with structured JSON output
lib/ai.js          Planner, Verifier, Scope Guard agents (+ simulated fallbacks)
lib/fetcher.js     Safe link fetching for the verifier (GitHub-aware, SSRF guard)
lib/store.js       JSON file store
public/            Vanilla JS front-end (no build step)
```

## Milestone states

`PLANNED` → (client approves hold) → `FUNDED` → (freelancer submits, AI verifies) → `SUBMITTED` → `RELEASED` | `PARTIAL` | `REVISION` → … ; the freelancer can move any held milestone to `VOIDED`.

## Limitations and what's next

- **Single-tenant**: each freelancer runs MilestonePay with their own PayPal REST credentials. Multi-tenant onboarding via PayPal's partner/platform integration is the next step.
- PayPal authorizations last up to 29 days (honor period 3 days, then one reauthorization). Longer milestones should be split or funded in stages.
- Real disputes still go through PayPal's Resolution Center. The verifier report is designed to serve as evidence.
- Next: expose MilestonePay to AI assistants through the **PayPal MCP server / Agent Toolkit** so a client can say "release milestone 2" from their AI assistant, and add a verifier that runs automated checks (Lighthouse, test suites) on delivered sites.

## License

[MIT](LICENSE)
