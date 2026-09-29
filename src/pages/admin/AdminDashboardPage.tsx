// Admin Dashboard — the landing page at /admin. Every card below links to a
// real, already-implemented section; nothing here is a placeholder.
// "Trades"/"Trade Settings" both live under the single Trading card/route
// (that page already combines the kill switch, risk limits, and stats/
// duration config into one screen — see TradingPage.tsx, which has no
// customer-outcome-manipulation controls). "Admin Contact" and "Contact
// Admin" are the same destination (/admin/contacts) — /admin/contact-admin
// redirects there. A top row of compact quick-links (Dashboard/Trading/
// Support Chat) sits above the main colored tile grid — reference design.
import { Link } from 'react-router-dom'
import { useAuth } from '../../store/auth'
import {
  ShieldAlert, Users, ArrowDownToLine, ArrowUpFromLine, ShieldCheck, Settings,
  Headset, Wallet, LineChart, DollarSign, MessageCircle, UserCog, LayoutDashboard,
  TrendingUp, KeyRound, Eye, type LucideIcon,
} from 'lucide-react'

const QUICK_LINKS: { to: string; icon: LucideIcon; title: string; subtitle: string }[] = [
  { to: '/admin', icon: LayoutDashboard, title: 'Dashboard', subtitle: 'Overview' },
  { to: '/admin/trading', icon: TrendingUp, title: 'Trading', subtitle: 'Manage Orders' },
  { to: '/admin/support', icon: MessageCircle, title: 'Support Chat', subtitle: 'Chat with customers' },
]

// Each card's own saturated gradient pair — differentiation by color per the
// reference design, instead of a single uniform icon-container color.
const CARDS: { to: string; icon: LucideIcon; title: string; description: string; from: string; to2: string }[] = [
  { to: '/admin/deposits', icon: ArrowDownToLine, title: 'Deposit', description: 'Approve customer deposits', from: 'from-green-600', to2: 'to-green-700' },
  { to: '/admin/withdrawals', icon: ArrowUpFromLine, title: 'Withdraw', description: 'Approve withdrawals', from: 'from-red-600', to2: 'to-red-700' },
  { to: '/admin/users', icon: Users, title: 'Users', description: 'Manage all users', from: 'from-blue-600', to2: 'to-blue-700' },
  { to: '/admin/wallet-adjustment', icon: DollarSign, title: 'Manual Deposit', description: 'Add balance manually', from: 'from-cyan-600', to2: 'to-cyan-700' },
  { to: '/admin/trading', icon: LineChart, title: 'Trades', description: 'Trade management', from: 'from-purple-600', to2: 'to-purple-700' },
  { to: '/admin/deposit-wallet', icon: Wallet, title: 'Deposit Wallet', description: 'Wallet address & QR', from: 'from-orange-600', to2: 'to-orange-700' },
  { to: '/admin/contacts', icon: MessageCircle, title: 'Admin Contact', description: 'LINE / Telegram', from: 'from-pink-600', to2: 'to-pink-700' },
  { to: '/admin/kyc', icon: ShieldCheck, title: 'KYC Verification', description: 'Approve customer identity', from: 'from-emerald-600', to2: 'to-emerald-700' },
  { to: '/admin/support', icon: Headset, title: 'Support Chat', description: 'Chat with customers', from: 'from-sky-600', to2: 'to-sky-700' },
  { to: '/admin/settings', icon: Settings, title: 'Settings', description: 'System settings', from: 'from-slate-600', to2: 'to-slate-700' },
  { to: '/admin/admin-management', icon: UserCog, title: 'Admin Management', description: 'Administrator account', from: 'from-slate-800', to2: 'to-slate-900' },
  // Same "shown to every admin, backend enforces the real 403" pattern as
  // every card above (e.g. Admin Management itself) — a plain ADMIN without
  // the support.audit grant sees an honest Forbidden state on click, same as
  // clicking Admin Management does; see AdminPanel's own comment on why
  // hiding the nav item is never treated as the real security boundary here.
  { to: '/admin/support-audit', icon: Eye, title: 'Support Audit', description: 'Cross-ticket moderation feed', from: 'from-rose-700', to2: 'to-rose-900' },
  { to: '/admin/account', icon: KeyRound, title: 'Account & Security', description: 'Your login email & password', from: 'from-indigo-600', to2: 'to-indigo-700' },
]

export function AdminDashboardPage() {
  const { user } = useAuth()
  if (!user) return null

  return (
    <div>
      <div className="mb-6 flex items-center gap-4 rounded-xl border border-admin-border bg-admin-card p-5">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-admin-gold/15 text-admin-gold"><ShieldAlert className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold text-admin-text">Administrator</p>
          <p className="text-xs font-medium text-admin-gold">Full Access Control</p>
        </div>
        <div className="hidden text-right sm:block">
          <p className="text-sm text-admin-muted">{user.email}</p>
          <p className="text-xs text-admin-mutedDim">{user.role}</p>
        </div>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {QUICK_LINKS.map((q) => (
          <Link key={q.title} to={q.to} className="admin-card group flex items-center gap-3 p-4 transition hover:border-admin-borderLight hover:bg-admin-surface">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ocean-500/15 text-ocean-400"><q.icon className="h-4.5 w-4.5" /></div>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-admin-text">{q.title}</p>
              <p className="truncate text-xs text-admin-mutedDim">{q.subtitle}</p>
            </div>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {CARDS.map((c) => (
          <Link
            key={c.title}
            to={c.to}
            className={`group relative flex flex-col gap-3 overflow-hidden rounded-2xl bg-gradient-to-br ${c.from} ${c.to2} p-5 shadow-lg transition hover:brightness-110 active:scale-[0.98]`}
          >
            <div aria-hidden="true" className="pointer-events-none absolute -right-6 -top-8 h-28 w-28 rounded-full bg-white/10" />
            <div aria-hidden="true" className="pointer-events-none absolute -bottom-10 -right-2 h-20 w-20 rounded-full bg-white/5" />
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-white"><c.icon className="h-5 w-5" /></div>
            <div className="relative">
              <h3 className="font-bold text-white">{c.title}</h3>
              <p className="mt-1 text-xs text-white/70">{c.description}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
