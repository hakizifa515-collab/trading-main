// Named constants for AuditLog.action / AdminAction.action so event names
// stay consistent across the codebase instead of being retyped as free
// strings at each call site. This is intentionally an extensible list, not
// an enum/migration — new event names can be added here without a schema
// change.
export const AuditEvent = {
  ADMIN_LOGIN: 'ADMIN_LOGIN',
  ADMIN_LOGIN_FAILED: 'ADMIN_LOGIN_FAILED',
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
  USER_REGISTERED: 'USER_REGISTERED',
  USER_CREATED: 'USER_CREATED',
  USER_SUSPENDED: 'USER_SUSPENDED',
  USER_REACTIVATED: 'USER_REACTIVATED',
  USER_STATUS_CHANGED: 'USER_STATUS_CHANGED',
  ROLE_CHANGED: 'ROLE_CHANGED',
  PERMISSION_CHANGED: 'PERMISSION_CHANGED',
  KYC_SUBMITTED: 'KYC_SUBMITTED',
  KYC_APPROVED: 'KYC_APPROVED',
  KYC_REJECTED: 'KYC_REJECTED',
  // ---- Mine/Profile + KYC document checkpoint ------------------------------
  KYC_RESUBMITTED: 'KYC_RESUBMITTED',
  KYC_DOCUMENT_UPLOADED: 'KYC_DOCUMENT_UPLOADED',
  // Fired only when an ADMIN views a document (Part 22) — a user viewing
  // their own submitted document is not a reviewable security event.
  KYC_DOCUMENT_VIEWED: 'KYC_DOCUMENT_VIEWED',
  DEPOSIT_CREATED: 'DEPOSIT_CREATED',
  DEPOSIT_APPROVED: 'DEPOSIT_APPROVED',
  DEPOSIT_REJECTED: 'DEPOSIT_REJECTED',
  WITHDRAWAL_CREATED: 'WITHDRAWAL_CREATED',
  WITHDRAWAL_APPROVED: 'WITHDRAWAL_APPROVED',
  WITHDRAWAL_REJECTED: 'WITHDRAWAL_REJECTED',
  FINANCIAL_ADJUSTMENT: 'FINANCIAL_ADJUSTMENT',
  TRADING_PAUSED: 'TRADING_PAUSED',
  TRADING_RESUMED: 'TRADING_RESUMED',
  DEPOSITS_PAUSED: 'DEPOSITS_PAUSED',
  DEPOSITS_RESUMED: 'DEPOSITS_RESUMED',
  WITHDRAWALS_PAUSED: 'WITHDRAWALS_PAUSED',
  WITHDRAWALS_RESUMED: 'WITHDRAWALS_RESUMED',
  REGISTRATIONS_PAUSED: 'REGISTRATIONS_PAUSED',
  REGISTRATIONS_RESUMED: 'REGISTRATIONS_RESUMED',
  MARKET_DISABLED: 'MARKET_DISABLED',
  MARKET_ENABLED: 'MARKET_ENABLED',
  SECURITY_SETTING_CHANGED: 'SECURITY_SETTING_CHANGED',

  // ---- Order execution (Phase 6F Checkpoint C) — sandbox/fake provider
  // only; see execution/ for the provider abstraction. Every event here is
  // written by OrdersService, never fabricated ahead of the real state
  // transition it describes (e.g. ORDER_FILLED is only ever written after
  // a provider-confirmed fill has actually been validated and settled).
  ORDER_CREATED: 'ORDER_CREATED',
  EXECUTION_SUBMITTED: 'EXECUTION_SUBMITTED',
  EXECUTION_ACKNOWLEDGED: 'EXECUTION_ACKNOWLEDGED',
  EXECUTION_REJECTED: 'EXECUTION_REJECTED',
  // Not part of Checkpoint C's literal requested list, but necessary to
  // avoid an actively misleading audit trail: EXECUTION_REJECTED implies a
  // confident "the provider rejected this" — using it for a genuinely
  // AMBIGUOUS outcome (timeout, lost response, malformed response) would
  // misrepresent what happened. See orders.service.ts's
  // CONFIDENT_REJECTION_CATEGORIES vs the ambiguous-outcome path.
  EXECUTION_UNRESOLVED: 'EXECUTION_UNRESOLVED',
  ORDER_FILLED: 'ORDER_FILLED',
  ORDER_REJECTED: 'ORDER_REJECTED',
  ASSET_BALANCE_UPDATED: 'ASSET_BALANCE_UPDATED',
  FEE_CHARGED: 'FEE_CHARGED',

  // ---- LIMIT order lifecycle (Phase 6F Checkpoint D) -------------------
  ORDER_OPENED: 'ORDER_OPENED',
  ORDER_PARTIALLY_FILLED: 'ORDER_PARTIALLY_FILLED',
  ORDER_CANCEL_REQUESTED: 'ORDER_CANCEL_REQUESTED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',

  // ---- Provider reconciliation (Phase 6F Checkpoint E) — the run itself
  // is audited (who ran it, when, summary counts) even though the run is
  // read-only; this is a distinct event from any of the ORDER_* ones above,
  // none of which fire as a side effect of reconciliation (Part 13: it
  // never mutates financial state).
  RECONCILIATION_RUN: 'RECONCILIATION_RUN',

  // ---- Pre-trade risk engine (Phase 6F Checkpoint F) — recorded for
  // EVERY risk-engine rejection, whether or not it also produced a
  // persisted Order row (Part 16). Never recorded for an allowed order —
  // that would just be per-order noise the existing ORDER_CREATED/
  // EXECUTION_SUBMITTED events already cover.
  ORDER_RISK_REJECTED: 'ORDER_RISK_REJECTED',

  // ---- Crypto Deposit configuration (Checkpoint K) — receiving-address
  // management is financially sensitive; every change is audited, mirroring
  // OPTION_MARKET_CHANGED's pattern (previousState/newState carries the
  // specific field(s) that changed, so one event name covers create/enable/
  // disable/address-change/minimum-change without needing five near-
  // identical event names).
  CRYPTO_ASSET_CHANGED: 'CRYPTO_ASSET_CHANGED',
  CRYPTO_DEPOSIT_ADDRESS_CHANGED: 'CRYPTO_DEPOSIT_ADDRESS_CHANGED',
  DEPOSIT_PROOF_UPLOADED: 'DEPOSIT_PROOF_UPLOADED',

  // ---- Fixed-Time Options Trading (separate product from spot Orders) -----
  OPTION_TRADE_CREATED: 'OPTION_TRADE_CREATED',
  OPTION_TRADE_REJECTED: 'OPTION_TRADE_REJECTED',
  OPTION_TRADE_SETTLED: 'OPTION_TRADE_SETTLED',
  OPTION_TRADE_UNRESOLVED: 'OPTION_TRADE_UNRESOLVED',
  OPTION_MARKET_CHANGED: 'OPTION_MARKET_CHANGED',
  OPTION_DURATION_CHANGED: 'OPTION_DURATION_CHANGED',
  OPTIONS_TRADING_PAUSED: 'OPTIONS_TRADING_PAUSED',
  OPTIONS_TRADING_RESUMED: 'OPTIONS_TRADING_RESUMED',
  OPTIONS_SETTINGS_CHANGED: 'OPTIONS_SETTINGS_CHANGED',
  // Recorded for EVERY non-NORMAL requestedResultMode, whether accepted
  // (dev/test) or rejected (production/staging) — an attempted production
  // override is itself a meaningful security event regardless of outcome.
  OPTION_DEMO_SIMULATION_USED: 'OPTION_DEMO_SIMULATION_USED',
  // Trade Experience checkpoint, Part 8 — the platform-wide sandbox
  // outcome-mode admin dial, distinct from OPTION_DEMO_SIMULATION_USED
  // (which covers the separate, per-trade customer-requested override).
  SANDBOX_OUTCOME_MODE_CHANGED: 'SANDBOX_OUTCOME_MODE_CHANGED',
  // Trade Management "USER CONTROL" (Part 28) — creating a designated
  // test/sandbox user (never an existing account), and changing that
  // user's per-user test outcome override.
  TEST_USER_CREATED: 'TEST_USER_CREATED',
  TEST_USER_OUTCOME_MODE_CHANGED: 'TEST_USER_OUTCOME_MODE_CHANGED',

  // ---- CMS (Phase 3) --------------------------------------------------------
  CONTENT_CREATED: 'CONTENT_CREATED',
  CONTENT_UPDATED: 'CONTENT_UPDATED',
  CONTENT_PUBLISHED: 'CONTENT_PUBLISHED',
  CONTENT_UNPUBLISHED: 'CONTENT_UNPUBLISHED',
  CONTENT_ARCHIVED: 'CONTENT_ARCHIVED',
  CONTENT_RESTORED: 'CONTENT_RESTORED',
  MEDIA_UPLOADED: 'MEDIA_UPLOADED',
  MEDIA_DELETED: 'MEDIA_DELETED',
  NAVIGATION_UPDATED: 'NAVIGATION_UPDATED',

  // ---- Customer Support (Phase 3) --------------------------------------------
  // Ordinary customer messages are NOT audited here — that's normal support
  // conversation history, stored in SupportMessage, not a security/compliance
  // event. Only administrative actions on tickets are.
  TICKET_ASSIGNED: 'TICKET_ASSIGNED',
  TICKET_STARTED_BY_STAFF: 'TICKET_STARTED_BY_STAFF',
  TICKET_STATUS_CHANGED: 'TICKET_STATUS_CHANGED',
  TICKET_PRIORITY_CHANGED: 'TICKET_PRIORITY_CHANGED',
  INTERNAL_NOTE_CREATED: 'INTERNAL_NOTE_CREATED',
  // A staff member editing their own previously-sent message. The ONLY place
  // the pre-edit text survives — previousState/newState carry the full body
  // before/after, so the original is never lost even though the visible
  // SupportMessage.body is replaced. See SupportService.editStaffMessage().
  SUPPORT_MESSAGE_EDITED: 'SUPPORT_MESSAGE_EDITED',
  // Soft-deleting one Support message (SUPER_ADMIN only; Support Audit).
  // previousState carries the full original body/visibility (the message
  // row itself is never hard-deleted, but this is the record that survives
  // even if it ever were) — see SupportService.deleteStaffMessage().
  MESSAGE_DELETED: 'MESSAGE_DELETED',
  SUPPORT_CATEGORY_CHANGED: 'SUPPORT_CATEGORY_CHANGED',
  SUPPORT_AUTO_GREETING_CHANGED: 'SUPPORT_AUTO_GREETING_CHANGED',
  SUPPORT_NOTIFICATION_EMAIL_CHANGED: 'SUPPORT_NOTIFICATION_EMAIL_CHANGED',

  // ---- Admin Panel redesign ---------------------------------------------------
  ADMIN_CONTACT_CHANGED: 'ADMIN_CONTACT_CHANGED',
  ADMIN_CONTACT_DELETED: 'ADMIN_CONTACT_DELETED',
  ADMIN_ACCOUNT_PASSWORD_RESET: 'ADMIN_ACCOUNT_PASSWORD_RESET',
} as const

export type AuditEventName = (typeof AuditEvent)[keyof typeof AuditEvent]
