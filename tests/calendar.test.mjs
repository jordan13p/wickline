// node --test tests/  (calendar.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { closureOf, currentOpen, parseHolidays, rocDay, taipeiDay } from "../mods/wickline/calendar.js";
import { HOLIDAYS_2026, at } from "./helpers.mjs";

test("ROC dates become Taipei day numbers", () => {
  assert.equal(rocDay("1151225"), taipeiDay(at("2026-12-25T02:00:00Z")));
  assert.equal(rocDay("1150101"), taipeiDay(at("2026-01-01T02:00:00Z")));
  for (const bad of ["115-12-25", "", null, "1151332", "11512"]) assert.equal(rocDay(bad), null, String(bad));
});

test("the 2026 schedule: 27 rows, 18 closed weekdays; notices and weekend dates left out", () => {
  assert.equal(HOLIDAYS_2026.length, 27);
  const days = parseHolidays(JSON.stringify(HOLIDAYS_2026));
  assert.equal(Object.keys(days).length, 18);
  for (const notice of ["1150102", "1150211", "1150223"]) assert.equal(days[rocDay(notice)], undefined, notice);
  for (const weekend of ["1150215", "1150228", "1150404", "1150405", "1151010", "1151025"]) assert.equal(days[rocDay(weekend)], undefined, weekend);
  assert.equal(days[rocDay("1150212")], "市場無交易，僅辦理結算交割作業");
  assert.equal(days[rocDay("1150213")], "市場無交易，僅辦理結算交割作業");
  assert.equal(days[rocDay("1151225")], "行憲紀念日");
  assert.equal(days[rocDay("1150928")], "孔子誕辰紀念日/ 教師節");
  assert.equal(days[rocDay("1151009")], "國慶日");
});

// Rows in the OpenAPI shape, named as in TWSE's 2024 list.
test("a closure by any other name is a closure, as in 2024", () => {
  const days = parseHolidays(JSON.stringify([
    { Name: "市場無交易，僅辦理結算交割作業", Date: "1130206" }, { Name: "農曆除夕前一日", Date: "1130208" },
    { Name: "農曆春節後開始交易日", Date: "1130215" },
  ]));
  assert.deepEqual(Object.values(days), ["市場無交易，僅辦理結算交割作業", "農曆除夕前一日"]);
});

test("an unreadable schedule is none; a bad row is skipped", () => {
  assert.equal(parseHolidays("<html>blocked</html>"), null);
  assert.equal(parseHolidays("{}"), null);
  assert.deepEqual(parseHolidays("[]"), {});
  assert.deepEqual(parseHolidays(JSON.stringify([{ Name: "x", Date: "bad" }, { Date: "1151225" }, { Name: "", Date: "1151225" }])), {});
});

const L = parseHolidays(JSON.stringify(HOLIDAYS_2026));
const listed = (day) => L[day] ?? null;
const none = () => undefined;

test("a list for another year matches no date of this one", () => {
  assert.deepEqual(closureOf("stock", at("2027-01-01T02:00:00Z"), listed, none), {});
  const next = parseHolidays(JSON.stringify([{ Name: "中華民國開國紀念日", Date: "1160101" }]));
  assert.deepEqual(closureOf("stock", at("2026-12-25T02:00:00Z"), (day) => next[day] ?? null, none), {});
});

test("closureOf: listed weekdays, per market, with the trade override and the removed night", () => {
  const xmas = { closedDay: { reason: "行憲紀念日" } };
  const cases = [
    // [market, UTC now, seen, marks] (Taipei time in the comment)
    ["stock", "2026-12-25T02:00:00Z", none, xmas],                                        // Fri 12/25 10:00
    ["stock", "2026-12-24T16:00:00Z", none, xmas],                                        // 12/25 00:00
    ["stock", "2026-12-24T15:59:59Z", none, {}],                                          // 12/24 23:59:59
    ["stock", "2026-12-25T02:00:00Z", (market, open) => (market === "stock" && open === at("2026-12-25T01:00:00Z") ? { traded: true } : undefined), {}],
    ["stock", "2026-10-10T02:00:00Z", none, {}],                                          // Saturday 10/10, listed
    ["stock", "2026-02-12T02:00:00Z", none, { closedDay: { reason: "市場無交易，僅辦理結算交割作業" } }],
    ["stock", "2026-01-02T02:00:00Z", none, {}],                                          // a notice
    ["future", "2026-12-24T17:00:00Z", none, {}],                                         // 12/25 01:00, 12/24's night
    ["future", "2026-12-24T20:59:59Z", none, {}],                                         // 04:59:59
    ["future", "2026-12-24T21:00:00Z", none, xmas],                                       // 05:00
    ["future", "2026-12-25T07:30:00Z", none, xmas],                                       // 15:30
    ["future", "2026-12-25T18:00:00Z", none, { nightClosed: true }],                      // Sat 12/26 02:00
    ["future", "2026-12-25T22:00:00Z", none, {}],                                         // Sat 06:00
    ["future", "2026-10-25T16:30:00Z", none, { closedDay: { reason: "臺灣光復暨金門古寧頭大捷紀念日" } }], // Mon 10/26 00:30
    ["future", "2026-10-26T18:00:00Z", none, { nightClosed: true }],                      // Tue 10/27 02:00
    ["future", "2026-02-12T18:00:00Z", none, { closedDay: { reason: "市場無交易，僅辦理結算交割作業" } }], // Fri 2/13 02:00
    ["future", "2026-12-25T01:00:00Z", (market, open) => (market === "future" && open === at("2026-12-25T00:45:00Z") ? { traded: true } : undefined), {}],
    // The override covers the removed night: Sat 12/26 01:00, a trade seen since Fri 12/25 15:00.
    ["future", "2026-12-25T17:00:00Z", (market, open) => (market === "future" && open === at("2026-12-25T07:00:00Z") ? { traded: true } : undefined), {}],
    // A stock trade does not override a futures closure (the override is per market).
    ["future", "2026-12-25T02:00:00Z", (market) => (market === "stock" ? { traded: true } : undefined), xmas],
  ];
  for (const [market, iso, seen, marks] of cases) assert.deepEqual(closureOf(market, at(iso), listed, seen), marks, `${market} ${iso}`);
  assert.deepEqual([at("2026-11-11T00:44:59Z"), at("2026-11-11T00:45:00Z"), at("2026-11-11T07:00:00Z"), at("2026-11-10T20:00:00Z"), at("2026-11-14T02:00:00Z")]
    .map((now) => currentOpen("future", now)), [null, at("2026-11-11T00:45:00Z"), at("2026-11-11T07:00:00Z"), at("2026-11-10T07:00:00Z"), null]);
});
