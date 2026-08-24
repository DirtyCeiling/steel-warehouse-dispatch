import { create } from 'zustand'
import type { Warehouse, Location, SteelCoil, Task } from '@/types'
import warehouseData from '@/data/warehouse.json'
import locationsData from '@/data/locations.json'
import coilsData from '@/data/coils.json'
import tasksData from '@/data/tasks.json'

interface WarehouseState {
  warehouse: Warehouse
  locations: Location[]
  coils: SteelCoil[]
  tasks: Task[]
  selectedLocation: Location | null
  selectedCoil: SteelCoil | null
  setSelectedLocation: (location: Location | null) => void
  setSelectedCoil: (coil: SteelCoil | null) => void
  getLocationStats: () => { total: number; occupied: number; empty: number; reserved: number }
  getCoilStats: () => { total: number; totalWeight: number; byMaterial: Record<string, number> }
  getTaskStats: () => { total: number; pending: number; executing: number; completed: number }
}

export const useWarehouseStore = create<WarehouseState>((set, get) => ({
  warehouse: warehouseData as Warehouse,
  locations: locationsData as Location[],
  coils: coilsData as SteelCoil[],
  tasks: tasksData as Task[],
  selectedLocation: null,
  selectedCoil: null,
  
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
