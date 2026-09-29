import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './store/auth'
import { LandingPage } from './pages/LandingPage'
import { SignupPage } from './pages/SignupPage'
import { LoginPage } from './pages/LoginPage'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { VerifyEmailPage } from './pages/VerifyEmailPage'
import { TwoFactorSetupPage } from './pages/TwoFactorSetupPage'
import { TwoFactorVerifyPage } from './pages/TwoFactorVerifyPage'
import { DashboardLayout } from './components/DashboardLayout'
import { DashboardPage } from './pages/DashboardPage'
import HomePage from './pages/HomePage'
import MarketsPage from './pages/MarketsPage'
import TradePage from './pages/TradePage'
import AssetsPage from './pages/AssetsPage'
import { WalletPage } from './pages/WalletPage'
import { ProfilePage } from './pages/ProfilePage'
import { DepositPage } from './pages/DepositPage'
import { ConvertPage } from './pages/ConvertPage'
import { WithdrawPage } from './pages/WithdrawPage'
import { KycPage } from './pages/KycPage'
import { SecurityPage } from './pages/SecurityPage'
import { SetNewPasswordPage } from './pages/SetNewPasswordPage'
import { LanguagesPage } from './pages/LanguagesPage'
import { AboutPage } from './pages/AboutPage'
import { SupportPage } from './pages/SupportPage'
import { CmsPageView } from './pages/CmsPageView'
import { AdminLayout } from './pages/admin/AdminLayout'
import { AdminDashboardPage } from './pages/admin/AdminDashboardPage'
import { TradingPage } from './pages/admin/TradingPage'
import { SupportPage as AdminSupportPage } from './pages/admin/SupportPage'
import { DepositsPage as AdminDepositsPage } from './pages/admin/DepositsPage'
import { WithdrawalsPage as AdminWithdrawalsPage } from './pages/admin/WithdrawalsPage'
import { UsersPage as AdminUsersPage } from './pages/admin/UsersPage'
import { WalletAdjustmentPage } from './pages/admin/WalletAdjustmentPage'
import { DepositWalletPage } from './pages/admin/DepositWalletPage'
import { ContactsPage as AdminContactsPage } from './pages/admin/ContactsPage'
import { KycPage as AdminKycPage } from './pages/admin/KycPage'
import { SettingsPage as AdminSettingsPage } from './pages/admin/SettingsPage'
import { AdminManagementPage } from './pages/admin/AdminManagementPage'
import { SupportAuditPage } from './pages/admin/SupportAuditPage'
import { AccountPage as AdminAccountPage } from './pages/admin/AccountPage'
import { CmsPage as AdminCmsPage } from './pages/admin/CmsPage'
import { AuditPage as AdminAuditPage } from './pages/admin/AuditPage'
import { isAdminRole } from './lib/roles'

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="flex min-h-screen items-center justify-center"><p className="text-slate-500">Loading…</p></div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="flex min-h-screen items-center justify-center"><p className="text-slate-500">Loading…</p></div>
  if (!user) return <Navigate to="/login" replace />
  // Fail-closed allow-list — see src/lib/roles.ts. This client-side check
  // is a UX convenience only; the real security boundary is the backend's
  // RolesGuard, which independently rejects every /admin/* request from a
  // non-admin role regardless of what this component renders.
  if (!isAdminRole(user.role)) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/pages/:slug" element={<CmsPageView />} />
      <Route path="/verify-email" element={<Protected><VerifyEmailPage /></Protected>} />
      <Route path="/2fa-setup" element={<Protected><TwoFactorSetupPage /></Protected>} />
      <Route path="/2fa-verify" element={<TwoFactorVerifyPage />} />
      <Route element={<Protected><DashboardLayout /></Protected>}>
        <Route path="/home" element={<HomePage />} />
        <Route path="/dashboard" element={<HomePage />} />
        <Route path="/markets" element={<MarketsPage />} />
        <Route path="/trade" element={<TradePage />} />
        {/* Options Trading is removed from the normal-user experience —
            see admin panel's own "Options Trading" tab, which is unaffected.
            Direct navigation to the old URL redirects to Trade rather than
            404ing or exposing the page. */}
        <Route path="/options" element={<Navigate to="/trade" replace />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="/deposit" element={<DepositPage />} />
        <Route path="/withdraw" element={<WithdrawPage />} />
        <Route path="/convert" element={<ConvertPage />} />
        <Route path="/kyc" element={<KycPage />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/security/password" element={<SetNewPasswordPage />} />
        <Route path="/languages" element={<LanguagesPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/support" element={<SupportPage />} />
      </Route>
      <Route path="/admin" element={<AdminOnly><AdminLayout /></AdminOnly>}>
        <Route index element={<AdminDashboardPage />} />
        <Route path="trading" element={<TradingPage />} />
        <Route path="support" element={<AdminSupportPage />} />
        <Route path="deposits" element={<AdminDepositsPage />} />
        <Route path="withdrawals" element={<AdminWithdrawalsPage />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="wallet-adjustment" element={<WalletAdjustmentPage />} />
        <Route path="deposit-wallet" element={<DepositWalletPage />} />
        <Route path="contacts" element={<AdminContactsPage />} />
        {/* "Admin Contact" and "Contact Admin" name the same destination in
            the reference spec — this keeps both URLs real instead of
            building a second, duplicate CRUD page. */}
        <Route path="contact-admin" element={<Navigate to="/admin/contacts" replace />} />
        <Route path="kyc" element={<AdminKycPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
        <Route path="admin-management" element={<AdminManagementPage />} />
        <Route path="support-audit" element={<SupportAuditPage />} />
        <Route path="account" element={<AdminAccountPage />} />
        {/* Not primary dashboard cards, but real working sections — reachable
            from Settings ("More") rather than removed. */}
        <Route path="cms" element={<AdminCmsPage />} />
        <Route path="audit-logs" element={<AdminAuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
