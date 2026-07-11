import { describe, expect, test } from "bun:test";
import { parseScore } from "./musicxml-parser";
import { eventXsFromSpine, resolveLayout } from "./sheet-music-layout";
import type { ChordGroup } from "./sheet-music-types";

function scoreWithMeasures(measuresXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Music</part-name></score-part>
  </part-list>
  <part id="P1">
${measuresXml}
  </part>
</score-partwise>`;
}

function restMeasure(number: number, extra = ""): string {
  const attributes =
    number === 1
      ? "<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>"
      : "";
  return `<measure number="${number}">${attributes}<note><rest measure="yes"/><duration>16</duration></note>${extra}</measure>`;
}

describe("parseScore repeat barlines", () => {
  test("reads a forward repeat at the start of a measure", () => {
    const xml = scoreWithMeasures(
      `${restMeasure(
        1,
        `<barline location="left"><repeat direction="forward"/></barline>`,
      )}${restMeasure(2)}`,
    );
    const score = parseScore(xml);
    expect(score.parts[0].measures[0].repeatStart).toBe(true);
    expect(score.parts[0].measures[1].repeatStart).toBeUndefined();
  });

  test("reads a backward repeat with an explicit times count", () => {
    const xml = scoreWithMeasures(
      `${restMeasure(
        1,
        `<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward" times="3"/></barline>`,
      )}${restMeasure(2)}`,
    );
    const score = parseScore(xml);
    expect(score.parts[0].measures[0].repeatEnd).toEqual({ times: 3 });
    expect(score.parts[0].measures[1].repeatEnd).toBeUndefined();
  });

  test("defaults times to 2 when omitted", () => {
    const xml = scoreWithMeasures(
      `${restMeasure(
        1,
        `<barline location="right"><repeat direction="backward"/></barline>`,
      )}`,
    );
    const score = parseScore(xml);
    expect(score.parts[0].measures[0].repeatEnd).toEqual({ times: 2 });
  });

  test("measures without repeat barlines carry neither field", () => {
    const xml = scoreWithMeasures(restMeasure(1));
    const score = parseScore(xml);
    expect(score.parts[0].measures[0].repeatStart).toBeUndefined();
    expect(score.parts[0].measures[0].repeatEnd).toBeUndefined();
  });
});

describe("cross-rhythm layout alignment", () => {
  test("a 3-against-2 measure aligns simultaneous triplet and eighth notes on one column", () => {
    // A 4/4 bar (divisions=6) whose treble is a quarter rest then triplet
    // eighths (duration 2 -> 4/3 of a normalized division) over beats 1-3,
    // while the bass is straight eighths (duration 3 -> 2 normalized). On beat
    // 2 the treble note (normalized onset 4 + 4/3 + 4/3 + 4/3) and the bass
    // note (normalized onset 2*4) are simultaneous, but those float onset sums
    // land on 7.999999999999999 vs 8 -- one ULP apart. Before quantizing onsets
    // together within an epsilon, the layout treated them as two columns
    // MIN_EVENT_ADVANCE apart, drawing the noteheads misaligned. They must
    // share one x column. (Beats 1 and 3 don't drift -- their sums land back
    // exactly on 4 and 12 -- so beat 2 is the one that regresses.)
    const xml = `<?xml version="1.0"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>6</divisions><key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><rest/><duration>6</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><staff>1</staff></note>
      <note><pitch><step>F</step><alter>1</alter><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><staff>1</staff></note>
      <note><pitch><step>C</step><alter>1</alter><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><staff>1</staff></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><staff>1</staff></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><staff>1</staff></note>
      <note><pitch><step>C</step><alter>1</alter><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><staff>1</staff></note>
      <note><pitch><step>G</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><staff>1</staff></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><staff>1</staff></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><staff>1</staff></note>
      <backup><duration>24</duration></backup>
      <note><pitch><step>E</step><octave>2</octave></pitch><duration>3</duration><voice>5</voice><type>eighth</type><staff>2</staff></note>
      <note><pitch><step>B</step><octave>2</octave></pitch><duration>3</duration><voice>5</voice><type>eighth</type><staff>2</staff></note>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>3</duration><voice>5</voice><type>eighth</type><staff>2</staff></note>
      <note><pitch><step>G</step><alter>1</alter><octave>3</octave></pitch><duration>3</duration><voice>5</voice><type>eighth</type><staff>2</staff></note>
      <note><pitch><step>B</step><octave>3</octave></pitch><duration>3</duration><voice>5</voice><type>eighth</type><staff>2</staff></note>
      <note><pitch><step>G</step><alter>1</alter><octave>3</octave></pitch><duration>3</duration><voice>5</voice><type>eighth</type><staff>2</staff></note>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>3</duration><voice>5</voice><type>eighth</type><staff>2</staff></note>
      <note><pitch><step>B</step><octave>2</octave></pitch><duration>3</duration><voice>5</voice><type>eighth</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;
    const score = parseScore(xml);
    const layout = resolveLayout(score);
    const spine = layout.measureSpines[0];

    const trebleXs = eventXsFromSpine(score.parts[0].measures[0].events, spine);
    const bassXs = eventXsFromSpine(score.parts[1].measures[0].events, spine);

    // Treble events: [rest, t1..t9]. The beat-2 downbeat is the 4th triplet,
    // event index 4. Bass events: 8 eighths; beat 2 is the 5th, event index 4.
    // These are simultaneous and must render at the same x.
    expect(trebleXs[4]).toBe(bassXs[4]);

    // Beats 1 and 3 coincidences too (treble indices 1 and 7, bass indices 2
    // and 6), plus the downbeat (bass index 0, treble rest occupies beat 0).
    expect(trebleXs[1]).toBe(bassXs[2]);
    expect(trebleXs[7]).toBe(bassXs[6]);

    // The spine must have no near-duplicate columns: every gap between
    // adjacent onsets is a real musical gap, not an ULP-sized sliver.
    for (let k = 1; k < spine.divs.length; k++) {
      expect(spine.divs[k] - spine.divs[k - 1]).toBeGreaterThan(1e-3);
    }
  });
});

describe("clef changes", () => {
  // Two staves, two measures. Staff 2 opens in bass, changes to treble mid-way
  // through measure 1 (a new <attributes>/<clef> block after two quarter notes),
  // then changes back to bass at the start of measure 2. Mirrors a left hand
  // that crosses between bass and treble mid-measure.
  const MID_MEASURE_CLEF = `<?xml version="1.0"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions><key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>5</voice><type>quarter</type><staff>2</staff></note>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration><voice>5</voice><type>quarter</type><staff>2</staff></note>
      <attributes><clef number="2"><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>5</voice><type>quarter</type><staff>2</staff></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>5</voice><type>quarter</type><staff>2</staff></note>
    </measure>
    <measure number="2">
      <attributes><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>16</duration><voice>5</voice><type>whole</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

  test("a mid-measure clef change tags only the chords after it", () => {
    const bass = parseScore(MID_MEASURE_CLEF).parts[1];
    const events = bass.measures[0].events as ChordGroup[];
    // The measure starts in bass (F clef), so its start clef is F4 and the first
    // two chords (before the change) carry no clef override.
    expect(bass.measures[0].clef).toMatchObject({ sign: "F", line: 4 });
    expect(events[0].clef).toBeUndefined();
    expect(events[1].clef).toBeUndefined();
    // The chords after the mid-measure change are tagged with the new (treble) clef.
    expect(events[2].clef).toMatchObject({ sign: "G", line: 2 });
    expect(events[3].clef).toMatchObject({ sign: "G", line: 2 });
    // A mid-measure change is not a barline change, so no clefChange glyph fires.
    expect(bass.measures[0].clefChange).toBeUndefined();
  });

  test("the running clef carries the last mid-measure clef into the next measure", () => {
    const bass = parseScore(MID_MEASURE_CLEF).parts[1];
    // Measure 1 ends in treble (the mid-measure change); measure 2 re-declares
    // bass at its barline, so it starts in bass and records a clefChange.
    expect(bass.measures[1].clef).toMatchObject({ sign: "F", line: 4 });
    expect(bass.measures[1].clefChange).toMatchObject({ sign: "F", line: 4 });
    // The unchanged treble staff never records a clef change.
    const treble = parseScore(MID_MEASURE_CLEF).parts[0];
    expect(treble.measures[1].clefChange).toBeUndefined();
    expect(treble.measures[1].clef).toMatchObject({ sign: "G", line: 2 });
  });

  test("the initial part clef is the first declared clef, not a default", () => {
    const score = parseScore(MID_MEASURE_CLEF);
    expect(score.parts[0].clef).toMatchObject({ sign: "G", line: 2 });
    expect(score.parts[1].clef).toMatchObject({ sign: "F", line: 4 });
  });

  test("a single-staff part resolves a measure-start clef change", () => {
    // A cello-style single-staff part that switches to treble for a high
    // passage in measure 2, then back to bass in measure 3.
    const xml = `<?xml version="1.0"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Cello</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions><key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <attributes><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><type>whole</type></note>
    </measure>
    <measure number="3">
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
    const part = parseScore(xml).parts[0];
    expect(part.clef).toMatchObject({ sign: "F", line: 4 });
    expect(part.measures[0].clef).toMatchObject({ sign: "F", line: 4 });
    // Measure 2 switches to treble and records the change...
    expect(part.measures[1].clef).toMatchObject({ sign: "G", line: 2 });
    expect(part.measures[1].clefChange).toMatchObject({ sign: "G", line: 2 });
    // ...and measure 3 carries the treble clef forward (it declares none).
    expect(part.measures[2].clef).toMatchObject({ sign: "G", line: 2 });
    expect(part.measures[2].clefChange).toBeUndefined();
  });
});
