import { useEffect, useState } from 'react'
import { Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import Login from './components/Login/login'
import Signup from './components/Signup/Signup'
import Home from './components/Home/home'
import Onboarding from './components/Onboarding/onboarding'
import './index.css'
import Automation from './components/Automation/automation'
import AutomationBrowser from './components/Automation/work/automationBrowser'
import Profile from './components/Profile/profile'
import ProfileSettings from './components/Profile/profileSettings'
import ProfileInterests from './components/Profile/profileInterests'
import Settings from './components/Settings/settings'
import Resumes from './components/Settings/resumes'
import { FetchErrorProvider } from './components/common/FetchError'
import ComponentLoader from './components/common/ComponentLoader'
import { setNavigate } from './lib/navigation'
import { onSessionExpired, takeReturnTo } from './lib/session'
import { queryClient } from './queries/client'
import NotFound from './components/NotFound/notfound'
import ServerError from './components/NotFound/servererror'
import RequestError from './components/NotFound/requesterror'

function SideNav() {
  return (
    <div className="left-nav-icons">
      <NavLink
        to="/"
        title="Home"
        className={({ isActive }) => `nav-icon${isActive ? ' nav-icon--active' : ''}`}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
        </svg>
      </NavLink>
      <NavLink
        to="/automation"
        title="Play"
        className={({ isActive }) => `nav-icon${isActive ? ' nav-icon--active' : ''}`}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 3l14 9-14 9V3z"></path>
        </svg>
      </NavLink>
      <NavLink
        to="/profile"
        title="Profile"
        className={({ isActive }) => `nav-icon${isActive ? ' nav-icon--active' : ''}`}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 11c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm-6 9c0-3.31 2.69-6 6-6s6 2.69 6 6H6z"></path>
        </svg>
      </NavLink>
      <NavLink
        to="/settings"
        title="Settings"
        className={({ isActive }) => `nav-icon${isActive ? ' nav-icon--active' : ''}`}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0A1.65 1.65 0 0 0 10.35 5V4.91a2 2 0 0 1 4 0V5a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </NavLink>
    </div>
  )
}

function AuthenticatedLayout() {
  return (
    <>
      <SideNav />
      <Outlet />
    </>
  )
}

function AuthRoutes({ authError }: { authError: string | null }) {
  const navigate = useNavigate()

  return (
    <Routes>
      <Route path="/login" element={<Login onNavigateToSignup={() => navigate('/signup')} authError={authError} />} />
      <Route path="/signup" element={<Signup onNavigateToLogin={() => navigate('/login')} />} />
      {/* Old links; a 401 now goes to login. */}
      <Route path="/401" element={<Navigate to="/login" replace />} />
      <Route path="/404" element={<NotFound />} />
      <Route path="/500" element={<ServerError />} />
      <Route path="/error" element={<RequestError />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

function OnboardingRoutes({ onComplete }: { onComplete: () => void }) {
  return (
    <Routes>
      <Route path="/onboarding" element={<Onboarding onComplete={onComplete} />} />
      {/* Old links; a 401 now goes to login. */}
      <Route path="/401" element={<Navigate to="/login" replace />} />
      <Route path="/404" element={<NotFound />} />
      <Route path="/500" element={<ServerError />} />
      <Route path="/error" element={<RequestError />} />
      <Route path="*" element={<Navigate to="/onboarding" replace />} />
    </Routes>
  )
}

function AppRoutes() {
  return (
    <Routes>
      <Route element={<AuthenticatedLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/automation" element={<Automation />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/profile-settings" element={<ProfileSettings />} />
        <Route path="/settings/interests" element={<ProfileInterests />} />
        <Route path="/settings/resumes" element={<Resumes />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      {/* Onboarding completion flips this route tree in before navigate('/') runs,
          so /onboarding has to resolve to home rather than the catch-all 404.
          Signing in does the same thing from /login and /signup -- the session
          arrives while the url still points at the auth screen. */}
      <Route path="/onboarding" element={<Navigate to="/" replace />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/signup" element={<Navigate to="/" replace />} />
      {/* Old links; a 401 now goes to login. */}
      <Route path="/401" element={<Navigate to="/login" replace />} />
      <Route path="/404" element={<NotFound />} />
      <Route path="/500" element={<ServerError />} />
      <Route path="/error" element={<RequestError />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

function App() {
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => { setNavigate(navigate) }, [navigate])
  useEffect(() => { onSessionExpired(setAuthError) }, [])

  useEffect(() => {
    window.electronAPI?.onOAuthCallback?.(async (url: string) => {
      const hash = url.split('#')[1]
      if (!hash) return
      const params = new URLSearchParams(hash)
      const access_token = params.get('access_token')
      const refresh_token = params.get('refresh_token')
      if (access_token && refresh_token) {
        const { data } = await supabase.auth.setSession({ access_token, refresh_token })
        if (data.user) {
          if (!data.user.email?.endsWith('@northeastern.edu')) {
            await supabase.auth.signOut()
            setAuthError('please use a valid @northeastern.edu email address')
            return
          }
          // users/profile/preferences rows are created by a database trigger the
          // moment Supabase Auth creates this user -- no separate API call needed.
        }
      }
    })
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)

      if (session?.user) {
        const onboardingCompleted = session.user.user_metadata?.onboarding_completed
        setShowOnboarding(!onboardingCompleted)
      } else {
        setShowOnboarding(false)
      }

      setLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') queryClient.clear()
      if (event === 'SIGNED_IN') {
        setAuthError(null)
        // Back to where the session expired. Navigating before the route tree flips
        // keeps /login's redirect to home from winning.
        const returnTo = takeReturnTo()
        if (returnTo) navigate(returnTo, { replace: true })
      }
      setUser(session?.user ?? null)

      if (session?.user) {
        const onboardingCompleted = session.user.user_metadata?.onboarding_completed
        setShowOnboarding(!onboardingCompleted)
      } else {
        setShowOnboarding(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const handleOnboardingComplete = () => {
    setShowOnboarding(false)
    navigate('/')
  }

  if (loading) {
    return (
      <FetchErrorProvider>
        <div className="app-loading">
          <ComponentLoader fullPage />
        </div>
      </FetchErrorProvider>
    )
  }

  return (
    <FetchErrorProvider>
      {user ? (
        showOnboarding ? (
          <OnboardingRoutes onComplete={handleOnboardingComplete} />
        ) : (
          <>
            <AppRoutes />
            {/* Outside the route tree so a run survives navigation. */}
            <AutomationBrowser />
          </>
        )
      ) : (
        <AuthRoutes authError={authError} />
      )}
    </FetchErrorProvider>
  )
}

export default App
