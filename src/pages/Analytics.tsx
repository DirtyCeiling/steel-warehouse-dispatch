import { useWarehouseStore } from '@/store/warehouseStore'
import { BarChart3, TrendingUp, Package, MapPin } from 'lucide-react'

export function Analytics() {
  const locationStats = useWarehouseStore(state => state.getLocationStats())
  const coilStats = useWarehouseStore(state => state.getCoilStats())
  const taskStats = useWarehouseStore(state => state.getTaskStats())
  
  const occupancyRate = locationStats.total > 0 
    ? Math.round((locationStats.occupied / locationStats.total) * 100) 
    : 0
  
  const materialData = Object.entries(coilStats.byMaterial)
    .map(([material, count]) => ({ material, count }))
    .sort((a, b) => b.count - a.count)
  
  const maxCount = Math.max(...materialData.map(d => d.count), 1)
  
  return (
    <div className="h-full pt-16 ml-80 p-6 overflow-y-auto">
      <div className="max-w-6xl mx-auto">
        <h1 className="font-display text-2xl font-bold text-white mb-6">
          数据分析
        </h1>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className="bg-secondary/30 rounded-xl p-4 border border-secondary/50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-gray-400 text-sm">库位利用率</span>
              <MapPin className="w-5 h-5 text-accent" />
            </div>
            <div className="text-3xl font-bold text-white">{occupancyRate}%</div>
            <div className="text-xs text-gray-500 mt-1">
              {locationStats.occupied}/{locationStats.total} 库位
            </div>
          </div>
          
          <div className="bg-secondary/30 rounded-xl p-4 border border-secondary/50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-gray-400 text-sm">库存总量</span>
              <Package className="w-5 h-5 text-success" />
            </div>
            <div className="text-3xl font-bold text-white">{coilStats.total}</div>
            <div className="text-xs text-gray-500 mt-1">
              {coilStats.totalWeight.toFixed(1)} 吨
            </div>
          </div>
          
          <div className="bg-secondary/30 rounded-xl p-4 border border-secondary/50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-gray-400 text-sm">待执行任务</span>
              <TrendingUp className="w-5 h-5 text-warning" />
            </div>
            <div className="text-3xl font-bold text-warning">{taskStats.pending}</div>
            <div className="text-xs text-gray-500 mt-1">
              {taskStats.executing} 个执行中
            </div>
          </div>
          
          <div className="bg-secondary/30 rounded-xl p-4 border border-secondary/50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-gray-400 text-sm">已完成任务</span>
              <BarChart3 className="w-5 h-5 text-success" />
            </div>
            <div className="text-3xl font-bold text-success">{taskStats.completed}</div>
            <div className="text-xs text-gray-500 mt-1">
              总计 {taskStats.total} 个任务
            </div>
          </div>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-secondary/30 rounded-xl p-6 border border-secondary/50">
            <h3 className="font-display text-lg font-semibold text-white mb-4">
              材质分布
            </h3>
            <div className="space-y-3">
              {materialData.map((item) => (
                <div key={item.material}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-gray-400">{item.material}</span>
                    <span className="text-sm text-white">{item.count} 卷</span>
                  </div>
                  <div className="w-full bg-secondary/50 rounded-full h-3">
                    <div 
                      className="bg-accent h-3 rounded-full transition-all duration-500"
                      style={{ width: `${(item.count / maxCount) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="bg-secondary/30 rounded-xl p-6 border border-secondary/50">
            <h3 className="font-display text-lg font-semibold text-white mb-4">
              库区状态
            </h3>
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-400">已占用</span>
                  <span className="text-sm text-success">{locationStats.occupied}</span>
                </div>
                <div className="w-full bg-secondary/50 rounded-full h-4">
                  <div 
                    className="bg-success h-4 rounded-full transition-all duration-500"
                    style={{ width: `${(locationStats.occupied / locationStats.total) * 100}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-400">空闲</span>
                  <span className="text-sm text-gray-300">{locationStats.empty}</span>
                </div>
                <div className="w-full bg-secondary/50 rounded-full h-4">
                  <div 
                    className="bg-gray-400 h-4 rounded-full transition-all duration-500"
                    style={{ width: `${(locationStats.empty / locationStats.total) * 100}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-400">预留</span>
                  <span className="text-sm text-warning">{locationStats.reserved}</span>
                </div>
                <div className="w-full bg-secondary/50 rounded-full h-4">
                  <div 
                    className="bg-warning h-4 rounded-full transition-all duration-500"
                    style={{ width: `${(locationStats.reserved / locationStats.total) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
