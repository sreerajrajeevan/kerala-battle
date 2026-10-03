import { useRef, type PointerEvent } from 'react';

interface VirtualJoystickProps {
  /** Called with the normalized stick vector (-1..1 per axis), or (0,0) on release. */
  onMove: (x: number, y: number) => void;
}

/**
 * Touch/mouse virtual joystick. Extracted from the district lobby so Crown
 * Rush reuses the exact same control instead of a second copy.
 */
export default function VirtualJoystick({ onMove }: VirtualJoystickProps) {
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<{ active: boolean; id: number }>({ active: false, id: -1 });
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const updateJoystick = (event: PointerEvent<HTMLDivElement>) => {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const radius = rect.width / 2;
    let dx = (event.clientX - (rect.left + radius)) / radius;
    let dy = (event.clientY - (rect.top + radius)) / radius;
    const magnitude = Math.hypot(dx, dy);
    if (magnitude > 1) {
      dx /= magnitude;
      dy /= magnitude;
    }
    onMoveRef.current(dx, dy);
    if (knobRef.current) {
      knobRef.current.style.transform = `translate(${dx * radius * 0.55}px, ${dy * radius * 0.55}px)`;
    }
  };

  const handleDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = { active: true, id: event.pointerId };
    updateJoystick(event);
  };

  const handleMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointerRef.current.active || event.pointerId !== pointerRef.current.id) return;
    updateJoystick(event);
  };

  const handleEnd = () => {
    pointerRef.current = { active: false, id: -1 };
    onMoveRef.current(0, 0);
    if (knobRef.current) knobRef.current.style.transform = 'translate(0px, 0px)';
  };

  return (
    <div
      className="joystick"
      ref={baseRef}
      role="group"
      aria-label="Movement joystick"
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleEnd}
      onPointerCancel={handleEnd}
    >
      <div className="joystick-knob" ref={knobRef} />
    </div>
  );
}
