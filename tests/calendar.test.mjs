// node --test tests/  (calendar.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  INFER_DELAYED_MS, INFER_REALTIME_MS, INFER_RECENT_MS, closureOf, currentOpen, deadlineOf, parseHolidays, rocDay, taipeiDay,
} from "../mods/wickline/calendar.js";
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

test("the inference's deadlines and recency", () => {
  assert.deepEqual([INFER_REALTIME_MS, INFER_DELAYED_MS, INFER_RECENT_MS], [600_000, 1_800_000, 120_000]);
});

test("closureOf infers per session from recent answers; a trade clears it; the other market vetoes; weekends never", () => {
  const T = { open: at("2026-11-11T01:00:00Z"), day: at("2026-11-11T00:45:00Z"), night: at("2026-11-11T07:00:00Z") }; // Wed 11/11
  const obs = (fields) => ({ traded: false, newest: null, realtime: [], delayed: [], ...fields });
  const rt = (time) => [{ at: time, source: "yahootw" }];
  const yf = (time) => [{ at: time, source: "yahoo" }];
  const by = (entries) => (market, open) => entries[`${market} ${open}`];
  const stock = (o) => by({ [`stock ${T.open}`]: o });
  const quiet = (source = "yahootw") => ({ noTrades: { source } });
  const night = { nightClosed: true, noTrades: { source: "yahootw", night: true } };
  const cases = [
    // [market, now, seen, marks]
    ["stock", T.open + 599_999, stock(obs({ realtime: rt(T.open + 590_000) })), {}],
    ["stock", T.open + 600_000, stock(obs({ realtime: rt(T.open + 480_000) })), quiet()],           // latest answer 09:08: counts
    ["stock", T.open + 600_000, stock(obs({ realtime: rt(T.open + 479_999) })), {}],                // older than deadline − 2 min
    ["stock", T.open + 720_000, stock(obs({ realtime: rt(T.open + 3_000) })), {}],                  // one answer at 09:00:03 (I1)
    ["stock", T.open + 1_799_999, stock(obs({ delayed: yf(T.open + 1_790_000) })), {}],
    ["stock", T.open + 1_800_000, stock(obs({ delayed: yf(T.open + 1_790_000) })), quiet("yahoo")],
    ["stock", T.open + 1_800_000, stock(obs({ traded: true, realtime: rt(T.open + 1_790_000) })), {}],
    ["stock", at("2026-11-14T01:30:00Z"), () => obs({ realtime: rt(at("2026-11-14T01:29:00Z")) }), {}],   // Saturday
    // The veto: a futures trade since 08:45 for stocks; a stock trade since 09:00 for the futures day session.
    ["stock", T.open + 600_000, by({ [`stock ${T.open}`]: obs({ realtime: rt(T.open + 590_000) }), [`future ${T.day}`]: obs({ traded: true }) }), {}],
    ["future", T.day + 600_000, by({ [`future ${T.day}`]: obs({ realtime: rt(T.day + 590_000) }) }), quiet()],
    ["future", T.open + 60_000, by({ [`future ${T.day}`]: obs({ realtime: rt(T.open + 50_000) }), [`stock ${T.open}`]: obs({ traded: true }) }), {}],
    // The night: skipped after a traded day; the whole day when nothing traded, read from the answers' newest trade (choice 5).
    ["future", T.night + 600_000, by({ [`future ${T.night}`]: obs({ newest: at("2026-11-11T05:45:00Z"), realtime: rt(T.night + 590_000) }) }), night],
    ["future", T.night + 600_000, by({ [`future ${T.night}`]: obs({ newest: at("2026-11-10T20:59:00Z"), realtime: rt(T.night + 590_000) }) }), quiet()],
    ["future", T.night + 600_000, by({ [`future ${T.night}`]: obs({ newest: at("2026-11-10T20:59:00Z"), realtime: rt(T.night + 590_000) }),
      [`stock ${T.open}`]: obs({ traded: true }) }), night],
    // After midnight (choice 4): Thu 11/12 02:00, the night of 11/11 without trades.
    ["future", at("2026-11-11T18:00:00Z"), by({ [`future ${T.night}`]: obs({ newest: at("2026-11-11T05:45:00Z"), realtime: rt(at("2026-11-11T17:59:00Z")) }) }), night],
    // A futures day without trades (review 2, M4 and M5): carried from 15:00 to the night's deadline unless a stock
    // traded, kept after midnight, gone at 05:00.
    ["future", T.night + 30_000, by({ [`future ${T.day}`]: obs({ realtime: rt(T.night - 10_000) }) }), quiet()],
    ["future", T.night + 30_000, by({ [`future ${T.day}`]: obs({ realtime: rt(T.night - 10_000) }), [`stock ${T.open}`]: obs({ traded: true }) }), {}],
    ["future", at("2026-11-11T18:00:00Z"), by({ [`future ${T.night}`]: obs({ newest: at("2026-11-10T20:59:00Z"), realtime: rt(at("2026-11-11T17:59:00Z")) }) }), quiet()],
    ["future", at("2026-11-11T21:00:00Z"), by({ [`future ${T.night}`]: obs({ newest: at("2026-11-10T20:59:00Z"), realtime: rt(at("2026-11-11T20:59:00Z")) }) }), {}],
    // The fixed source order names the closure (review 2, M3): both real-time sources recent, Yahoo 奇摩股市; only
    // MIS recent, MIS; a real-time answer before a delayed one.
    ["stock", T.open + 600_000, stock(obs({ realtime: [{ at: T.open + 590_000, source: "yahootw" }, { at: T.open + 595_000, source: "mis" }] })), quiet()],
    ["stock", T.open + 600_000, stock(obs({ realtime: [{ at: T.open + 300_000, source: "yahootw" }, { at: T.open + 595_000, source: "mis" }] })), quiet("mis")],
    ["stock", T.open + 1_800_000, stock(obs({ realtime: rt(T.open + 1_790_000), delayed: yf(T.open + 1_790_000) })), quiet()],
    // A night TAIFEX does not hold (Wed 2/11, a notice; choice 18's cost): the night form at 15:10, then the listed
    // 2/12 from midnight.
    ["future", at("2026-02-11T07:10:00Z"), by({ [`future ${at("2026-02-11T07:00:00Z")}`]: obs({ newest: at("2026-02-11T05:45:00Z"), realtime: rt(at("2026-02-11T07:09:00Z")) }) }), night],
    ["future", at("2026-02-11T16:30:00Z"), by({ [`future ${at("2026-02-11T07:00:00Z")}`]: obs({ newest: at("2026-02-11T05:45:00Z"), realtime: rt(at("2026-02-11T16:29:00Z")) }) }),
      { closedDay: { reason: "市場無交易，僅辦理結算交割作業" } }],
  ];
  for (const [market, now, seen, marks] of cases) assert.deepEqual(closureOf(market, now, listed, seen), marks, `${market} ${new Date(now).toISOString()}`);
  const both = stock(obs({ realtime: rt(T.open + 300_000), delayed: yf(T.open + 300_000) }));
  assert.deepEqual([deadlineOf("stock", T.open + 300_000, both), deadlineOf("stock", T.open + 700_000, both),
    deadlineOf("stock", T.open + 300_000, stock(obs({ traded: true, realtime: rt(T.open) }))), deadlineOf("stock", T.open + 300_000, () => undefined)],
    [T.open + 600_000, T.open + 1_800_000, null, null]);
});
