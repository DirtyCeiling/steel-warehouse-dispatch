import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Header } from '@/components/layout/Header'
import { Sidebar } from '@/components/layout/Sidebar'
import { InfoPanel } from '@/components/layout/InfoPanel'
import { Dashboard } from '@/pages/Dashboard'
import { Inventory } from '@/pages/Inventory'
import { Tasks } from '@/pages/Tasks'
import { Analytics } from '@/pages/Analytics'

function App() {
  return (
    <BrowserRouter>
      <div className="w-screen h-screen overflow-hidden bg-[#0a0f18]">
        <Header />
        <Sidebar />
        <InfoPanel />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/analytics" element={<Analytics />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

export default App
