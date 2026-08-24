import { useWarehouseStore } from '@/store/warehouseStore'
import { Search, Filter, Package } from 'lucide-react'
import { useState } from 'react'

export function Inventory() {
  const { coils, setSelectedCoil } = useWarehouseStore()
  const [searchTerm, setSearchTerm] = useState('')
  const [filterMaterial, setFilterMaterial] = useState('all')
  
  const materials = [...new Set(coils.map(c => c.material))]
  
  const filteredCoils = coils.filter(coil => {
    const matchesSearch = coil.coilNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         coil.specification.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesMaterial = filterMaterial === 'all' || coil.material === filterMaterial
    return matchesSearch && matchesMaterial
  })
  
  return (
    <div className="h-full pt-16 ml-80 p-6 overflow-y-auto">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-display text-2xl font-bold text-white">
            库存管理
          </h1>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="搜索钢卷号或规格..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 pr-4 py-2 bg-secondary/30 border border-secondary/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-accent/50 w-64"
              />
            </div>
            <div className="relative">
              <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <select
                value={filterMaterial}
                onChange={(e) => setFilterMaterial(e.target.value)}
                className="pl-10 pr-8 py-2 bg-secondary/30 border border-secondary/50 rounded-lg text-white focus:outline-none focus:border-accent/50 appearance-none cursor-pointer"
              >
                <option value="all">全部材质</option>
                {materials.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCoils.map((coil) => (
            <div
              key={coil.id}
              onClick={() => setSelectedCoil(coil)}
              className="bg-secondary/30 rounded-xl p-4 border border-secondary/50 hover:border-accent/50 cursor-pointer transition-all duration-200 hover:shadow-lg hover:shadow-accent/10"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-accent/20 rounded-lg flex items-center justify-center">
                    <Package className="w-4 h-4 text-accent" />
                  </div>
                  <div>
                    <div className="font-mono text-sm text-white">{coil.coilNumber}</div>
                    <div className="text-xs text-gray-400">{coil.specification}</div>
                  </div>
                </div>
                <span className={`px-2 py-1 rounded text-xs ${
                  coil.status === 'in-stock' ? 'bg-success/20 text-success' :
                  coil.status === 'reserved' ? 'bg-warning/20 text-warning' :
                  'bg-error/20 text-error'
                }`}>
                  {coil.status === 'in-stock' ? '在库' :
                   coil.status === 'reserved' ? '预留' : '发货中'}
                </span>
              </div>
              
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <div className="text-xs text-gray-400">材质</div>
                  <div className="text-white">{coil.material}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400">重量</div>
                  <div className="text-white">{coil.weight} 吨</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400">直径</div>
                  <div className="text-white">{coil.diameter} mm</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400">库位</div>
                  <div className="text-white font-mono text-xs">{coil.locationId}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
        
        {filteredCoils.length === 0 && (
          <div className="text-center py-12">
            <Package className="w-16 h-16 text-gray-600 mx-auto mb-4" />
            <div className="text-gray-400">没有找到匹配的钢卷</div>
          </div>
        )}
      </div>
    </div>
  )
}
