import { useWarehouseStore } from '@/store/warehouseStore'
import { MapPin, Package, AlertCircle } from 'lucide-react'

export function Sidebar() {
  const locationStats = useWarehouseStore(state => state.getLocationStats())
  const coilStats = useWarehouseStore(state => state.getCoilStats())
  const taskStats = useWarehouseStore(state => state.getTaskStats())
  
  const occupancyRate = locationStats.total > 0 
    ? Math.round((locationStats.occupied / locationStats.total) * 100) 
    : 0
  
  return (
    <aside className="fixed left-0 top-16 bottom-0 w-80 bg-primary/95 backdrop-blur-sm border-r border-secondary/50 overflow-y-auto z-40">
      <div className="p-6 space-y-6">
        <div>
          <h2 className="font-display text-lg font-semibold text-white mb-4">
            库区概览
          </h2>
          
          <div className="space-y-4">
            <div className="bg-secondary/30 rounded-xl p-4 border border-secondary/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-gray-400 text-sm">库区总面积</span>
                <MapPin className="w-4 h-4 text-accent" />
              </div>
              <div className="text-2xl font-bold text-white">
                27,000 <span className="text-sm font-normal text-gray-400">m²</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">三跨布局 (30m × 300m)</div>
            </div>
            
            <div className="bg-secondary/30 rounded-xl p-4 border border-secondary/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-gray-400 text-sm">库位利用率</span>
                <Package className="w-4 h-4 text-success" />
              </div>
              <div className="text-2xl font-bold text-white">
                {occupancyRate}<span className="text-lg">%</span>
              </div>
              <div className="w-full bg-secondary/50 rounded-full h-2 mt-2">
                <div 
                  className="bg-success h-2 rounded-full transition-all duration-300"
                  style={{ width: `${occupancyRate}%` }}
                />
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-secondary/30 rounded-lg p-3 border border-secondary/50">
                <div className="text-xs text-gray-400">总库位</div>
                <div className="text-xl font-bold text-white">{locationStats.total}</div>
              </div>
              <div className="bg-success/20 rounded-lg p-3 border border-success/30">
                <div className="text-xs text-gray-400">已占用</div>
                <div className="text-xl font-bold text-success">{locationStats.occupied}</div>
              </div>
              <div className="bg-secondary/30 rounded-lg p-3 border border-secondary/50">
                <div className="text-xs text-gray-400">空闲</div>
                <div className="text-xl font-bold text-gray-300">{locationStats.empty}</div>
              </div>
              <div className="bg-warning/20 rounded-lg p-3 border border-warning/30">
                <div className="text-xs text-gray-400">预留</div>
                <div className="text-xl font-bold text-warning">{locationStats.reserved}</div>
              </div>
            </div>
          </div>
        </div>
        
        <div>
          <h3 className="font-display text-sm font-semibold text-white mb-3">
            库存统计
          </h3>
          <div className="bg-secondary/30 rounded-xl p-4 border border-secondary/50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-gray-400 text-sm">钢卷总数</span>
              <Package className="w-4 h-4 text-accent" />
            </div>
            <div className="text-xl font-bold text-white">{coilStats.total}</div>
            <div className="text-xs text-gray-500 mt-1">
              总重量: {coilStats.totalWeight.toFixed(1)} 吨
            </div>
          </div>
        </div>
        
        <div>
          <h3 className="font-display text-sm font-semibold text-white mb-3">
            任务状态
          </h3>
          <div className="space-y-2">
            {taskStats.pending > 0 && (
              <div className="flex items-center gap-2 bg-warning/20 rounded-lg p-3 border border-warning/30">
                <AlertCircle className="w-4 h-4 text-warning" />
                <span className="text-sm text-warning">{taskStats.pending} 个待执行任务</span>
              </div>
            )}
            {taskStats.executing > 0 && (
              <div className="flex items-center gap-2 bg-accent/20 rounded-lg p-3 border border-accent/30">
                <AlertCircle className="w-4 h-4 text-accent" />
                <span className="text-sm text-accent">{taskStats.executing} 个执行中任务</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
