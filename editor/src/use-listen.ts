// "Listen" playback: a small WebAudio step-synth that walks the score beat by
// beat at a fixed tempo, sounding each beat's pitches. It owns no UI — it
// exposes `getLiveBeat`/`playing` to drive the renderer's existing on-score
// cursor + scroll-follow (SheetMusicDisplay's `getLiveBeat`/`isPlaying`), so the
// visual side comes for free. Mirrors the handoff prototype's startListen/beep.
// Each note is a small additive tone (fundamental + two harmonics through a
// lowpass filter, with an attack/decay/release envelope) rather than a single
// bare oscillator — this mirrors the synth in jbergknoff/piano-practice's
// MidiPlayer.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  type ChordGroup,
  computePlaybackStartBeats,
  expandPlaybackOrder,
  isRest,
  type ParsedScore,
  type Pitch,
} from "./sheet-music/index";

// Fallback tempo (quarter-note BPM) when the score carries no `<sound tempo>`.
const DEFAULT_BPM = 100;

// Standard MusicXML carries no per-note dynamics, so playback uses a single
// default velocity (0-127, MIDI-style) for every note.
const DEFAULT_VELOCITY = 80;

// Tail (seconds) added past each note's nominal duration for the release ramp.
const RELEASE_TIME = 0.35;

interface BeatStep {
  /**
   * Cumulative quarter-note beat of this onset across the whole playback
   * timeline (repeats expanded) — strictly increasing, drives scheduling
   * order and gap timing. Not a position on the page.
   */
  playbackBeat: number;
  /**
   * Document-order quarter-note beat this onset corresponds to on the page —
   * a repeated measure's second pass reports the same `displayBeat` as its
   * first, so the on-screen cursor snaps back rather than running off the end.
   */
  displayBeat: number;
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
// pitches at each beat, expanding any backward repeat barlines so a repeated
// measure's notes are scheduled once per pass. Rests advance the cursor but
// produce no step.
function flattenBeats(score: ParsedScore): BeatStep[] {
  const order = expandPlaybackOrder(score.parts[0]?.measures ?? []);
  const byBeat = new Map<number, { displayBeat: number; pitches: Pitch[] }>();
  for (const part of score.parts) {
    const { playbackStart, displayStart } = computePlaybackStartBeats(
      part.measures,
      order,
    );
    order.forEach((measureIndex, position) => {
      const measure = part.measures[measureIndex];
      if (!measure) {
        return;
      }
      const divisions = measure.divisions || 4;
      // Each voice on the staff sounds simultaneously, so every voice restarts
      // from the measure's start beat and its onsets merge into byBeat.
      for (const voice of measure.voices) {
        let playbackCursor = playbackStart[position];
        let displayCursor = displayStart[position];
        for (const event of voice.events) {
          if (isRest(event)) {
            playbackCursor += event.duration / divisions;
            displayCursor += event.duration / divisions;
            continue;
          }
          const group = event as ChordGroup;
          const entry = byBeat.get(playbackCursor) ?? {
            displayBeat: displayCursor,
            pitches: [],
          };
          for (const note of group.notes) {
            entry.pitches.push(note.pitch);
          }
          byBeat.set(playbackCursor, entry);
          playbackCursor += group.duration / divisions;
          displayCursor += group.duration / divisions;
        }
      }
    });
  }
  const playbackBeats = Array.from(byBeat.keys()).sort((a, b) => a - b);
  return playbackBeats.map((playbackBeat, i) => ({
    playbackBeat,
    displayBeat: (byBeat.get(playbackBeat) as { displayBeat: number })
      .displayBeat,
    pitches: (byBeat.get(playbackBeat) as { pitches: Pitch[] }).pitches,
    durationBeats: (playbackBeats[i + 1] ?? playbackBeat + 1) - playbackBeat,
  }));
}

// Sound one note: a fundamental (triangle) plus two quieter harmonics (sine,
// at 2x and 3x frequency) through a velocity-brightened lowpass filter, with
// an attack/decay/sustain/release envelope. Richer and less buzzy than a
// single bare oscillator.
function beep(
  ac: AudioContext,
  frequency: number,
  ms: number,
  velocity: number = DEFAULT_VELOCITY,
): void {
  const t = ac.currentTime;
  const duration = ms / 1000;
  const vol = (velocity / 127) * 0.22;
  const totalDuration = duration + RELEASE_TIME;

  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 800 + (velocity / 127) * 3200;
  filter.Q.value = 0.5;
  filter.connect(ac.destination);

  const gain = ac.createGain();
  gain.connect(filter);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(vol, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(vol * 0.55, t + 0.012 + 0.18);
  gain.gain.setValueAtTime(vol * 0.55, t + duration);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration + RELEASE_TIME);

  const harmonics: { multiple: number; type: OscillatorType; gain: number }[] =
    [
      { multiple: 1, type: "triangle", gain: 1 },
      { multiple: 2, type: "sine", gain: 0.22 },
      { multiple: 3, type: "sine", gain: 0.08 },
    ];

  for (const harmonic of harmonics) {
    const harmonicGain = ac.createGain();
    harmonicGain.gain.value = harmonic.gain;
    harmonicGain.connect(gain);

    const oscillator = ac.createOscillator();
    oscillator.frequency.value = frequency * harmonic.multiple;
    oscillator.type = harmonic.type;
    oscillator.connect(harmonicGain);
    oscillator.start(t);
    oscillator.stop(t + totalDuration);
  }
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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside the playback loop so a tempo change mid-session takes effect on
  // the next step without restarting playback.
  const quarterMsRef = useRef(60000 / bpm);
  quarterMsRef.current = 60000 / (bpm > 0 ? bpm : DEFAULT_BPM);

  const getLiveBeat = useCallback(() => liveBeatRef.current, []);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    liveBeatRef.current = null;
    setPlaying(false);
  }, []);

  const start = useCallback(
    (fromBeat?: number) => {
      if (!score) {
        return;
      }
      const steps = flattenBeats(score);
      if (steps.length === 0) {
        return;
      }
      let index = 0;
      if (fromBeat !== undefined) {
        // fromBeat is a document (on-screen) position; if it recurs across
        // repeat passes, start at the first pass through it.
        const found = steps.findIndex(
          (step) => step.displayBeat >= fromBeat - 1e-6,
        );
        if (found >= 0) {
          index = found;
        }
      }
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
      setPlaying(true);

      const tick = () => {
        if (index >= steps.length) {
          stop();
          return;
        }
        const step = steps[index];
        liveBeatRef.current = step.displayBeat;
        const ms = step.durationBeats * quarterMsRef.current;
        for (const pitch of step.pitches) {
          beep(ac, pitchFrequency(pitch), ms);
        }
        index += 1;
        timerRef.current = setTimeout(tick, ms);
      };
      tick();
    },
    [score, stop],
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

  // Stop any pending step on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return { playing, getLiveBeat, toggle, stop };
}
