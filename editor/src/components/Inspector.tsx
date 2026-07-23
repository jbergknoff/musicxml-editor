// The right-hand inspector: the touch-friendly counterpart to keyboard editing.
// It mirrors the current selection — a header naming the time-position and a
// per-note list for the selected chord, each row carrying an accidental
// segmented control, pitch steppers, and a remove button — plus an Add-note
// button. The drilled note's row is highlighted to stay in lock-step with the
// score. It is a pure view: the Editor owns the document and the index→handle
// mapping, and passes the model + callbacks down.

import { COLORS, FOCUS_SHADOW, FONTS, LAYOUT, RADIUS } from "../theme";

export type InspectorLevel = "idle" | "beat" | "note";

export interface InspectorNoteRow {
  /** Stable key for the row (the renderer note id). */
  key: string;
  /** Display label, e.g. "G4" or "F♯5". */
  label: string;
  /** Chromatic alteration: -1 flat, 0 natural, +1 sharp (±2 doubles). */
  alter: number;
  /** Whether this row is the drilled (Level 2) note. */
  focused: boolean;
  /** True when this note ties forward into the next chord's matching pitch. */
  tied: boolean;
  /** This note's own duration, in quarter-note beats — matches the group's
   *  `durationBeats` unless it's been diverged from its chord-mates. */
  durationBeats: number;
  /** The largest duration this note could take without clamping. */
  maxDurationBeats: number;
  /** Only a chord (more than one note at this onset) can diverge a member's
   *  duration from the rest — a lone note's duration is set via the group
   *  control above, not per-row. */
  canDivergeDuration: boolean;
}

export interface InspectorGraceRow {
  /** Stable key for the row (the renderer note id). */
  key: string;
  /** Display label, e.g. "G4" or "F♯5". */
  label: string;
  /** Chromatic alteration: -1 flat, 0 natural, +1 sharp (±2 doubles). */
  alter: number;
  /** Which temporal group (of simultaneous grace notes) this row belongs to —
   *  0 sounds first, ascending. */
  groupIndex: number;
  /** Total grace groups preceding the parent note (bounds reorder buttons). */
  groupCount: number;
  /** True for an acciaccatura (slashed grace note). */
  slash: boolean;
}

/** One staff's notes within the selected beat, with its staff label and duration. */
export interface InspectorNoteGroup {
  partIndex: number;
  /** 0-based voice ordinal on the staff. Shown as a "Voice N" badge only when
   *  > 0 (a note split onto a secondary voice), so single-voice music is
   *  unadorned. */
  voiceIndex: number;
  /** "Treble" / "Bass" for grand staff; "" for a single staff. */
  label: string;
  /** Note-value name for this staff's slot, e.g. "quarter". */
  durationLabel: string;
  /** This slot's duration in quarter-note beats (the `onSetDuration` value
   *  space) — undotted, matching `durationLabel`. */
  durationBeats: number;
  /** The largest duration (in quarter-note beats) that actually fits before
   *  the next note — picker options above this would silently clamp back
   *  down to the current value, so they're disabled. */
  maxDurationBeats: number;
  /** True when this staff's slot is a rest (no notes). */
  isRest: boolean;
  /** True when this staff's chord carries a fermata (hold) mark. */
  hasFermata: boolean;
  /** Index of this group's first note in the flat handles array. */
  noteOffset: number;
  /** Top-first (descending pitch) note rows; empty for a rest. */
  notes: InspectorNoteRow[];
  /** Grace notes preceding this group's chord, in playback order; empty for a
   *  rest or a chord with no grace notes. */
  graces: InspectorGraceRow[];
  /** Index of this group's first grace row in the flat grace handles array. */
  graceOffset: number;
}

// Standard note values offered by the duration selector, largest first —
// mirrors `dom-edit`'s own standard-duration table (dotted values included, so
// the dotted rhythms OMR sources are full of can be entered directly).
const DURATION_OPTIONS: Array<{ label: string; beats: number }> = [
  { label: "Whole", beats: 4 },
  { label: "Half ·", beats: 3 },
  { label: "Half", beats: 2 },
  { label: "Quarter ·", beats: 1.5 },
  { label: "Quarter", beats: 1 },
  { label: "Eighth ·", beats: 0.75 },
  { label: "Eighth", beats: 0.5 },
  { label: "16th", beats: 0.25 },
];

function DurationSelect({
  value,
  maxBeats,
  onChange,
}: {
  value: number;
  /** Options larger than this would silently clamp back down (no room
   *  before the next note) — they're disabled rather than hidden, so the
   *  full standard scale stays visible and the reason (no space) is
   *  discoverable via the title. */
  maxBeats: number;
  onChange: (beats: number) => void;
}) {
  return (
    <select
      aria-label="Note duration"
      value={value}
      onChange={(event) =>
        onChange(Number.parseFloat((event.target as HTMLSelectElement).value))
      }
      style={{
        border: `1px solid ${COLORS.borderLight}`,
        borderRadius: 5,
        background: COLORS.canvas,
        color: COLORS.textPrimary,
        fontFamily: FONTS.mono,
        fontSize: 11.5,
        padding: "3px 4px",
        cursor: "pointer",
      }}
    >
      {DURATION_OPTIONS.map((option) => (
        <option
          key={option.beats}
          value={option.beats}
          disabled={option.beats > maxBeats && option.beats !== value}
          title={
            option.beats > maxBeats && option.beats !== value
              ? "Doesn't fit before the next note"
              : undefined
          }
        >
          {option.label}
        </option>
      ))}
    </select>
  );
}

export interface InspectorModel {
  level: InspectorLevel;
  measureNumber: number;
  beatNumber: number;
  /** Note-value name for the primary (clicked) staff, e.g. "quarter". */
  durationLabel: string;
  /** Flat note list across all staves (for subtitle count). */
  notes: InspectorNoteRow[];
  /** Per-staff note groups; length 1 for single-staff, 2 for grand staff. */
  noteGroups: InspectorNoteGroup[];
}

const LEVEL_LABEL: Record<InspectorLevel, string> = {
  idle: "Idle",
  beat: "Beat",
  note: "Note",
};

function LevelBadge({ level }: { level: InspectorLevel }) {
  const active = level !== "idle";
  return (
    <span
      style={{
        fontFamily: FONTS.mono,
        fontSize: 10.5,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        color: active ? COLORS.accent : COLORS.textFaint,
        border: `1px solid ${active ? COLORS.accent : COLORS.borderLight}`,
        borderRadius: 5,
        padding: "2px 7px",
      }}
    >
      {LEVEL_LABEL[level]}
    </span>
  );
}

// The ♭ ♮ ♯ segmented control. The applied accidental highlights in accent;
// ♮ is the neutral default and is not highlighted (matching the score, which
// only prints a natural when one is actually needed).
function AccidentalControl({
  alter,
  onSet,
}: {
  alter: number;
  onSet: (alter: number) => void;
}) {
  const options: Array<{ glyph: string; value: number }> = [
    { glyph: "♭", value: -1 },
    { glyph: "♮", value: 0 },
    { glyph: "♯", value: 1 },
  ];
  return (
    <span
      style={{
        display: "inline-flex",
        border: `1px solid ${COLORS.borderLight}`,
        borderRadius: 5,
        overflow: "hidden",
        fontFamily: FONTS.music,
        fontSize: 13,
      }}
    >
      {options.map((option, index) => {
        const applied =
          option.value < 0 ? alter < 0 : option.value > 0 ? alter > 0 : false;
        return (
          <button
            key={option.value}
            type="button"
            title={
              option.value < 0 ? "Flat" : option.value > 0 ? "Sharp" : "Natural"
            }
            onClick={() => onSet(applied ? 0 : option.value)}
            style={{
              padding: "2px 7px",
              border: "none",
              borderLeft:
                index === 0 ? "none" : `1px solid ${COLORS.borderLight}`,
              background: applied ? COLORS.accent : "transparent",
              color: applied ? "#fff" : COLORS.textPlaceholder,
              cursor: "pointer",
              lineHeight: 1.4,
            }}
          >
            {option.glyph}
          </button>
        );
      })}
    </span>
  );
}

// A small notehead-stem-flag glyph, mirroring the grace note as drawn on the
// staff (see SheetMusicDisplay's grace rendering) — the slashed variant draws
// the same diagonal stroke through the stem as an acciaccatura on the score,
// so the control reads as "what this will look like" rather than an
// arbitrary icon.
function GraceGlyph({ slash }: { slash: boolean }) {
  return (
    <svg width="13" height="16" viewBox="0 0 13 16" aria-hidden="true">
      <circle cx="4" cy="12.5" r="2.6" fill="currentColor" />
      <line
        x1="6.4"
        y1="12.5"
        x2="6.4"
        y2="2"
        stroke="currentColor"
        stroke-width="1.1"
      />
      <path
        d="M6.4 2 C 10 3, 10 6.5, 6.4 7.5"
        stroke="currentColor"
        stroke-width="1.1"
        fill="none"
      />
      {slash && (
        <line
          x1="3.6"
          y1="8.5"
          x2="9.2"
          y2="3.5"
          stroke="currentColor"
          stroke-width="1.3"
        />
      )}
    </svg>
  );
}

// The appoggiatura/acciaccatura segmented control — same look as
// AccidentalControl, but the two options draw the actual grace-note glyph
// (plain vs. slashed) instead of text, so the current setting and the
// affordance to change it are both visible at a glance.
function GraceStyleControl({
  slash,
  onSet,
}: {
  slash: boolean;
  onSet: (slash: boolean) => void;
}) {
  const options: Array<{ value: boolean; title: string }> = [
    {
      value: false,
      title: "Appoggiatura — leans on the beat, takes time from the main note",
    },
    {
      value: true,
      title: "Acciaccatura (slashed) — crushed, played as fast as possible",
    },
  ];
  return (
    <span
      style={{
        display: "inline-flex",
        border: `1px solid ${COLORS.borderLight}`,
        borderRadius: 5,
        overflow: "hidden",
      }}
    >
      {options.map((option, index) => {
        const applied = option.value === slash;
        return (
          <button
            key={String(option.value)}
            type="button"
            title={option.title}
            onClick={() => onSet(option.value)}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "2px 6px",
              border: "none",
              borderLeft:
                index === 0 ? "none" : `1px solid ${COLORS.borderLight}`,
              background: applied ? COLORS.accent : "transparent",
              color: applied ? "#fff" : COLORS.textPlaceholder,
              cursor: "pointer",
              lineHeight: 0,
            }}
          >
            <GraceGlyph slash={option.value} />
          </button>
        );
      })}
    </span>
  );
}

// Chord-level fermata (hold) toggle — same look as TieToggle. Lives next to
// the duration selector because, like duration, a fermata belongs to the whole
// chord rather than to one member note.
function FermataToggle({
  hasFermata,
  onToggle,
}: {
  hasFermata: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      title={hasFermata ? "Remove fermata" : "Add fermata (hold)"}
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1px solid ${COLORS.borderLight}`,
        borderRadius: 5,
        padding: "2px 7px",
        background: hasFermata ? COLORS.accent : "transparent",
        color: hasFermata ? "#fff" : COLORS.textPlaceholder,
        cursor: "pointer",
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      𝄐
    </button>
  );
}

// Toggle button for tying this note into the next chord's matching pitch —
// same look as the accidental/grace-style segmented controls, but a single
// toggle rather than a set of mutually exclusive options.
function TieToggle({
  tied,
  onToggle,
}: {
  tied: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      title={tied ? "Remove tie" : "Tie to next note of the same pitch"}
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1px solid ${COLORS.borderLight}`,
        borderRadius: 5,
        padding: "2px 7px",
        background: tied ? COLORS.accent : "transparent",
        color: tied ? "#fff" : COLORS.textPlaceholder,
        cursor: "pointer",
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      ⌣
    </button>
  );
}

function Stepper({ onStep }: { onStep: (delta: number) => void }) {
  const arrowStyle = {
    border: "none",
    background: "transparent",
    color: COLORS.textFaint,
    cursor: "pointer",
    fontSize: 9,
    lineHeight: 0.85,
    padding: 0,
  } as const;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column" }}>
      <button
        type="button"
        title="Up one step"
        onClick={() => onStep(1)}
        style={arrowStyle}
      >
        ▲
      </button>
      <button
        type="button"
        title="Down one step"
        onClick={() => onStep(-1)}
        style={arrowStyle}
      >
        ▼
      </button>
    </span>
  );
}

export interface InspectorProps {
  model: InspectorModel | null;
  /** Drill to (or focus) the note at this top-first index. */
  onDrill: (index: number) => void;
  onAccidental: (index: number, alter: number) => void;
  /** Staff-step the note: delta +1 up, -1 down. */
  onStep: (index: number, delta: number) => void;
  onRemove: (index: number) => void;
  /** Toggle a tie from the note at `index` into the next chord's matching
   *  pitch (or remove the tie touching this note, if any). */
  onToggleTie: (index: number) => void;
  /** Toggle a fermata on the chord whose first note is at `index`. */
  onToggleFermata: (index: number) => void;
  onAddNote: (partIndex: number) => void;
  /** Set the duration (in quarter-note beats) of the chord at `index`'s onset —
   *  every chord member is resized together. */
  onSetDuration: (index: number, durationBeats: number) => void;
  /** Set the duration of just the note at `index`, independent of its
   *  chord-mates — how one member's rhythm diverges from the rest. */
  onSetNoteDuration: (index: number, durationBeats: number) => void;
  onGraceAccidental: (index: number, alter: number) => void;
  /** Staff-step the grace note: delta +1 up, -1 down. */
  onGraceStep: (index: number, delta: number) => void;
  onGraceRemove: (index: number) => void;
  /** Move the grace note's group earlier/later relative to its siblings. */
  onGraceReorder: (index: number, direction: "earlier" | "later") => void;
  /** Set acciaccatura (slashed) vs. appoggiatura (unslashed). */
  onGraceSlash: (index: number, slash: boolean) => void;
  /** Add a new grace note immediately before the chord whose top note is at
   *  this flat note index. */
  onAddGrace: (noteIndex: number) => void;
  /** When false the panel renders a view-only notice instead of controls. */
  editable: boolean;
}

// One grace note row: its label, the appoggiatura/acciaccatura segmented
// control, reorder arrows (earlier/later among its siblings), the shared
// accidental/stepper controls, and a remove button.
function GraceNoteRowEl({
  grace,
  onAccidental,
  onStep,
  onRemove,
  onReorder,
  onSetSlash,
}: {
  grace: InspectorGraceRow;
  onAccidental: (alter: number) => void;
  onStep: (delta: number) => void;
  onRemove: () => void;
  onReorder: (direction: "earlier" | "later") => void;
  onSetSlash: (slash: boolean) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        background: COLORS.canvas,
        border: `1px dashed ${COLORS.borderLight}`,
        borderRadius: RADIUS.row,
        padding: "6px 8px",
        marginLeft: 14,
      }}
    >
      <GraceStyleControl slash={grace.slash} onSet={onSetSlash} />
      <span
        style={{
          flex: 1,
          fontFamily: FONTS.mono,
          fontSize: 13,
          color: COLORS.textPrimary,
        }}
      >
        {grace.label}
      </span>
      <span style={{ display: "inline-flex", flexDirection: "column" }}>
        <button
          type="button"
          title="Sound earlier"
          disabled={grace.groupIndex === 0}
          onClick={() => onReorder("earlier")}
          style={{
            border: "none",
            background: "transparent",
            color:
              grace.groupIndex === 0
                ? COLORS.textPlaceholder
                : COLORS.textFaint,
            cursor: grace.groupIndex === 0 ? "default" : "pointer",
            fontSize: 9,
            lineHeight: 0.85,
            padding: 0,
          }}
        >
          ◀
        </button>
        <button
          type="button"
          title="Sound later"
          disabled={grace.groupIndex === grace.groupCount - 1}
          onClick={() => onReorder("later")}
          style={{
            border: "none",
            background: "transparent",
            color:
              grace.groupIndex === grace.groupCount - 1
                ? COLORS.textPlaceholder
                : COLORS.textFaint,
            cursor:
              grace.groupIndex === grace.groupCount - 1 ? "default" : "pointer",
            fontSize: 9,
            lineHeight: 0.85,
            padding: 0,
          }}
        >
          ▶
        </button>
      </span>
      <AccidentalControl alter={grace.alter} onSet={onAccidental} />
      <Stepper onStep={onStep} />
      <button
        type="button"
        title="Remove grace note"
        onClick={onRemove}
        style={{
          border: "none",
          background: "transparent",
          color: COLORS.textPlaceholder,
          cursor: "pointer",
          fontSize: 13,
          flex: "none",
        }}
      >
        ✕
      </button>
    </div>
  );
}

function NoteGroupSection({
  group,
  showLabel,
  onDrill,
  onAccidental,
  onStep,
  onRemove,
  onToggleTie,
  onToggleFermata,
  onAddNote,
  onSetDuration,
  onSetNoteDuration,
  onGraceAccidental,
  onGraceStep,
  onGraceRemove,
  onGraceReorder,
  onGraceSlash,
  onAddGrace,
}: {
  group: InspectorNoteGroup;
  showLabel: boolean;
  onDrill: (flatIndex: number) => void;
  onAccidental: (flatIndex: number, alter: number) => void;
  onStep: (flatIndex: number, delta: number) => void;
  onRemove: (flatIndex: number) => void;
  onToggleTie: (flatIndex: number) => void;
  onToggleFermata: (flatIndex: number) => void;
  onAddNote: (partIndex: number) => void;
  onSetDuration: (flatIndex: number, durationBeats: number) => void;
  onSetNoteDuration: (flatIndex: number, durationBeats: number) => void;
  onGraceAccidental: (flatIndex: number, alter: number) => void;
  onGraceStep: (flatIndex: number, delta: number) => void;
  onGraceRemove: (flatIndex: number) => void;
  onGraceReorder: (flatIndex: number, direction: "earlier" | "later") => void;
  onGraceSlash: (flatIndex: number, slash: boolean) => void;
  /** Add a new grace note immediately before the chord whose top note is at
   *  this flat note index. */
  onAddGrace: (noteIndex: number) => void;
}) {
  // A polyphonic staff shows a "Voice N" badge even without a Treble/Bass label
  // (single-staff two-voice music), so the header appears whenever it would.
  const showHeader = showLabel || group.voiceIndex > 0;
  return (
    <div style={{ marginBottom: showHeader ? 12 : 0 }}>
      {showHeader && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 6,
            paddingBottom: 4,
            borderBottom: `1px solid ${COLORS.borderLight}`,
          }}
        >
          <span
            style={{
              fontFamily: FONTS.mono,
              fontSize: 11,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: COLORS.textFaint,
              display: "flex",
              gap: 6,
              alignItems: "baseline",
            }}
          >
            {group.label}
            {group.voiceIndex > 0 && (
              <span style={{ color: COLORS.accent }}>
                Voice {group.voiceIndex + 1}
              </span>
            )}
          </span>
          <span
            style={{
              fontFamily: FONTS.mono,
              fontSize: 11,
              color: COLORS.textMuted,
            }}
          >
            {group.isRest
              ? `Rest · ${group.durationLabel}`
              : group.durationLabel}
          </span>
        </div>
      )}
      {group.graces.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 7,
            marginBottom: 8,
          }}
        >
          {group.graces.map((grace, i) => {
            const flatIndex = group.graceOffset + i;
            return (
              <GraceNoteRowEl
                key={grace.key}
                grace={grace}
                onAccidental={(alter) => onGraceAccidental(flatIndex, alter)}
                onStep={(delta) => onGraceStep(flatIndex, delta)}
                onRemove={() => onGraceRemove(flatIndex)}
                onReorder={(direction) => onGraceReorder(flatIndex, direction)}
                onSetSlash={(slash) => onGraceSlash(flatIndex, slash)}
              />
            );
          })}
        </div>
      )}
      {!group.isRest && group.notes.length > 0 && (
        <button
          type="button"
          onClick={() => onAddGrace(group.noteOffset)}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: "100%",
            border: `1px dashed ${COLORS.borderLight}`,
            color: COLORS.textFaint,
            background: "transparent",
            borderRadius: RADIUS.row,
            padding: "5px 8px",
            marginBottom: 8,
            fontSize: 11.5,
            fontFamily: FONTS.mono,
            cursor: "pointer",
          }}
        >
          <GraceGlyph slash={false} />
          Add grace note
        </button>
      )}
      {group.notes.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 7,
            marginBottom: 7,
          }}
        >
          <span
            style={{
              fontFamily: FONTS.mono,
              fontSize: 11,
              color: COLORS.textFaint,
            }}
          >
            Duration
          </span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
          >
            <DurationSelect
              value={group.durationBeats}
              maxBeats={group.maxDurationBeats}
              onChange={(beats) => onSetDuration(group.noteOffset, beats)}
            />
            <FermataToggle
              hasFermata={group.hasFermata}
              onToggle={() => onToggleFermata(group.noteOffset)}
            />
          </span>
        </div>
      )}
      {group.notes.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 7,
            marginBottom: 8,
          }}
        >
          {group.notes.map((note, i) => {
            const flatIndex = group.noteOffset + i;
            return (
              <div
                key={note.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  background: COLORS.canvas,
                  border: `${note.focused ? 1.5 : 1}px solid ${
                    note.focused ? COLORS.accent : COLORS.borderLight
                  }`,
                  borderRadius: RADIUS.row,
                  padding: "7px 8px",
                  boxShadow: note.focused ? FOCUS_SHADOW : undefined,
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    flex: "none",
                    background: note.focused
                      ? COLORS.accent
                      : COLORS.textPrimary,
                  }}
                />
                <button
                  type="button"
                  onClick={() => onDrill(flatIndex)}
                  style={{
                    flex: 1,
                    textAlign: "left",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontFamily: FONTS.mono,
                    fontSize: 13,
                    fontWeight: note.focused ? 600 : 500,
                    color: note.focused ? COLORS.accent : COLORS.textPrimary,
                  }}
                >
                  {note.label}
                </button>
                {note.canDivergeDuration && (
                  <DurationSelect
                    value={note.durationBeats}
                    maxBeats={note.maxDurationBeats}
                    onChange={(beats) => onSetNoteDuration(flatIndex, beats)}
                  />
                )}
                <AccidentalControl
                  alter={note.alter}
                  onSet={(alter) => onAccidental(flatIndex, alter)}
                />
                <Stepper onStep={(delta) => onStep(flatIndex, delta)} />
                <TieToggle
                  tied={note.tied}
                  onToggle={() => onToggleTie(flatIndex)}
                />
                <button
                  type="button"
                  title="Remove note"
                  onClick={() => onRemove(flatIndex)}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: COLORS.textPlaceholder,
                    cursor: "pointer",
                    fontSize: 13,
                    flex: "none",
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      <button
        type="button"
        onClick={() => onAddNote(group.partIndex)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          width: "100%",
          border: `1px dashed ${COLORS.accentBorderFaint}`,
          color: COLORS.accent,
          background: "transparent",
          borderRadius: RADIUS.row,
          padding: 8,
          fontSize: 12.5,
          fontFamily: FONTS.mono,
          cursor: "pointer",
        }}
      >
        + Add note
      </button>
    </div>
  );
}

export function Inspector({
  model,
  onDrill,
  onAccidental,
  onStep,
  onRemove,
  onToggleTie,
  onToggleFermata,
  onAddNote,
  onSetDuration,
  onSetNoteDuration,
  onGraceAccidental,
  onGraceStep,
  onGraceRemove,
  onGraceReorder,
  onGraceSlash,
  onAddGrace,
  editable,
}: InspectorProps) {
  const multiStaff = model ? model.noteGroups.length > 1 : false;
  const subtitle =
    !multiStaff && model && model.notes.length > 0
      ? `${model.notes.length} ${
          model.notes.length === 1 ? "note" : "notes"
        } · ${model.durationLabel}`
      : !multiStaff && model
        ? `Rest · ${model.durationLabel}`
        : "";

  return (
    <aside
      style={{
        width: LAYOUT.inspectorWidth,
        flex: "none",
        background: COLORS.panel,
        borderLeft: `1px solid ${COLORS.borderLight}`,
        padding: 16,
        overflowY: "auto",
        boxSizing: "border-box",
        fontFamily: FONTS.ui,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.mono,
            fontSize: 10.5,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: COLORS.textFaint,
          }}
        >
          Selection
        </span>
        <LevelBadge level={model?.level ?? "idle"} />
      </div>

      {!editable ? (
        <p style={{ fontSize: 13, color: COLORS.textMuted, lineHeight: 1.5 }}>
          This score uses multiple staves or voices — it's view-only. Editing
          tools are disabled.
        </p>
      ) : !model ? (
        <p
          style={{
            fontSize: 13,
            color: COLORS.textPlaceholder,
            lineHeight: 1.5,
            textAlign: "center",
            marginTop: 40,
          }}
        >
          Click a beat on the score to select it.
        </p>
      ) : (
        <>
          <div
            style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary }}
          >
            Measure {model.measureNumber} · Beat {model.beatNumber}
          </div>
          <div
            style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 14 }}
          >
            {subtitle}
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: multiStaff ? 4 : 0,
            }}
          >
            {model.noteGroups.map((group) => (
              <NoteGroupSection
                key={group.partIndex}
                group={group}
                showLabel={multiStaff}
                onDrill={onDrill}
                onAccidental={onAccidental}
                onStep={onStep}
                onRemove={onRemove}
                onToggleTie={onToggleTie}
                onToggleFermata={onToggleFermata}
                onAddNote={onAddNote}
                onSetDuration={onSetDuration}
                onSetNoteDuration={onSetNoteDuration}
                onGraceAccidental={onGraceAccidental}
                onGraceStep={onGraceStep}
                onGraceRemove={onGraceRemove}
                onGraceReorder={onGraceReorder}
                onGraceSlash={onGraceSlash}
                onAddGrace={onAddGrace}
              />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
