import { Warehouse, Package, ClipboardList, BarChart3 } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'

const navItems = [
  { path: '/', icon: Warehouse, label: '库区总览' },
  { path: '/inventory', icon: Package, label: '库存管理' },
  { path: '/tasks', icon: ClipboardList, label: '调度任务' },
  { path: '/analytics', icon: BarChart3, label: '数据分析' },
]

export function Header() {
  const location = useLocation()
  
  return (
    <header className="fixed top-0 left-0 right-0 h-16 bg-primary/90 backdrop-blur-sm border-b border-secondary/50 z-50">
      <div className="flex items-center justify-between h-full px-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-accent/20 rounded-lg flex items-center justify-center">
            <Warehouse className="w-6 h-6 text-accent" />
          </div>
          <h1 className="font-display text-xl font-bold text-white">
            钢厂库区调度系统
          </h1>
        </div>
        
        <nav className="flex items-center gap-2">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all duration-200 ${
                  isActive
                    ? 'bg-accent/20 text-accent shadow-lg shadow-accent/20'
                    : 'text-gray-400 hover:text-white hover:bg-secondary/50'
                }`}
              >
                <item.icon className="w-5 h-5" />
                <span className="font-body">{item.label}</span>
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
