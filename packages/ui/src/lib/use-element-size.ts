import { useEffect, useState, type RefObject } from "react";

/**
 * Tracks an element's border-box size. `active` re-observes when the element is
 * rendered conditionally (a ref object alone never changes identity, so an
 * element that mounts later would otherwise never be measured).
 */
export function useElementSize<T extends HTMLElement>(containerRef: RefObject<T | null>, active = true) {
  const [size, setSize] = useState({ height: 0, width: 0 });

  useEffect(() => {
    const container = active ? containerRef.current : null;
    if (!container) {
      return;
    }

    const updateSize = (width: number, height: number) => {
      const next = {
        height: Math.max(0, Math.floor(height)),
        width: Math.max(0, Math.floor(width))
      };
      setSize((current) => (current.height === next.height && current.width === next.width ? current : next));
    };

    const rect = container.getBoundingClientRect();
    updateSize(rect.width, rect.height);

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }
      updateSize(entry.contentRect.width, entry.contentRect.height);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [active, containerRef]);

  return size;
}
