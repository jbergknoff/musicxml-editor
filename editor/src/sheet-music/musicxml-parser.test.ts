import { describe, expect, test } from "bun:test";
import { parseScore } from "./musicxml-parser";

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
