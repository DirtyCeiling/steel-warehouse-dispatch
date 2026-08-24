import { useState } from 'react'
import type { Location, SteelCoil } from '@/types'
import { SteelCoil3D } from './SteelCoil'

interface LocationProps {
  location: Location
  coil?: SteelCoil
  position: [number, number, number]
  onCoilClick: (coil: SteelCoil) => void
}

export function Location3D({ location, coil, position, onCoilClick }: LocationProps) {
  const [hovered, setHovered] = useState(false)
  
  const baseColor = location.status === 'occupied' ? '#2a3f5f' : 
                    location.status === 'reserved' ? '#3a2f1f' : '#1a2332'
  const hoverColor = hovered ? '#ff6b35' : baseColor
  
  return (
    <group position={position}>
      <mesh
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <boxGeometry args={[1.2, 0.1, 1.2]} />
        <meshStandardMaterial 
          color={hoverColor}
          metalness={0.5}
          roughness={0.5}
          emissive={hovered ? '#ff6b35' : '#000000'}
          emissiveIntensity={hovered ? 0.2 : 0}
        />
      </mesh>
      
      {coil && (
        <SteelCoil3D 
          coil={coil} 
          position={[0, 0.4, 0]} 
          onClick={onCoilClick}
        />
      )}
    </group>
  )
}
