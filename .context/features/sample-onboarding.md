---
feature: sample-onboarding
branch: feature/onboarding
owner: example
status: active
goal: "Build the new-user onboarding flow: signup, email verification, and the first-run checklist."
current_state: "Signup form + validation done. Email verification token endpoint stubbed; checklist UI not started."
decisions:
  - at: 2026-06-01T10:00:00.000Z
    text: "Use signed, expiring tokens for email verification instead of storing codes server-side."
open_questions:
  - "Should the first-run checklist be dismissible or forced?"
files_touched:
  - src/auth/signup.ts
  - src/auth/verify.ts
  - src/ui/OnboardingChecklist.tsx
updated_at: 2026-06-02T14:30:00.000Z
recent_deltas:
  - at: 2026-06-02T14:30:00.000Z
    kind: note
    summary: "Stubbed the verification token endpoint; wiring email send next."
    files:
      - src/auth/verify.ts
v: 1
---

# sample-onboarding  ·  example  ·  active

**Goal:** Build the new-user onboarding flow: signup, email verification, and the first-run checklist.

**Current state:** Signup form + validation done. Email verification token endpoint stubbed; checklist UI not started.

**Files:** `src/auth/signup.ts`, `src/auth/verify.ts`, `src/ui/OnboardingChecklist.tsx`

## Decisions
- 2026-06-01 10:00 — Use signed, expiring tokens for email verification instead of storing codes server-side.

## Open questions
- Should the first-run checklist be dismissible or forced?

## Recent activity
- 2026-06-02 14:30 — note — Stubbed the verification token endpoint; wiring email send next.
