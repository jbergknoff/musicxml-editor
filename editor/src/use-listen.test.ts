import { describe, expect, test } from "bun:test";
import { parseScore } from "./sheet-music/index";
import { flattenBeats } from "./use-listen";

const PARTLIST = `
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
`;

function scoreXml(measuresXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  ${PARTLIST}
  <part id="P1">
    ${measuresXml}
  </part>
</score-partwise>`;
}

describe("flattenBeats", () => {
  test("a tied note sustains instead of re-attacking", () => {
    // Quarter note C4 tied to a quarter note C4, then a quarter note D4.
    const xml = scoreXml(`
      <measure number="1">
        <attributes>
          <divisions>1</divisions>
          <time><beats>4</beats><beat-type>4</beat-type></time>
          <clef><sign>G</sign><line>2</line></clef>
        </attributes>
        <note>
          <pitch><step>C</step><octave>4</octave></pitch>
          <duration>1</duration>
          <type>quarter</type>
          <tie type="start"/>
          <notations><tied type="start"/></notations>
        </note>
        <note>
          <pitch><step>C</step><octave>4</octave></pitch>
          <duration>1</duration>
          <type>quarter</type>
          <tie type="stop"/>
          <notations><tied type="stop"/></notations>
        </note>
        <note>
          <pitch><step>D</step><octave>4</octave></pitch>
          <duration>1</duration>
          <type>quarter</type>
        </note>
        <note>
          <rest/>
          <duration>1</duration>
          <type>quarter</type>
        </note>
      </measure>
    `);
    const score = parseScore(xml);
    const steps = flattenBeats(score);

    // Only two onsets: the tied C (held 2 beats) and the D (held 1 beat to
    // the rest). The tie's continuation note must not produce its own onset.
    expect(steps).toHaveLength(2);
    expect(steps[0].notes).toHaveLength(1);
    expect(steps[0].notes[0].pitch.step).toBe("C");
    expect(steps[0].notes[0].durationBeats).toBe(2);
    expect(steps[1].notes).toHaveLength(1);
    expect(steps[1].notes[0].pitch.step).toBe("D");
  });

  test("an untied repeated note re-attacks normally", () => {
    const xml = scoreXml(`
      <measure number="1">
        <attributes>
          <divisions>1</divisions>
          <time><beats>4</beats><beat-type>4</beat-type></time>
          <clef><sign>G</sign><line>2</line></clef>
        </attributes>
        <note>
          <pitch><step>C</step><octave>4</octave></pitch>
          <duration>1</duration>
          <type>quarter</type>
        </note>
        <note>
          <pitch><step>C</step><octave>4</octave></pitch>
          <duration>1</duration>
          <type>quarter</type>
        </note>
      </measure>
    `);
    const score = parseScore(xml);
    const steps = flattenBeats(score);

    expect(steps).toHaveLength(2);
    expect(steps[0].notes[0].durationBeats).toBe(1);
    expect(steps[1].notes[0].durationBeats).toBe(1);
  });
});
