import { Canvas } from '@react-three/fiber'
import { Bounds, OrbitControls, PerspectiveCamera } from '@react-three/drei'
import type { ContainerSpec, Placement } from '../types'

interface Container3DProps {
  container: ContainerSpec
  placements: Placement[]
  view: 'front' | 'top'
}

const palette = ['#2dd4bf', '#a78bfa', '#fbbf24', '#60a5fa', '#f472b6', '#34d399']

function getColor(item: Placement, index: number): string {
  if (item.group === 'fragile') {
    return '#f87171'
  }
  if (item.weight > 150) {
    return '#f59e0b'
  }
  return palette[index % palette.length]
}

export function Container3D({ container, placements, view }: Container3DProps) {
  const scale = 0.001
  const containerWidth = container.length * scale
  const containerHeight = container.height * scale
  const containerDepth = container.width * scale

  return (
    <Canvas>
      <PerspectiveCamera
        makeDefault
        position={view === 'top'
          ? [0, containerHeight * 4 + 1, 0.01]
          : [1, containerHeight * 1.2 + 1, containerDepth * 3 + 1]}
        fov={42}
      />
      <ambientLight intensity={0.9} />
      <directionalLight position={[5, 8, 5]} intensity={1.2} />
      <Bounds key={view} fit clip observe margin={1.2}>
        <group position={[-containerWidth / 2, -containerHeight / 2, -containerDepth / 2]}>
          <mesh position={[containerWidth / 2, containerHeight / 2, containerDepth / 2]}>
            <boxGeometry args={[containerWidth, containerHeight, containerDepth]} />
            <meshStandardMaterial color="#0f172a" wireframe transparent opacity={0.5} />
          </mesh>

          {placements.map((placement, index) => (
            <mesh
              key={placement.id}
              position={[
                (placement.x + placement.length / 2) * scale,
                (placement.z + placement.height / 2) * scale,
                (placement.y + placement.width / 2) * scale,
              ]}
            >
              <boxGeometry args={[placement.length * scale, placement.height * scale, placement.width * scale]} />
              <meshStandardMaterial color={getColor(placement, index)} transparent opacity={0.9} />
            </mesh>
          ))}
        </group>
        <OrbitControls makeDefault enablePan enableZoom enableRotate />
      </Bounds>
    </Canvas>
  )
}
