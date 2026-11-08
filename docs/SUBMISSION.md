# Devpost submission kit

## Tagline (≤ 200 chars)
AI agrees on what "done" means, PayPal holds the money, AI verifies the delivery, and the client releases payment in one click. Fair milestone payments for freelancers and the clients who hire them.

## Inspiration
Freelancers in places like Indonesia increasingly work directly for clients abroad, and PayPal is how they get paid. The money part works. The trust part doesn't. Freelancers deliver and then chase invoices or hear "this isn't what I asked for." Clients hesitate to pay upfront to a stranger. Marketplaces fix this with escrow but take a big cut, and direct relationships have nothing at all. We realized the hard problem isn't moving money: it's deciding fairly *when* money should move. That's a judgment problem, and judgment is what modern AI is finally good enough to help with.

## What it does
MilestonePay is a milestone payment workspace for freelancers and their clients, built on PayPal and Google Gemini.

1. **Agree on "done".** The freelancer pastes the client's brief. The AI Planner splits the budget into milestones with objective acceptance criteria, plus an explicit "not included" list.
2. **Fund a hold, not a payment.** The client approves each milestone with PayPal. We create the order with `intent=AUTHORIZE`, so the funds are held on the client's own PayPal account and not charged.
3. **Verify the delivery.** The freelancer submits links, a GitHub repo, or screenshots. The AI Verifier opens the links, reads the repo, looks at the images, and stamps the milestone with a score and per-criterion evidence. Anything it can't verify is flagged for a human instead of being failed.
4. **Release with one click.** The client releases 100%, or a partial amount the AI suggests. A PayPal capture with `final_capture=true` pays the freelancer and returns the rest of the hold automatically.
5. **Stop scope creep.** Scope Guard reads every client message. "Can you also add online booking?" is flagged as new work, priced at the freelancer's rate, and sent as a real PayPal invoice in one click, without an awkward conversation.

## How we built it
- **PayPal:** Orders v2 (AUTHORIZE intent) with the JS SDK Buttons; Payments v2 authorizations (capture, partial capture with `final_capture`, void, reauthorize); Invoicing v2 (create, send, payer link); Webhooks with signature verification. Every write uses a `PayPal-Request-Id` idempotency key.
- **AI:** Google Gemini via REST with structured JSON output (`responseJsonSchema`) for three agents: Planner, multimodal Verifier, Scope Guard. Prompts treat fetched pages and client messages as untrusted data.
- **App:** zero-dependency Node.js server and a vanilla JS front end, so judges can run it with `node server.js`. A GitHub-aware link fetcher (README + file tree) with an SSRF guard feeds the verifier.

## Challenges we ran into
- Designing a money flow where **no third party ever holds funds**. Authorize/capture was the answer, but it meant handling the 3-day honor period and 29-day expiry (reauthorize).
- Making AI verdicts **fair to both sides**: separating `NOT_MET` from `UNVERIFIABLE`, recommending a partial release instead of all-or-nothing, and keeping the human as the final decision-maker.
- Getting reliable structured output for amounts. The server re-normalizes AI budget splits so milestones always sum to the agreed total.

## Accomplishments that we're proud of
- An end-to-end flow on real PayPal sandbox APIs: brief → plan → hold → AI verification → partial capture → change-order invoice.
- The money rail, a single visual that shows every dollar's state (not funded / on hold / paid) for both parties.
- Runs anywhere with zero dependencies.

## What we learned
- PayPal's authorization model is a powerful and underused primitive for trust between strangers.
- The most valuable AI output is not a decision but **evidence**: per-criterion reasons are what make a client comfortable clicking "Release."

## What's next for MilestonePay
- Multi-tenant onboarding for freelancers through PayPal's platform/partner integration.
- An MCP server built on the PayPal Agent Toolkit, so a client can say "release milestone 2" from their AI assistant.
- Automated checks inside the verifier (Lighthouse scores, running test suites on a submitted repo).
- Using verifier reports as evidence in PayPal disputes.

## Built with
`paypal-orders-v2` `paypal-payments-authorizations` `paypal-invoicing` `paypal-webhooks` `paypal-js-sdk` `google-gemini` `node.js` `javascript` `html` `css`

## Tools section (required)
- **Google Gemini** (`gemini-3.5-flash`, REST `generateContent` with structured JSON output and image input): powers the Planner (brief → milestones and criteria), the Verifier (multimodal check of deliverables against criteria), and Scope Guard (classifies client requests and prices change orders).
- **PayPal Developer Platform (sandbox)**: Orders v2 AUTHORIZE, authorization capture/void/reauthorize, Invoicing v2, Webhooks, JS SDK.

---

# Demo video script (target 2:45)

Record in 1080p. Have two browser windows side by side: freelancer (left) and client (right, logged into the sandbox personal account). Use no copyrighted music; silence or royalty-free audio only.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Home page | "Freelancers deliver work and then chase payment. Clients don't want to pay strangers upfront. MilestonePay fixes the trust gap with PayPal and AI." |
| 0:15–0:40 | Click *Use a sample brief* → *Draft milestones with AI* → plan page | "I paste my client's brief. Gemini turns it into milestones with acceptance criteria anyone can check, and a 'not included' list. That list matters later." |
| 0:40–1:05 | Create agreement → client tab → PayPal button → sandbox login → rail turns amber | "My client funds milestone one with PayPal. It's an authorization: the money is held in *their* account. Nothing is charged, and no middleman holds funds." |
| 1:05–1:45 | Freelancer tab: notes + live URL + screenshot → submit → stamp lands | "I deliver: a live link and a screenshot. The AI Verifier opens the page, reads it, looks at the screenshot, and checks every criterion with evidence. Ninety out of a hundred, ready to pay. One item it couldn't see is flagged for the client to check by hand instead of being failed." |
| 1:45–2:15 | Client tab: types "Can you also add online booking with a deposit?" → freelancer tab shows Scope Guard → send invoice → sandbox invoice link | "Then the classic scope creep. Scope Guard spots that online booking was explicitly not included, prices it at my rate, and drafts a friendly reply. One click sends a real PayPal invoice." |
| 2:15–2:35 | Client tab: slider at AI suggestion → Release → rail turns green → sandbox merchant account shows the capture | "My client reviews the evidence and releases the payment. That's a PayPal capture. If only part was done, a partial capture returns the rest automatically." |
| 2:35–2:50 | Money rail close-up, then README | "Clear agreements, money that's safe for both sides, and AI that brings evidence instead of opinions. MilestonePay: get paid for work that's verifiably done." |
