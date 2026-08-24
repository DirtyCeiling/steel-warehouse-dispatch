import { useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Mesh } from 'three'
import type { SteelCoil } from '@/types'

interface SteelCoilProps {
  coil: SteelCoil
  position: [number, number, number]
  onClick: (coil: SteelCoil) => void
}

export function SteelCoil3D({ coil, position, onClick }: SteelCoilProps) {
  const meshRef = useRef<Mesh>(null)
  const [hovered, setHovered] = useState(false)
  
  const color = coil.status === 'in-stock' ? '#4caf50' : 
                coil.status === 'reserved' ? '#ff9800' : '#f44336'
  
  useFrame((_state, delta) => {
    if (meshRef.current && hovered) {
      meshRef.current.rotation.y += delta * 0.5
    }
  })
  
  return (
    <mesh
      ref={meshRef}
      position={position}
      onClick={(e) => {
        e.stopPropagation()
        onClick(coil)
      }}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      <cylinderGeometry args={[0.4, 0.4, 0.6, 32]} />
      <meshStandardMaterial 
        color={hovered ? '#ff6b35' : color}
        metalness={0.7}
        roughness={0.3}
        emissive={hovered ? '#ff6b35' : '#000000'}
        emissiveIntensity={hovered ? 0.3 : 0}
      />
    </mesh>
  )
}
