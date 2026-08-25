import { create } from 'zustand'
import type { Warehouse, Location, SteelCoil, Task } from '@/types'
import { fetchAppData, postTask, putTaskStatus } from '@/api/warehouseApi'
// 数据库服务不可达时的降级数据源
import warehouseData from '@/data/warehouse.json'
import locationsData from '@/data/locations.json'
import coilsData from '@/data/coils.json'
import tasksData from '@/data/tasks.json'

/** 数据来源：db=本地数据库，json=内置降级数据 */
type DataSource = 'db' | 'json' | 'loading' | 'error'

const EMPTY_WAREHOUSE: Warehouse = { id: '', name: '', totalArea: 0, numberOfSpans: 0, spans: [] }

interface WarehouseState {
  warehouse: Warehouse
  locations: Location[]
  coils: SteelCoil[]
  tasks: Task[]
  dataSource: DataSource
  selectedLocation: Location | null
  selectedCoil: SteelCoil | null
  loadData: () => Promise<void>
  createTask: (task: Task) => Promise<boolean>
  updateTaskStatus: (id: string, status: Task['status']) => Promise<boolean>
  setSelectedLocation: (location: Location | null) => void
  setSelectedCoil: (coil: SteelCoil | null) => void
  getLocationStats: () => { total: number; occupied: number; empty: number; reserved: number }
  getCoilStats: () => { total: number; totalWeight: number; byMaterial: Record<string, number> }
  getTaskStats: () => { total: number; pending: number; executing: number; completed: number }
}

export const useWarehouseStore = create<WarehouseState>((set, get) => ({
  warehouse: EMPTY_WAREHOUSE,
  locations: [],
  coils: [],
  tasks: [],
  dataSource: 'loading',
  selectedLocation: null,
  selectedCoil: null,

  // 每次应用启动从本地数据库加载全量数据；失败时降级为内置 JSON
  loadData: async () => {
    set({ dataSource: 'loading' })
    try {
      const data = await fetchAppData()
      set({
        warehouse: data.warehouse,
        locations: data.locations,
        coils: data.coils,
        tasks: data.tasks,
        dataSource: 'db',
      })
    } catch (e) {
      console.warn('[数据库] 加载失败，使用内置 JSON 数据降级：', (e as Error).message)
      set({
        warehouse: warehouseData as Warehouse,
        locations: locationsData as Location[],
        coils: coilsData as SteelCoil[],
        tasks: tasksData as Task[],
        dataSource: 'json',
      })
    }
  },

  createTask: async (task) => {
    if (get().dataSource !== 'db') return false
    try {
      const created = await postTask(task)
      set(s => ({ tasks: [...s.tasks, created] }))
      return true
    } catch (e) {
      console.error('[数据库] 新建任务失败：', (e as Error).message)
      return false
    }
  },

  updateTaskStatus: async (id, status) => {
    if (get().dataSource !== 'db') return false
    try {
      const updated = await putTaskStatus(id, status)
      set(s => ({ tasks: s.tasks.map(t => (t.id === id ? updated : t)) }))
      return true
    } catch (e) {
      console.error('[数据库] 更新任务状态失败：', (e as Error).message)
      return false
    }
  },

  setSelectedLocation: (location) => set({ selectedLocation: location }),
  setSelectedCoil: (coil) => set({ selectedCoil: coil }),

  getLocationStats: () => {
    const { locations } = get()
    return {
      total: locations.length,
      occupied: locations.filter(l => l.status === 'occupied').length,
      empty: locations.filter(l => l.status === 'empty').length,
      reserved: locations.filter(l => l.status === 'reserved').length,
    }
  },

  getCoilStats: () => {
    const { coils } = get()
    const byMaterial: Record<string, number> = {}
    coils.forEach(coil => {
      byMaterial[coil.material] = (byMaterial[coil.material] || 0) + 1
    })
    return {
      total: coils.length,
      totalWeight: coils.reduce((sum, c) => sum + c.weight, 0),
      byMaterial,
    }
  },

  getTaskStats: () => {
    const { tasks } = get()
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      executing: tasks.filter(t => t.status === 'executing').length,
      completed: tasks.filter(t => t.status === 'completed').length,
    }
  },
}))
