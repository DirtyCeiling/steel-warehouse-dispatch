import { useWarehouseStore } from '@/store/warehouseStore'
import { X, Weight, Ruler } from 'lucide-react'

export function InfoPanel() {
  const { selectedLocation, selectedCoil, setSelectedLocation, setSelectedCoil } = useWarehouseStore()
  
  if (!selectedLocation && !selectedCoil) {
    return null
  }
  
  return (
    <div className="fixed right-0 top-16 bottom-0 w-96 bg-primary/95 backdrop-blur-sm border-l border-secondary/50 overflow-y-auto z-40">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-display text-lg font-semibold text-white">
            详细信息
          </h2>
          <button
            onClick={() => {
              setSelectedLocation(null)
              setSelectedCoil(null)
            }}
            className="p-2 rounded-lg hover:bg-secondary/50 transition-colors"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>
        
        {selectedCoil && (
          <div className="space-y-4">
            <div className="bg-secondary/30 rounded-xl p-4 border border-secondary/50">
              <h3 className="font-display text-sm font-semibold text-accent mb-3">
                钢卷信息
              </h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-gray-400 text-sm">钢卷号</span>
                  <span className="text-white font-mono">{selectedCoil.coilNumber}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400 text-sm">规格</span>
                  <span className="text-white">{selectedCoil.specification}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400 text-sm">材质</span>
                  <span className="text-white">{selectedCoil.material}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400 text-sm">状态</span>
                  <span className={`px-2 py-1 rounded text-xs ${
                    selectedCoil.status === 'in-stock' ? 'bg-success/20 text-success' :
                    selectedCoil.status === 'reserved' ? 'bg-warning/20 text-warning' :
                    'bg-error/20 text-error'
                  }`}>
                    {selectedCoil.status === 'in-stock' ? '在库' :
                     selectedCoil.status === 'reserved' ? '预留' : '发货中'}
                  </span>
                </div>
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-secondary/30 rounded-lg p-3 border border-secondary/50">
                <div className="flex items-center gap-2 mb-1">
                  <Weight className="w-4 h-4 text-accent" />
                  <span className="text-xs text-gray-400">重量</span>
                </div>
                <div className="text-lg font-bold text-white">{selectedCoil.weight} <span className="text-xs text-gray-400">吨</span></div>
              </div>
              <div className="bg-secondary/30 rounded-lg p-3 border border-secondary/50">
                <div className="flex items-center gap-2 mb-1">
                  <Ruler className="w-4 h-4 text-accent" />
                  <span className="text-xs text-gray-400">直径</span>
                </div>
                <div className="text-lg font-bold text-white">{selectedCoil.diameter} <span className="text-xs text-gray-400">mm</span></div>
              </div>
            </div>
          </div>
        )}
        
        {selectedLocation && !selectedCoil && (
          <div className="bg-secondary/30 rounded-xl p-4 border border-secondary/50">
            <h3 className="font-display text-sm font-semibold text-accent mb-3">
              库位信息
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-gray-400 text-sm">库位编号</span>
                <span className="text-white font-mono">{selectedLocation.id}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400 text-sm">位置</span>
                <span className="text-white">
                  第{selectedLocation.row}行 第{selectedLocation.column}列
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400 text-sm">状态</span>
                <span className={`px-2 py-1 rounded text-xs ${
                  selectedLocation.status === 'occupied' ? 'bg-success/20 text-success' :
                  selectedLocation.status === 'reserved' ? 'bg-warning/20 text-warning' :
                  'bg-secondary/50 text-gray-300'
                }`}>
                  {selectedLocation.status === 'occupied' ? '已占用' :
                   selectedLocation.status === 'reserved' ? '预留' : '空闲'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400 text-sm">容量</span>
                <span className="text-white">{selectedLocation.capacity} 吨</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
