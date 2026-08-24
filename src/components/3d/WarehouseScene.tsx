import { Canvas } from '@react-three/fiber'
import { OrbitControls, Text } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import { useWarehouseStore } from '@/store/warehouseStore'
import type { SteelCoil } from '@/types'
import { Span3D } from './Span'

interface WarehouseSceneProps {
  onCoilClick: (coil: SteelCoil) => void
}

export function WarehouseScene({ onCoilClick }: WarehouseSceneProps) {
  const { warehouse, locations, coils } = useWarehouseStore()
  
  return (
    <Canvas
      camera={{ position: [0, 20, 30], fov: 60 }}
      style={{ background: '#0a0f18' }}
    >
      <ambientLight intensity={0.4} />
      <directionalLight 
        position={[20, 30, 20]} 
        intensity={1}
        castShadow
      />
      <pointLight position={[-15, 15, 0]} intensity={0.5} color="#ff6b35" />
      <pointLight position={[15, 15, 0]} intensity={0.5} color="#4caf50" />
      
      <group position={[0, 0, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]}>
          <planeGeometry args={[100, 100]} />
          <meshStandardMaterial color="#0a0f18" metalness={0.1} roughness={0.9} />
        </mesh>
        
        {warehouse.spans.map((span) => {
          const offsetX = (span.position - 2) * 10
          return (
            <Span3D
              key={span.id}
              span={span}
              locations={locations}
              coils={coils}
              onCoilClick={onCoilClick}
              offsetX={offsetX}
            />
          )
        })}
        
        <Text
          position={[-10, 3, -12]}
          fontSize={1.2}
          color="#ff6b35"
        >
          {warehouse.spans[0]?.name}
        </Text>
        <Text
          position={[0, 3, -12]}
          fontSize={1.2}
          color="#4caf50"
        >
          {warehouse.spans[1]?.name}
        </Text>
        <Text
          position={[10, 3, -12]}
          fontSize={1.2}
          color="#2196f3"
        >
          {warehouse.spans[2]?.name}
        </Text>
      </group>
      
      <OrbitControls
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        minDistance={10}
        maxDistance={80}
        maxPolarAngle={Math.PI / 2.2}
      />
      
      <EffectComposer>
        <Bloom luminanceThreshold={0.5} luminanceSmoothing={0.9} height={300} intensity={0.5} />
      </EffectComposer>
    </Canvas>
  )
}
