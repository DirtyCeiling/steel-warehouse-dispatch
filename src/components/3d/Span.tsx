import type { Span, Location, SteelCoil } from '@/types'
import { Location3D } from './Location'

interface SpanProps {
  span: Span
  locations: Location[]
  coils: SteelCoil[]
  onCoilClick: (coil: SteelCoil) => void
  offsetX: number
}

export function Span3D({ span, locations, coils, onCoilClick, offsetX }: SpanProps) {
  const spanLocations = locations.filter(l => l.spanId === span.id)
  
  return (
    <group position={[offsetX, 0, 0]}>
      <mesh position={[0, -0.05, 0]}>
        <boxGeometry args={[8, 0.1, 20]} />
        <meshStandardMaterial 
          color="#1a2332"
          metalness={0.3}
          roughness={0.8}
        />
      </mesh>
      
      {spanLocations.map((location) => {
        const coil = coils.find(c => c.id === location.steelCoilId)
        const row = location.row - 1
        const col = location.column - 1
        
        const x = (col - 2) * 1.5
        const z = (row - 0.5) * 2
        
        return (
          <Location3D
            key={location.id}
            location={location}
            coil={coil}
            position={[x, 0, z]}
            onCoilClick={onCoilClick}
          />
        )
      })}
    </group>
  )
}
