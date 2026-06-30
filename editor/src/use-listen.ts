// "Listen" playback: a small WebAudio synth that walks the score beat by beat
// at a fixed tempo, sounding each beat's pitches. It owns no UI — it exposes
// `getLiveBeat`/`playing` to drive the renderer's existing on-score cursor +
// scroll-follow (SheetMusicDisplay's `getLiveBeat`/`isPlaying`), so the visual
// side comes for free. Notes are scheduled against the AudioContext clock
// (not setTimeout) for sample-accurate timing, and each note is a small
// additive tone (fundamental + two harmonics through a lowpass filter, with
// an attack/decay/release envelope) rather than a single bare oscillator —
// this mirrors the synth in jbergknoff/piano-practice's MidiPlayer.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  type ChordGroup,
  computeMeasureStartBeats,
  isRest,
  type ParsedScore,
  type Pitch,
} from "./sheet-music/index";

// Fallback tempo (quarter-note BPM) when the score carries no `<sound tempo>`.
const DEFAULT_BPM = 100;

// Standard MusicXML carries no per-note dynamics, so playback uses a single
// default velocity (0-127, MIDI-style) for every note.
const DEFAULT_VELOCITY = 80;

// Small offset so the first scheduled note is never in the past.
const LOOKAHEAD = 0.05;
// Tail (seconds) added past each note's nominal duration for the release ramp.
const RELEASE_TIME = 0.35;
// Minimum gap (ms) between getLiveBeat-driving position updates.
const POSITION_UPDATE_INTERVAL = 50;

interface BeatStep {
  /** Absolute quarter-note beat of this onset. */
  beat: number;
  pitches: Pitch[];
  /** Beats until the next onset (how long this step holds). */
  durationBeats: number;
}

const SEMITONE_OF_STEP: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function pitchFrequency(pitch: Pitch): number {
  const midi =
    (pitch.octave + 1) * 12 + (SEMITONE_OF_STEP[pitch.step] ?? 0) + pitch.alter;
  return 440 * 2 ** ((midi - 69) / 12);
}

// Flatten the score into the distinct onsets that sound, merging every part's
// pitches at each beat. Rests advance the cursor but produce no step.
function flattenBeats(score: ParsedScore): BeatStep[] {
  const measureStartBeats = computeMeasureStartBeats(score);
  const byBeat = new Map<number, Pitch[]>();
  for (const part of score.parts) {
    part.measures.forEach((measure, measureIndex) => {
      let beatCursor = measureStartBeats[measureIndex] ?? 0;
      const divisions = measure.divisions || 4;
      for (const event of measure.events) {
        if (isRest(event)) {
          beatCursor += event.duration / divisions;
          continue;
        }
        const group = event as ChordGroup;
        const pitches = byBeat.get(beatCursor) ?? [];
        for (const note of group.notes) {
          pitches.push(note.pitch);
        }
        byBeat.set(beatCursor, pitches);
        beatCursor += group.duration / divisions;
      }
    });
  }
  const beats = Array.from(byBeat.keys()).sort((a, b) => a - b);
  return beats.map((beat, i) => ({
    beat,
    pitches: byBeat.get(beat) as Pitch[],
    durationBeats: (beats[i + 1] ?? beat + 1) - beat,
  }));
}

// Schedule one note: a fundamental (triangle) plus two quieter harmonics
// (sine, at 2x and 3x frequency) through a velocity-brightened lowpass
// filter, with an attack/decay/sustain/release envelope. Richer and less
// buzzy than a single bare oscillator.
function scheduleNote(
  ac: AudioContext,
  activeNodes: Set<AudioNode>,
  frequency: number,
  startTime: number,
  duration: number,
  velocity: number = DEFAULT_VELOCITY,
): void {
  const vol = (velocity / 127) * 0.22;
  const totalDuration = duration + RELEASE_TIME;

  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 800 + (velocity / 127) * 3200;
  filter.Q.value = 0.5;
  filter.connect(ac.destination);

  const gain = ac.createGain();
  gain.connect(filter);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(vol, startTime + 0.012);
  gain.gain.exponentialRampToValueAtTime(vol * 0.55, startTime + 0.012 + 0.18);
  gain.gain.setValueAtTime(vol * 0.55, startTime + duration);
  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    startTime + duration + RELEASE_TIME,
  );

  const harmonics: { multiple: number; type: OscillatorType; gain: number }[] =
    [
      { multiple: 1, type: "triangle", gain: 1 },
      { multiple: 2, type: "sine", gain: 0.22 },
      { multiple: 3, type: "sine", gain: 0.08 },
    ];

  const nodes: AudioNode[] = [filter, gain];
  const oscillators: OscillatorNode[] = [];
  for (const harmonic of harmonics) {
    const harmonicGain = ac.createGain();
    harmonicGain.gain.value = harmonic.gain;
    harmonicGain.connect(gain);
    nodes.push(harmonicGain);

    const oscillator = ac.createOscillator();
    oscillator.frequency.value = frequency * harmonic.multiple;
    oscillator.type = harmonic.type;
    oscillator.connect(harmonicGain);
    oscillator.start(startTime);
    oscillator.stop(startTime + totalDuration);
    nodes.push(oscillator);
    oscillators.push(oscillator);
  }

  for (const node of nodes) {
    activeNodes.add(node);
  }

  // Once the note finishes, disconnect its nodes so they can be garbage
  // collected instead of accumulating for the rest of playback. All
  // oscillators share the same stop time, so one handler suffices.
  oscillators[0].onended = () => {
    for (const node of nodes) {
      activeNodes.delete(node);
      try {
        node.disconnect();
      } catch {}
    }
  };
}

export interface Listen {
  playing: boolean;
  /** Live beat for the renderer's cursor (null when stopped). */
  getLiveBeat: () => number | null;
  /** Play from `fromBeat` (or the start), or stop if already playing. */
  toggle: (fromBeat?: number) => void;
  stop: () => void;
}

export function useListen(
  score: ParsedScore | null,
  bpm: number = DEFAULT_BPM,
): Listen {
  const [playing, setPlaying] = useState(false);
  const liveBeatRef = useRef<number | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const activeNodesRef = useRef<Set<AudioNode>>(new Set());
  const animationFrameRef = useRef<number | null>(null);
  const lastPositionEmitRef = useRef(0);
  const bpmRef = useRef(bpm > 0 ? bpm : DEFAULT_BPM);
  bpmRef.current = bpm > 0 ? bpm : DEFAULT_BPM;

  const getLiveBeat = useCallback(() => liveBeatRef.current, []);

  const stopTick = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    stopTick();
    // Cut off any notes still sounding (including ones scheduled but not yet
    // started) instead of letting the whole upfront schedule play out.
    for (const node of activeNodesRef.current) {
      if (node instanceof OscillatorNode) {
        try {
          node.stop(0);
        } catch {}
      }
      try {
        node.disconnect();
      } catch {}
    }
    activeNodesRef.current.clear();
    liveBeatRef.current = null;
    setPlaying(false);
  }, [stopTick]);

  const start = useCallback(
    (fromBeat?: number) => {
      if (!score) {
        return;
      }
      const steps = flattenBeats(score);
      if (steps.length === 0) {
        return;
      }
      const startBeat = fromBeat ?? steps[0].beat;
      const totalBeats =
        steps[steps.length - 1].beat + steps[steps.length - 1].durationBeats;

      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!audioRef.current) {
        audioRef.current = new AudioCtor();
      }
      const ac = audioRef.current;
      if (ac.state === "suspended") {
        void ac.resume();
      }

      const secsPerBeat = 60 / bpmRef.current;
      // AudioContext time at which beat 0 of the piece would play.
      const startAudioTime =
        ac.currentTime + LOOKAHEAD - startBeat * secsPerBeat;

      for (const step of steps) {
        if (step.beat < startBeat - 1e-6) {
          continue;
        }
        const noteStart = startAudioTime + step.beat * secsPerBeat;
        const duration = step.durationBeats * secsPerBeat;
        for (const pitch of step.pitches) {
          scheduleNote(
            ac,
            activeNodesRef.current,
            pitchFrequency(pitch),
            noteStart,
            duration,
          );
        }
      }

      setPlaying(true);
      lastPositionEmitRef.current = 0;

      const tick = () => {
        const elapsedBeat = (ac.currentTime - startAudioTime) / secsPerBeat;

        if (elapsedBeat >= totalBeats) {
          liveBeatRef.current = null;
          setPlaying(false);
          animationFrameRef.current = null;
          return;
        }

        const now = performance.now();
        if (now - lastPositionEmitRef.current >= POSITION_UPDATE_INTERVAL) {
          lastPositionEmitRef.current = now;
          // Clamp to startBeat so the cursor never dips below the play-start
          // position during the LOOKAHEAD window right after starting/seeking.
          liveBeatRef.current = Math.max(
            startBeat,
            Math.min(elapsedBeat, totalBeats),
          );
        }

        animationFrameRef.current = requestAnimationFrame(tick);
      };
      animationFrameRef.current = requestAnimationFrame(tick);
    },
    [score],
  );

  const toggle = useCallback(
    (fromBeat?: number) => {
      if (playing) {
        stop();
      } else {
        start(fromBeat);
      }
    },
    [playing, start, stop],
  );

  // Stop any pending animation frame on unmount.
  useEffect(() => {
    return () => {
      stopTick();
    };
  }, [stopTick]);

  return { playing, getLiveBeat, toggle, stop };
}
