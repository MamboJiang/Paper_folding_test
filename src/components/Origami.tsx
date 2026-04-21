import React, { useMemo, useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useSpring, a } from '@react-spring/three';
import { useDrag } from '@use-gesture/react';

const SIZE = 4;
const SEGMENTS = 96; 
const FOLD_GAP = 0.0001;

export type LineDef = {
  id: string;
  P0: THREE.Vector3; // Segment center
  D: THREE.Vector3;  // Direction
  N: THREE.Vector3;  // Normal
  length: number;    // Segment length for rendering
};

// Generates a line segment centered exactly bounded to the paper size
function createLine(id: string, x0: number, y0: number, x1: number, y1: number): LineDef {
  const p0 = new THREE.Vector3(x0, y0, 0);
  const p1 = new THREE.Vector3(x1, y1, 0);
  const center = new THREE.Vector3((x0+x1)/2, (y0+y1)/2, 0);
  const D = p1.clone().sub(p0).normalize();
  const N = new THREE.Vector3(-D.y, D.x, 0); // 90 degrees CCW
  return { id, P0: center, D, N, length: p0.distanceTo(p1) };
}

const ALL_LINES: LineDef[] = [];
const GRID_CELLS = 8;
const GRID_STEP = SIZE / GRID_CELLS;
const HALF = SIZE / 2;

// Horizontal & Vertical lines
for (let i = 1; i < GRID_CELLS; i++) {
  const val = -HALF + i * GRID_STEP;
  ALL_LINES.push(createLine(`h_${val}`, -HALF, val, HALF, val));
  ALL_LINES.push(createLine(`v_${val}`, val, -HALF, val, HALF));
}

// Generate diagonals smartly
const DIAG_MIN = -SIZE + GRID_STEP;
const DIAG_MAX = SIZE - GRID_STEP;

for (let k = DIAG_MIN; k <= DIAG_MAX + 0.001; k += GRID_STEP) {
  // y = x + k
  const pts = [];
  let y = -HALF + k; if (y >= -HALF && y <= HALF) pts.push([-HALF, y]);
  y = HALF + k; if (y >= -HALF && y <= HALF) pts.push([HALF, y]);
  let x = -HALF - k; if (x > -HALF && x < HALF) pts.push([x, -HALF]); 
  x = HALF - k; if (x > -HALF && x < HALF) pts.push([x, HALF]);
  if (pts.length >= 2) ALL_LINES.push(createLine(`d1_${k}`, pts[0][0], pts[0][1], pts[1][0], pts[1][1]));

  // y = -x + k
  const pts2 = [];
  y = HALF + k; if (y >= -HALF && y <= HALF) pts2.push([-HALF, y]);
  y = -HALF + k; if (y >= -HALF && y <= HALF) pts2.push([HALF, y]);
  x = k + HALF; if (x > -HALF && x < HALF) pts2.push([x, -HALF]); 
  x = k - HALF; if (x > -HALF && x < HALF) pts2.push([x, HALF]);
  if (pts2.length >= 2) ALL_LINES.push(createLine(`d2_${k}`, pts2[0][0], pts2[0][1], pts2[1][0], pts2[1][1]));
}

export interface OrigamiHandle {
  cancelLine: () => void;
  undo: () => void;
  redo: () => void;
}

export const Origami = forwardRef<OrigamiHandle, { 
  setControlsEnabled: (enabled: boolean) => void,
  onStateUpdate: (state: { hasActiveLine: boolean, canUndo: boolean, canRedo: boolean }) => void
}>(({ setControlsEnabled, onStateUpdate }, ref) => {
  const { camera, raycaster, mouse, size, gl } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const startPointerRef = useRef<THREE.Vector2>(new THREE.Vector2());
  
  const [previewLine, setPreviewLine] = useState<LineDef | null>(null);
  const [activeLine, setActiveLine] = useState<LineDef | null>(null);

  const undoStack = useRef<Float32Array[]>([]);
  const redoStack = useRef<Float32Array[]>([]);

  const baseGeometry = useMemo(() => {
    // A box is perfect to simulate true physical paper thickness.
    // Z is mapped backwards so the front face matches exactly z=0 originally.
    const geo = new THREE.BoxGeometry(SIZE, SIZE, 0.014, SEGMENTS, SEGMENTS, 1);
    geo.translate(0, 0, -0.007); 
    geo.computeVertexNormals();
    return geo;
  }, []);

  const updateState = () => {
    onStateUpdate({
      hasActiveLine: !!activeLine,
      canUndo: undoStack.current.length > 0,
      canRedo: redoStack.current.length > 0
    });
  };

  useEffect(() => {
    updateState();
  }, [activeLine]);

  useImperativeHandle(ref, () => ({
    cancelLine: () => {
      setActiveLine(null);
      setPreviewLine(null);
      updateState();
    },
    undo: () => {
      if (undoStack.current.length === 0 || !baseGeometry) return;
      redoStack.current.push(new Float32Array(baseGeometry.attributes.position.array));
      const previous = undoStack.current.pop()!;
      baseGeometry.attributes.position.array.set(previous);
      baseGeometry.attributes.position.needsUpdate = true;
      baseGeometry.computeVertexNormals();
      if (originalPositions.current) originalPositions.current.set(previous);
      foldCount.current = Math.max(0, foldCount.current - 1);
      updateState();
    },
    redo: () => {
      if (redoStack.current.length === 0 || !baseGeometry) return;
      undoStack.current.push(new Float32Array(baseGeometry.attributes.position.array));
      const next = redoStack.current.pop()!;
      baseGeometry.attributes.position.array.set(next);
      baseGeometry.attributes.position.needsUpdate = true;
      baseGeometry.computeVertexNormals();
      if (originalPositions.current) originalPositions.current.set(next);
      foldCount.current += 1;
      updateState();
    }
  }));

  const saveHistory = () => {
    if (!baseGeometry) return;
    undoStack.current.push(new Float32Array(baseGeometry.attributes.position.array));
    redoStack.current = [];
    updateState();
  };

  const originalPositions = useRef<Float32Array | null>(null);
  const currentFoldRef = useRef<any>(null);
  const foldPhase = useRef<'idle' | 'dragging' | 'releasing' | 'canceling'>('idle');
  const currentProgress = useRef(0);
  const targetProgress = useRef(0);
  const foldCount = useRef(0);

  useEffect(() => {
    if (baseGeometry && !originalPositions.current) {
      originalPositions.current = new Float32Array(baseGeometry.attributes.position.array);
    }
  }, [baseGeometry]);

  const finishFold = (explicitTarget?: number) => {
    foldPhase.current = 'idle';
    currentProgress.current = 0;
    targetProgress.current = 0;

    // Force exact perfect fold mathematical calculation!
    if (baseGeometry && originalPositions.current && currentFoldRef.current) {
      const { P, D, N, condition } = currentFoldRef.current;
      const posAttribute = baseGeometry.attributes.position;
      const arr = posAttribute.array as Float32Array;
      const origArr = originalPositions.current;

      const pVal = explicitTarget !== undefined ? explicitTarget : targetProgress.current;
      const { hingeZMax, signRef, zShiftUp, zShiftDown } = currentFoldRef.current;
      
      const direction = pVal < 0 ? -1 : 1; 
      // angle incorporates signRef so BOTH sides swing outwards (+Z) reliably symmetrically
      const angle = pVal * Math.PI * signRef; 
      const currentZShift = Math.abs(pVal) * (direction > 0 ? zShiftUp : zShiftDown);

      const V = new THREE.Vector3();

      for (let i = 0; i < posAttribute.count; i++) {
        const vX = origArr[i * 3];
        const vY = origArr[i * 3 + 1];
        const vZ = origArr[i * 3 + 2];
        
        const dx = vX - P.x;
        const dy = vY - P.y;
        const dz = vZ - P.z;
        const dist = dx * N.x + dy * N.y + dz * N.z;
        
        if (condition(dist)) {
          V.set(dx, dy, dz);
          V.applyAxisAngle(D, angle);
          V.add(P);

          V.z += currentZShift;
          V.toArray(arr, i * 3);
        } else {
          arr[i * 3] = vX;
          arr[i * 3 + 1] = vY;
          arr[i * 3 + 2] = vZ;
        }
      }
      
      posAttribute.needsUpdate = true;
      baseGeometry.computeVertexNormals();
      
      // Save pristine state as the new baseline array
      originalPositions.current.set(arr);
    }

    foldCount.current += 1;
    currentFoldRef.current = null;
    setActiveLine(null);
    setPreviewLine(null);
    updateState();
  };

  const cancelFold = () => {
    foldPhase.current = 'idle';
    currentProgress.current = 0;
    targetProgress.current = 0;
    currentFoldRef.current = null;
    undoStack.current.pop();
    updateState();
    
    // Perfectly revert position attribute array
    if (baseGeometry && originalPositions.current) {
      baseGeometry.attributes.position.array.set(originalPositions.current);
      baseGeometry.attributes.position.needsUpdate = true;
      baseGeometry.computeVertexNormals();
    }
  };

  // Helper to reliably project pointer to the origami local coordinate space
  const getLocalXY = (xy: [number, number]) => {
    const rect = gl.domElement.getBoundingClientRect();
    const x = ((xy[0] - rect.left) / rect.width) * 2 - 1;
    const y = -((xy[1] - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
    const targetPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const intersect = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(targetPlane, intersect)) {
      return new THREE.Vector2(intersect.x, -intersect.z);
    }
    return new THREE.Vector2(0, 0);
  };

  const bind = useDrag(({ movement: [mx, my], velocity: [vx, vy], first, last, active, tap, event, xy }) => {
    event.stopPropagation();
    
    // 1. Line Selection Mode
    if (!activeLine) {
      if (first) {
        setControlsEnabled(false);
        foldPhase.current = 'idle';
      }
      
      const currV = getLocalXY(xy);
      
      let bestLine: LineDef | null = null;
      let minDist = Infinity;
      for (const line of ALL_LINES) {
        const mouseV3 = new THREE.Vector3(currV.x, currV.y, 0);
        const d = Math.abs(mouseV3.clone().sub(line.P0).dot(line.N));
        if (d < minDist) {
          minDist = d;
          bestLine = line;
        }
      }
      if (minDist > 1.5) bestLine = null;
      
      if (active && !tap) {
        setPreviewLine(bestLine);
      }
      
      if (last) {
        setControlsEnabled(true);
        if (tap && bestLine) {
          setActiveLine(bestLine);
          setPreviewLine(null);
          updateState();
        } else if (!tap && previewLine) {
          setActiveLine(previewLine);
          setPreviewLine(null);
          updateState();
        } else {
          setPreviewLine(null);
        }
      }
      return;
    }

    // 2. Fold Execution Mode
    if (first) {
      setControlsEnabled(false);
      saveHistory(); 
      
      foldPhase.current = 'dragging';
      currentProgress.current = 0;
      targetProgress.current = 0;
      
      const currV = getLocalXY(xy);
      startPointerRef.current = currV;
      
      const mouseV = new THREE.Vector3(currV.x, currV.y, 0);
      const startSideDist = mouseV.clone().sub(activeLine.P0).dot(activeLine.N);
      const condition = (dist: number) => startSideDist > 0 ? dist > 0 : dist < 0;

      const posAttribute = baseGeometry.attributes.position;
      const origArr = originalPositions.current!;
      let hingeZMax = 0;

      // 1. Build a high-resolution bucket grid for the STATIC side
      const CELL_SIZE = 0.1;
      const staticGrid = new Map<string, Array<{x: number, y: number, z: number}>>();
      
      for (let i = 0; i < posAttribute.count; i++) {
        const vX = origArr[i * 3];
        const vY = origArr[i * 3 + 1];
        const vZ = origArr[i * 3 + 2];
        const dx = vX - activeLine.P0.x;
        const dy = vY - activeLine.P0.y;
        const dz = vZ - activeLine.P0.z;
        const dist = dx * activeLine.N.x + dy * activeLine.N.y + dz * activeLine.N.z;
        
        if (Math.abs(dist) < 0.05) {
          if (vZ > hingeZMax) hingeZMax = vZ;
        }

        if (!condition(dist)) {
           const gx = Math.floor(vX / CELL_SIZE);
           const gy = Math.floor(vY / CELL_SIZE);
           const key = `${gx},${gy}`;
           if (!staticGrid.has(key)) staticGrid.set(key, []);
           staticGrid.get(key)!.push({x: vX, y: vY, z: vZ});
        }
      }

      // 2. Compute minimum exact zShift needed so moving points land perfectly
      let shiftUp = FOLD_GAP;
      let shiftDown = -FOLD_GAP;
      
      for (let i = 0; i < posAttribute.count; i++) {
        const vX = origArr[i * 3];
        const vY = origArr[i * 3 + 1];
        const vZ = origArr[i * 3 + 2];
        const dx = vX - activeLine.P0.x;
        const dy = vY - activeLine.P0.y;
        const dz = vZ - activeLine.P0.z;
        const dist = dx * activeLine.N.x + dy * activeLine.N.y + dz * activeLine.N.z;
        
        if (condition(dist)) {
           const rx = vX - 2 * dist * activeLine.N.x;
           const ry = vY - 2 * dist * activeLine.N.y;
           
           // Shift query inward to avoid recognizing adjacent touching edges (seams) as overlaps
           const inwardShift = Math.min(0.04, Math.abs(dist) * 0.5);
           const rqX = rx + inwardShift * Math.sign(dist) * activeLine.N.x;
           const rqY = ry + inwardShift * Math.sign(dist) * activeLine.N.y;

           const gx = Math.floor(rqX / CELL_SIZE);
           const gy = Math.floor(rqY / CELL_SIZE);
           
           let bestStaticZMax = -Infinity;
           let bestStaticZMin = Infinity;
           
           // Query neighboring buckets and do EXACT distance checks
           for(let ox=-1; ox<=1; ox++) {
             for(let oy=-1; oy<=1; oy++) {
               const bucket = staticGrid.get(`${gx+ox},${gy+oy}`);
               if (bucket) {
                 for (let j = 0; j < bucket.length; j++) {
                   const p = bucket[j];
                   const dSq = (p.x - rqX) ** 2 + (p.y - rqY) ** 2;
                   if (dSq < 0.0012) { // Radius ~0.034, carefully misses seam boundaries!
                     if (p.z > bestStaticZMax) bestStaticZMax = p.z;
                     if (p.z < bestStaticZMin) bestStaticZMin = p.z;
                   }
                 }
               }
             }
           }
           
           if (bestStaticZMax === -Infinity) bestStaticZMax = 0;
           if (bestStaticZMin === Infinity) bestStaticZMin = 0;
           
           const reqUp = bestStaticZMax + vZ - 2 * hingeZMax + FOLD_GAP;
           if (reqUp > shiftUp) shiftUp = reqUp;

           const reqDown = bestStaticZMin + vZ - 2 * hingeZMax - FOLD_GAP;
           if (reqDown < shiftDown) shiftDown = reqDown;
        }
      }

      const adjustedP0 = new THREE.Vector3(activeLine.P0.x, activeLine.P0.y, hingeZMax);

      currentFoldRef.current = { 
        P: adjustedP0, 
        D: activeLine.D, 
        N: activeLine.N, 
        condition, 
        signRef: startSideDist > 0 ? 1 : -1,
        startSideDist,
        hingeZMax,
        zShiftUp: shiftUp,
        zShiftDown: shiftDown
      };
    }

    if (active && currentFoldRef.current && foldPhase.current === 'dragging') {
      const currV = getLocalXY(xy);
      const delta = currV.clone().sub(startPointerRef.current);
      const N2D = new THREE.Vector2(currentFoldRef.current.N.x, currentFoldRef.current.N.y);
      const projectedDelta = delta.dot(N2D);
      
      const inwardValue = -(projectedDelta * currentFoldRef.current.signRef);
      
      const grabDistance = Math.max(Math.abs(currentFoldRef.current.startSideDist || 1.5), 0.5);
      const progressMagnitude = Math.min(Math.max(Math.abs(inwardValue / (grabDistance * 2)), 0), 1);
      const sign = inwardValue > 0 ? 1 : -1;
      
      targetProgress.current = progressMagnitude * sign;
      currentProgress.current = targetProgress.current;
    }

    if (last) {
      setControlsEnabled(true);
      if (foldPhase.current === 'dragging') {
        const p = currentProgress.current; 
        
        // Use a forgiving threshold so finger lifts don't accidentally cancel the fold
        if (Math.abs(p) >= 0.25) {
          targetProgress.current = p > 0 ? 1 : -1;
          foldPhase.current = 'releasing';
        } else {
          targetProgress.current = 0;
          foldPhase.current = 'canceling';
        }
      }
    }
  }, { 
    pointerEvents: true,
    threshold: 5
  });

  useFrame(() => {
    if (!currentFoldRef.current || !baseGeometry || !originalPositions.current) return;
    
    // Manual predictable physics
    if (foldPhase.current === 'releasing' || foldPhase.current === 'canceling') {
      // Lerp precisely, no unexpected forces or timeline confusion
      currentProgress.current += (targetProgress.current - currentProgress.current) * 0.15;
      
      if (Math.abs(currentProgress.current - targetProgress.current) < 0.005) {
        currentProgress.current = targetProgress.current; // exact snap
        if (foldPhase.current === 'releasing') {
          finishFold(targetProgress.current);
          return;
        } else {
          cancelFold();
          return;
        }
      }
    }
    
    // Send progress to UI
    const pVal = currentProgress.current;
    const el = document.getElementById('fold-angle-display');
    if (el) {
      const degrees = Math.round(Math.abs(pVal) * 180);
      el.innerText = `${degrees}°`;
    }

    const { P, D, N, condition, signRef, hingeZMax, zShiftUp, zShiftDown } = currentFoldRef.current;
    const posAttribute = baseGeometry.attributes.position;
    const arr = posAttribute.array as Float32Array;
    const origArr = originalPositions.current;
    
    // signRef ensures rotation properly sweeps through +Z space for both sides
    const angle = pVal * Math.PI * signRef; 
    const falloff = Math.sin(Math.abs(pVal) * Math.PI);

    const direction = pVal < 0 ? -1 : 1;
    // axis is elevated to hingeZMax, adjust shift math properly
    const currentZShift = Math.abs(pVal) * (direction > 0 ? zShiftUp : zShiftDown);

    const V = new THREE.Vector3();

    for (let i = 0; i < posAttribute.count; i++) {
      const vX = origArr[i * 3];
      const vY = origArr[i * 3 + 1];
      const vZ = origArr[i * 3 + 2];
      
      const dx = vX - P.x;
      const dy = vY - P.y;
      const dz = vZ - P.z;
      const dist = dx * N.x + dy * N.y + dz * N.z;
      
      if (condition(dist)) {
        V.set(dx, dy, dz);
        V.applyAxisAngle(D, angle);
        V.add(P);
        
        const curl = direction * Math.abs(dist) * falloff * 0.03;

        V.z += currentZShift + curl;
        V.toArray(arr, i * 3);
      } else {
        arr[i * 3] = vX;
        arr[i * 3 + 1] = vY;
        arr[i * 3 + 2] = vZ;
      }
    }
    
    posAttribute.needsUpdate = true;
    baseGeometry.computeVertexNormals();
  });

  const materials = useMemo(() => {
    // Generate custom origami pattern texture using a 1024x1024 Canvas
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d')!;
    
    // Original Paper Color (Kraft tan/orange), White, and Black
    const BASE_COLOR = '#E0A96D';
    const WHITE = '#FFFFFF';
    const BLACK = '#222222';
    
    // Fill the top half (Y: 0 to 512) with White background
    ctx.fillStyle = WHITE;
    ctx.fillRect(0, 0, 1024, 512);
    
    // Draw left-top 4x4 region diamond (Base color)
    ctx.fillStyle = BASE_COLOR;
    ctx.beginPath();
    ctx.moveTo(256, 0);       // top
    ctx.lineTo(512, 256);     // right
    ctx.lineTo(256, 512);     // bottom
    ctx.lineTo(0, 256);       // left
    ctx.closePath();
    ctx.fill();

    // Draw right-top 4x4 region diamond (Base color)
    ctx.beginPath();
    ctx.moveTo(768, 0);       // top
    ctx.lineTo(1024, 256);    // right
    ctx.lineTo(768, 512);     // bottom
    ctx.lineTo(512, 256);     // left
    ctx.closePath();
    ctx.fill();

    // Fill the lower half left 4x2 region (Base color)
    ctx.fillStyle = BASE_COLOR;
    ctx.fillRect(0, 512, 256, 512);

    // Fill the lower half center 4x4 region (Black)
    ctx.fillStyle = BLACK;
    ctx.fillRect(256, 512, 512, 512);

    // Fill the lower half right 4x2 region (Base color)
    ctx.fillStyle = BASE_COLOR;
    ctx.fillRect(768, 512, 256, 512);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4; // Keeps diagonal lines sharp

    const frontMat = new THREE.MeshStandardMaterial({
      roughness: 0.8,
      metalness: 0,
      map: texture,
      side: THREE.FrontSide,
      dithering: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });

    const sideMat = new THREE.MeshStandardMaterial({
      roughness: 0.9,
      metalness: 0,
      color: "#FFF8DC",
      side: THREE.FrontSide,
    });

    // Make the back of the paper clean white like real origami paper
    const backMat = new THREE.MeshStandardMaterial({
      roughness: 0.9,
      metalness: 0,
      color: "#F4F4F4",
      side: THREE.FrontSide,
      dithering: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });

    return [
      sideMat,  // right facing (0)
      sideMat,  // left facing (1)
      sideMat,  // top facing (2)
      sideMat,  // bottom facing (3)
      frontMat, // front map facing +Z (4)
      backMat   // back facing -Z (5)
    ];
  }, []);

  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      {/* Fold Guides Overlay */}
      <group>
        {ALL_LINES.map((line, i) => {
          const isPreview = previewLine && previewLine.id === line.id;
          const isActive = activeLine && activeLine.id === line.id;
          
          let color = '#000000';
          let opacity = 0.04;
          
          if (isActive) {
            color = '#FF4500'; // Deep orange for active
            opacity = 0.4;
          } else if (isPreview) {
            color = '#1E90FF'; // Blue for preview
            opacity = 0.3;
          }

          // Use line.D to calculate rendering rotation
          const rotZ = Math.atan2(line.D.y, line.D.x);

          return (
            <mesh key={`l-${i}`} position={[line.P0.x, line.P0.y, 0.003]} rotation={[0, 0, rotZ]}>
              <planeGeometry args={[line.length, 0.04]} />
              <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
            </mesh>
          );
        })}
      </group>

      <group {...bind() as any} ref={groupRef as any}>
        <mesh castShadow receiveShadow geometry={baseGeometry} material={materials}>
        </mesh>
      </group>
    </group>
  );
});
