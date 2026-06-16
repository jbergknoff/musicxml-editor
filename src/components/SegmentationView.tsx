import { useEffect, useRef, useState } from "preact/hooks";
import {
  type Color,
  compositeMasks,
  type OverlayLayer,
} from "../../lib/segmentation/overlay";
import type { Mask, RgbaImage, SegmentationMasks } from "../../lib/types";

/**
 * Draws the segmentation result: the page with the detected masks overlaid in
 * color, plus a checkbox per layer to toggle each on and off. This is the
 * Phase 1 visual acceptance — proof the UNets ran and located the music.
 */

interface LayerConfig {
  key: keyof SegmentationMasks;
  label: string;
  color: Color;
}

// Distinct hues so overlapping detections stay legible.
const LAYERS: LayerConfig[] = [
  { key: "staff", label: "Stafflines", color: [37, 99, 235] },
  { key: "noteheads", label: "Noteheads", color: [220, 38, 38] },
  { key: "stemsRests", label: "Stems / rests", color: [22, 163, 74] },
  { key: "clefsKeys", label: "Clefs / keys", color: [217, 119, 6] },
  { key: "symbols", label: "All symbols", color: [147, 51, 234] },
];

interface SegmentationViewProps {
  image: RgbaImage;
  masks: SegmentationMasks;
}

export function SegmentationView({ image, masks }: SegmentationViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    staff: true,
    noteheads: true,
    stemsRests: false,
    clefsKeys: false,
    symbols: false,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }
    const layers: OverlayLayer[] = LAYERS.filter(
      (layer) => enabled[layer.key],
    ).map((layer) => ({
      mask: masks[layer.key] as Mask,
      color: layer.color,
    }));
    const composited = compositeMasks(image, layers);
    canvas.width = composited.width;
    canvas.height = composited.height;
    const imageData = context.createImageData(
      composited.width,
      composited.height,
    );
    imageData.data.set(composited.data);
    context.putImageData(imageData, 0, 0);
  }, [image, masks, enabled]);

  return (
    <div class="segmentation-view">
      <div class="segmentation-view__legend">
        {LAYERS.map((layer) => (
          <label key={layer.key} class="segmentation-view__toggle">
            <input
              type="checkbox"
              checked={enabled[layer.key]}
              onChange={(event) => {
                const checked = (event.currentTarget as HTMLInputElement)
                  .checked;
                setEnabled((current) => ({ ...current, [layer.key]: checked }));
              }}
            />
            <span
              class="segmentation-view__swatch"
              style={`background:rgb(${layer.color.join(",")})`}
            />
            {layer.label}
          </label>
        ))}
      </div>
      <canvas ref={canvasRef} class="segmentation-view__canvas" />
    </div>
  );
}
