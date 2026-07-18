import { Suspense, lazy } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { Groups } from './features/groups/Groups'

const LedgerApp = lazy(() => import('./features/ledger/LedgerApp').then((m) => ({ default: m.LedgerApp })))
const ConvoyApp = lazy(() => import('./features/convoy/ConvoyApp').then((m) => ({ default: m.ConvoyApp })))
const CampApp = lazy(() => import('./features/camp/CampApp').then((m) => ({ default: m.CampApp })))
const VoiceApp = lazy(() => import('./features/voice/VoiceApp').then((m) => ({ default: m.VoiceApp })))

function TabBar() {
  const tabs = [
    { to: '/groups', label: '群组', icon: '👥' },
    { to: '/convoy', label: '跟车', icon: '🚗' },
    { to: '/camp', label: '营地', icon: '🏕️' },
    { to: '/ledger', label: '记账', icon: '🧾' },
    { to: '/voice', label: '变声', icon: '🎭' },
  ]
  return (
    <nav className="tabbar">
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} className="tab">
          <span className="tab-icon">{t.icon}</span>
          <span className="tab-label">{t.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

export function App() {
  return (
    <div className="app">
      <main className="screen">
        <Suspense fallback={<div className="empty"><div className="big">⏳</div>加载中…</div>}>
          <Routes>
            <Route path="/" element={<Navigate to="/groups" replace />} />
            <Route path="/groups" element={<Groups />} />
            <Route path="/convoy" element={<ConvoyApp />} />
            <Route path="/camp" element={<CampApp />} />
            <Route path="/ledger" element={<LedgerApp />} />
            <Route path="/voice" element={<VoiceApp />} />
            <Route path="*" element={<Navigate to="/groups" replace />} />
          </Routes>
        </Suspense>
      </main>
      <TabBar />
    </div>
  )
}
