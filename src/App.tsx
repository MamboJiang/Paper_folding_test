/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Canvas } from '@react-three/fiber';
import { OrthographicCamera, OrbitControls } from '@react-three/drei';
import { Origami, OrigamiHandle } from './components/Origami';
import { useState, useRef } from 'react';
import { RotateCcw, RotateCw, X } from 'lucide-react';

export default function App() {
  const [controlsEnabled, setControlsEnabled] = useState(true);
  const [origamiState, setOrigamiState] = useState({ hasActiveLine: false, canUndo: false, canRedo: false });
  const origamiRef = useRef<OrigamiHandle>(null);

  return (
    <div className="w-full h-screen bg-[#E6E6FA] overflow-hidden select-none touch-none relative">
      <Canvas shadows>
        <OrthographicCamera 
          makeDefault 
          position={[10, 10, 10]} 
          zoom={80} 
          near={-100} 
          far={100} 
        />
        <OrbitControls 
          enableDamping 
          dampingFactor={0.05} 
          enablePan={false}
          enableZoom={true}
          enabled={controlsEnabled}
        />
        
        <ambientLight intensity={0.4} />
        <directionalLight 
          position={[10, 20, 10]} 
          intensity={1.0} 
          color="#FFF5E6" 
          castShadow 
          shadow-bias={-0.0001}
          shadow-mapSize={[1024, 1024]}
          shadow-camera-left={-10}
          shadow-camera-right={10}
          shadow-camera-top={10}
          shadow-camera-bottom={-10}
        />
        
        <Origami 
          ref={origamiRef}
          setControlsEnabled={setControlsEnabled} 
          onStateUpdate={setOrigamiState}
        />

        {/* Floor to catch shadows softly */}
        <mesh position={[0, -2, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[50, 50]} />
          <shadowMaterial opacity={0.3} />
        </mesh>
      </Canvas>

      {/* UI Overlay */}
      <div className="absolute top-12 left-0 right-0 pointer-events-none flex flex-col items-center gap-4 z-10 px-4">
        
        {/* Real-time Angle Display */}
        {origamiState.hasActiveLine && (
          <div className="flex flex-col items-center pointer-events-none transition-opacity duration-300">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1 drop-shadow-sm">Fold Angle</span>
            <div id="fold-angle-display" className="text-4xl font-mono text-gray-800 font-medium tracking-tighter bg-white/40 px-6 py-2 rounded-2xl backdrop-blur-md shadow-[0_4px_20px_rgba(0,0,0,0.05)] border border-white/60">
              0°
            </div>
          </div>
        )}

        {/* Undo/Redo Buttons */}
        <div className="flex gap-4 pointer-events-auto">
          {origamiState.canUndo && (
            <button 
              onClick={() => origamiRef.current?.undo()} 
              className="bg-white/80 hover:bg-white text-gray-700 p-3 rounded-full shadow-lg transition-all backdrop-blur-md"
              aria-label="Undo"
            >
              <RotateCcw size={20} />
            </button>
          )}
          
          {origamiState.canRedo && (
            <button 
              onClick={() => origamiRef.current?.redo()} 
              className="bg-white/80 hover:bg-white text-gray-700 p-3 rounded-full shadow-lg transition-all backdrop-blur-md"
              aria-label="Redo"
            >
              <RotateCw size={20} />
            </button>
          )}
        </div>
      </div>

      <div className="absolute bottom-12 left-0 right-0 pointer-events-none flex flex-col items-center gap-6 z-10">
        
        {/* Cancel Button */}
        <div className="flex pointer-events-auto min-h-[48px]">
          {origamiState.hasActiveLine && (
            <button 
              onClick={() => origamiRef.current?.cancelLine()} 
              className="bg-red-500 hover:bg-red-600 text-white p-3 rounded-full shadow-lg transition-all flex items-center justify-center gap-2 px-6"
            >
              <X size={20} />
              <span className="font-medium text-sm">Cancel Line</span>
            </button>
          )}
        </div>

        {/* Dynamic Instructions */}
        <p className="text-gray-600 font-sans tracking-wide text-sm bg-white/40 px-5 py-2.5 rounded-full backdrop-blur-md shadow-[0_2px_10px_rgba(0,0,0,0.05)] border border-white/50 text-center mx-4">
          {origamiState.hasActiveLine 
            ? "Drag paper across the orange line to fold" 
            : "Draw a line to select a fold • Drag background to rotate"}
        </p>
      </div>
    </div>
  );
}
