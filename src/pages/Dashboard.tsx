import { WarehouseScene } from '@/components/3d/WarehouseScene'
import { useWarehouseStore } from '@/store/warehouseStore'
import type { SteelCoil } from '@/types'

export function Dashboard() {
  const setSelectedCoil = useWarehouseStore(state => state.setSelectedCoil)
  const setSelectedLocation = useWarehouseStore(state => state.setSelectedLocation)
  const locations = useWarehouseStore(state => state.locations)
  
  const handleCoilClick = (coil: SteelCoil) => {
    setSelectedCoil(coil)
    const location = locations.find(l => l.id === coil.locationId)
    if (location) {
      setSelectedLocation(location)
    }
  }
  
  return (
    <div className="h-full pt-16">
      <div className="h-full ml-80">
        <WarehouseScene onCoilClick={handleCoilClick} />
      </div>
    </div>
  )
}
