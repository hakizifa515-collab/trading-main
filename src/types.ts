export type ID = string

// ---- Backend-authoritative types --------------------------------------
// These mirror what the TRUST backend (backend/) actually returns. The
// frontend never invents or recomputes fields that belong here — it only
// displays what the server sent.

export type Role = 'USER' | 'ADMIN' | 'SUPER_ADMIN'
export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'RESTRICTED' | 'PENDING_VERIFICATION' | 'CLOSED'
export type KycStatus = 'NOT_STARTED' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED'

export interface User {
  id: ID
  email: string
  fullName: string
  country: string | null
  role: Role
  status: AccountStatus
  kycStatus: KycStatus
  twoFactorEnabled: boolean
  referralCode: string
  createdAt: string
  updatedAt: string
}

export type KycIdType = 'NATIONAL_ID' | 'PASSPORT' | 'DRIVERS_LICENSE'
export type KycDocumentKind = 'FRONT' | 'BACK' | 'SELFIE'

export interface KycDocumentSummary {
  id: string
  kind: KycDocumentKind
}

export interface KycVerificationSummary {
  id: string
  status: KycStatus
  fullName: string | null
  dateOfBirth: string | null
  country: string | null
  idType: KycIdType | null
  idNumber: string | null
  submittedAt: string
  reviewedAt: string | null
  rejectionReason: string | null
  documents: KycDocumentSummary[]
}

export interface AccountSummary {
  accountId: string
  cash: string
  reserved: string
  total: string
  unrealizedPnl: string
  equity: string
  openPositionCount: number
}

export interface LedgerEntry {
  id: string
  ledgerAccount: 'CASH' | 'RESERVED' | string
  direction: 'DEBIT' | 'CREDIT'
  amount: string
  currency: string
  entryType: string
  description: string
  relatedType: string | null
  relatedId: string | null
  createdAt: string
}

export type OrderSide = 'BUY' | 'SELL'
export type OrderStatus = 'PENDING' | 'SUBMITTED' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED'

export interface Order {
  id: ID
  userId: ID
  accountId: ID
  symbol: string
  side: OrderSide
  quantity: string
  orderType: string
  requestedPrice: string | null
  executedPrice: string | null
  filledQuantity: string
  fee: string
  status: OrderStatus
  rejectionReason: string | null
  createdAt: string
  updatedAt: string
}

export type PositionStatus = 'OPEN' | 'CLOSED'

export interface Position {
  id: ID
  userId: ID
  accountId: ID
  orderId: string | null
  symbol: string
  side: OrderSide
  quantity: string
  avgEntryPrice: string
  currentPrice: string | null
  realizedPnl: string
  fees: string
  status: PositionStatus
  openedAt: string
  closedAt: string | null
}

export type DepositStatus = 'PENDING' | 'PROCESSING' | 'CONFIRMED' | 'FAILED' | 'REVERSED'

export interface Deposit {
  id: ID
  userId: ID
  amount: string
  currency: string
  method: string
  providerReference: string | null
  status: DepositStatus
  createdAt: string
  confirmedAt: string | null
  // Checkpoint K — populated only when method === 'CRYPTO'. Snapshotted at
  // creation (Part 15) — never re-derived from current admin configuration.
  cryptoAssetSymbol: string | null
  networkCode: string | null
  receivingAddress: string | null
  proofFilename: string | null
  proofMimeType: string | null
  proofSize: number | null
}

export type WithdrawalStatus = 'PENDING' | 'REVIEW' | 'APPROVED' | 'PROCESSING' | 'COMPLETED' | 'REJECTED'

export interface Withdrawal {
  id: ID
  userId: ID
  amount: string
  currency: string
  destination: string
  status: WithdrawalStatus
  createdAt: string
  completedAt: string | null
}

export type MarketDataSource = 'LIVE' | 'SIMULATED'

export type MarketType = 'CRYPTO_SPOT' | 'CFD' | 'FOREX' | 'OTHER'

export interface MarketConfig {
  id: string
  symbol: string
  dataSource: MarketDataSource
  tradingEnabled: boolean
  maintenanceMode: boolean
  // ---- Phase 6B ----
  baseAsset: string
  quoteAsset: string
  displayName: string
  marketType: MarketType
  enabled: boolean
  pricePrecision: number
  quantityPrecision: number
  provider: string | null
  providerSymbol: string | null
}

export interface CashBalance {
  accountId: string
  currency: string
  cash: string
  reserved: string
}

export interface AssetBalance {
  currency: string
  cash: string
  reserved: string
  total: string
}

export interface ExecutionStatus {
  provider: 'Fake' | 'BinanceSandbox' | 'Disabled'
  message: string
}

export interface PlatformSettings {
  tradingEnabled: boolean
  depositsEnabled: boolean
  withdrawalsEnabled: boolean
  registrationsEnabled: boolean
  supportAutoGreetingEnabled: boolean
  supportAutoGreetingMessage: string | null
  supportAutoGreetingSenderId: string | null
  supportNotificationEmail: string | null
}

// ---- Local-only, non-financial state -----------------------------------
// Notifications have no backend model (foundation-phase gap). They are UI
// convenience only, never treated as authoritative for money/identity/etc.

export interface Notification {
  id: ID
  userId: ID
  title: string
  body: string
  read: boolean
  createdAt: number
  kind: 'price' | 'system' | 'deposit' | 'withdrawal' | 'kyc' | 'support'
}

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface TickerPrice {
  symbol: string
  name: string
  price: number
  change24h: number
  changePct: number
}

// ---- CMS (Phase 3) --------------------------------------------------------

export type CmsContentStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'
export type CmsPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'

export interface CmsSection {
  type: string
  fields: Record<string, string | number | boolean>
}

export interface CmsPage {
  id: ID
  slug: string
  title: string
  sections: CmsSection[]
  seoTitle: string | null
  seoDescription: string | null
  status: CmsContentStatus
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CmsAnnouncement {
  id: ID
  title: string
  body: string
  priority: CmsPriority
  status: CmsContentStatus
  loggedInOnly: boolean
  startAt: string | null
  endAt: string | null
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CmsFaq {
  id: ID
  question: string
  answer: string
  category: string
  order: number
  status: CmsContentStatus
  createdAt: string
  updatedAt: string
}

export interface CmsNavigationItem {
  id: ID
  label: string
  destination: string
  order: number
  isActive: boolean
}

export interface CmsRevision {
  id: ID
  entityType: string
  entityId: string
  snapshot: Record<string, unknown>
  changedByAdminId: string
  reason: string | null
  createdAt: string
}

// ---- CMS Media (Phase 4) ---------------------------------------------------

export type CmsMediaKind = 'IMAGE' | 'DOCUMENT' | 'LOGO' | 'BANNER'

export interface CmsMedia {
  id: ID
  filename: string
  mimeType: string
  size: number
  kind: CmsMediaKind
  uploadedByAdminId: ID
  createdAt: string
}

// ---- Customer Support (Phase 3) --------------------------------------------

export type SupportTicketStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_FOR_CUSTOMER' | 'WAITING_INTERNAL' | 'RESOLVED' | 'CLOSED'
export type SupportPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
export type SupportMessageVisibility = 'PUBLIC' | 'INTERNAL'

export interface SupportCategory {
  id: ID
  name: string
  description: string | null
  isActive: boolean
  order: number
}

export interface SupportAttachment {
  id: ID
  messageId: ID
  filename: string
  mimeType: string
  size: number
  createdAt: string
}

export interface SupportMessage {
  id: ID
  ticketId: ID
  authorId: ID
  body: string
  visibility: SupportMessageVisibility
  createdAt: string
  editedAt: string | null
  author?: { id: ID; email: string; fullName: string; role?: Role }
  attachments?: SupportAttachment[]
}

export interface SupportNotification {
  id: ID
  userId: ID
  ticketId: ID
  event: string
  message: string
  readAt: string | null
  createdAt: string
}

export interface SupportTicket {
  id: ID
  userId: ID
  categoryId: ID
  subject: string
  status: SupportTicketStatus
  priority: SupportPriority
  requestedPriority: SupportPriority
  assignedAgentId: ID | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  closedAt: string | null
  category?: SupportCategory
  user?: { id: ID; email: string; fullName: string; kycStatus?: KycStatus }
  assignedAgent?: { id: ID; email: string; fullName: string } | null
  messages?: SupportMessage[]
  // UX-only hint for whether the currently signed-in staff viewer holds
  // SUPER_ADMIN or the support.messages.edit permission — the backend's own
  // PATCH route authorization is what's actually authoritative. Present
  // only on the admin staff-detail response (getTicketForStaff).
  viewerCanEditMessages?: boolean
}

// ---------------------------------------------------------------------------
// Fixed-Time Options Trading — a separate product from spot Orders/Positions
// above. See backend/src/options/ for the authoritative implementation;
// nothing here computes a price, a result, or a payout — every field is
// exactly what the backend returned.
// ---------------------------------------------------------------------------

export interface OptionDurationConfig {
  durationSeconds: number
  payoutPercent: string
  minAmount: string
}

export interface OptionMarketConfig {
  symbol: string
  displayName: string
  currency: string
  minInvestment: string
  maxInvestment: string | null
  durations: OptionDurationConfig[]
}

export type OptionDirection = 'BUY' | 'SELL'
export type OptionResult = 'WIN' | 'LOSS' | 'DRAW'
export type OptionTradeStatus = 'ACTIVE' | 'SETTLED' | 'UNRESOLVED'
export type OptionResultMode = 'NORMAL' | 'FORCE_WIN' | 'FORCE_LOSS' | 'FORCE_DRAW'

export interface OptionTrade {
  id: ID
  userId: ID
  accountId: ID
  symbol: string
  direction: OptionDirection
  investment: string
  currency: string
  durationSeconds: number
  payoutPercentSnapshot: string
  entryPrice: string
  entryPriceTimestamp: string
  entrySource: string
  expiryAt: string
  expiryPrice: string | null
  expiryPriceTimestamp: string | null
  expirySource: string | null
  result: OptionResult | null
  profitAmount: string | null
  returnAmount: string | null
  status: OptionTradeStatus
  requestedResultMode: OptionResultMode
  rejectionReason: string | null
  createdAt: string
  settledAt: string | null
}

export type SandboxOutcomeMode = 'RANDOM' | 'FORCE_WIN' | 'FORCE_LOSS'

export interface OptionsSettings {
  tradingEnabled: boolean
  maxActiveTradesPerUser: number | null
  maxExposurePerUser: string | null
  sandboxOutcomeMode: SandboxOutcomeMode
  sandboxControlsAvailable: boolean
}

export interface OptionMarketAdminRow {
  id: ID
  symbol: string
  enabled: boolean
  currency: string
  minInvestment: string
  maxInvestment: string | null
  durations: { id: ID; durationSeconds: number; enabled: boolean; payoutPercent: string; minAmount: string }[]
}

export interface OptionsStats {
  activeTrades: number
  completedTrades: number
  unresolvedTrades: number
  wins: number
  losses: number
  draws: number
  totalInvestment: string
  totalPayouts: string
  byAsset: { symbol: string; count: number }[]
  byDuration: { durationSeconds: number; count: number }[]
}
