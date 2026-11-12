// node --test tests/  (calendar.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import {
  INFER_DELAYED_MS, INFER_REALTIME_MS, INFER_RECENT_MS, closureOf, currentOpen, heldMarks, parseHolidays, rocDay,
  taipeiDay,
} from "../mods/wickline/calendar.js";
import { HOLIDAYS_2026, at, listed2026, observation } from "./helpers.mjs";

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

// A notice read as a closure hides a trading morning; a closure read as a notice falls back to inference, which shows.
test("a notice with spaces around it or a new wording is still a notice; a closure's name is trimmed", () => {
  const days = parseHolidays(JSON.stringify([
    { Name: "國曆新年開始交易日 ", Date: "1150102" }, { Name: "\u3000農曆春節前最後交易日", Date: "1150211" },
    { Name: "農曆春節後開始交易", Date: "1150223" }, { Name: "農曆春節前最後交易", Date: "1150210" },
    { Name: " 行憲紀念日 ", Date: "1151225" },
  ]));
  assert.deepEqual(days, { [rocDay("1151225")]: "行憲紀念日" });
});

test("an unreadable schedule is none; a bad row is skipped", () => {
  assert.equal(parseHolidays("<html>blocked</html>"), null);
  assert.equal(parseHolidays("{}"), null);
  assert.deepEqual(parseHolidays("[]"), {});
  assert.deepEqual(parseHolidays(JSON.stringify([{ Name: "x", Date: "bad" }, { Date: "1151225" }, { Name: "", Date: "1151225" }])), {});
});

const none = () => undefined;

test("a list for another year matches no date of this one", () => {
  assert.deepEqual(closureOf("stock", at("2027-01-01T02:00:00Z"), listed2026, none).closure, null);
  const next = parseHolidays(JSON.stringify([{ Name: "中華民國開國紀念日", Date: "1160101" }]));
  assert.deepEqual(closureOf("stock", at("2026-12-25T02:00:00Z"), (day) => next[day] ?? null, none).closure, null);
});

test("closureOf: listed weekdays, per market, with the trade override and the removed night", () => {
  const xmas = { kind: "listed", reason: "行憲紀念日" };
  const cases = [
    // [market, UTC now, seen, closure] (Taipei time in the comment)
    ["stock", "2026-12-25T02:00:00Z", none, xmas],                                        // Fri 12/25 10:00
    ["stock", "2026-12-24T16:00:00Z", none, xmas],                                        // 12/25 00:00
    ["stock", "2026-12-24T15:59:59Z", none, null],                                        // 12/24 23:59:59
    ["stock", "2026-12-25T02:00:00Z", (market, open) => (market === "stock" && open === at("2026-12-25T01:00:00Z") ? { traded: true } : undefined), null],
    ["stock", "2026-10-10T02:00:00Z", none, null],                                        // Saturday 10/10, listed
    ["stock", "2026-02-12T02:00:00Z", none, { kind: "listed", reason: "市場無交易，僅辦理結算交割作業" }],
    ["stock", "2026-01-02T02:00:00Z", none, null],                                        // a notice
    ["future", "2026-12-24T17:00:00Z", none, null],                                       // 12/25 01:00, 12/24's night
    ["future", "2026-12-24T20:59:59Z", none, null],                                       // 04:59:59
    ["future", "2026-12-24T21:00:00Z", none, xmas],                                       // 05:00
    ["future", "2026-12-25T07:30:00Z", none, xmas],                                       // 15:30
    ["future", "2026-12-25T18:00:00Z", none, { kind: "nightRemoved" }],                   // Sat 12/26 02:00
    ["future", "2026-12-25T22:00:00Z", none, null],                                       // Sat 06:00
    ["future", "2026-10-25T16:30:00Z", none, { kind: "listed", reason: "臺灣光復暨金門古寧頭大捷紀念日" }], // Mon 10/26 00:30
    ["future", "2026-10-26T18:00:00Z", none, { kind: "nightRemoved" }],                   // Tue 10/27 02:00
    ["future", "2026-02-12T18:00:00Z", none, { kind: "listed", reason: "市場無交易，僅辦理結算交割作業" }], // Fri 2/13 02:00
    ["future", "2026-12-25T01:00:00Z", (market, open) => (market === "future" && open === at("2026-12-25T00:45:00Z") ? { traded: true } : undefined), null],
    // The override covers the removed night: Sat 12/26 01:00, a trade seen since Fri 12/25 15:00.
    ["future", "2026-12-25T17:00:00Z", (market, open) => (market === "future" && open === at("2026-12-25T07:00:00Z") ? { traded: true } : undefined), null],
    // A stock trade does not override a futures closure (the override is per market).
    ["future", "2026-12-25T02:00:00Z", (market) => (market === "stock" ? { traded: true } : undefined), xmas],
  ];
  for (const [market, iso, seen, closure] of cases) assert.deepEqual(closureOf(market, at(iso), listed2026, seen).closure, closure, `${market} ${iso}`);
  assert.deepEqual([at("2026-11-11T00:44:59Z"), at("2026-11-11T00:45:00Z"), at("2026-11-11T07:00:00Z"), at("2026-11-10T20:00:00Z"), at("2026-11-14T02:00:00Z")]
    .map((now) => currentOpen("future", now)), [null, at("2026-11-11T00:45:00Z"), at("2026-11-11T07:00:00Z"), at("2026-11-10T07:00:00Z"), null]);
});

test("the inference's deadlines and recency", () => {
  assert.deepEqual([INFER_REALTIME_MS, INFER_DELAYED_MS, INFER_RECENT_MS], [600_000, 1_800_000, 120_000]);
});

test("closureOf infers per session from recent answers; a trade clears it; the other market vetoes; weekends never", () => {
  const T = { open: at("2026-11-11T01:00:00Z"), day: at("2026-11-11T00:45:00Z"), night: at("2026-11-11T07:00:00Z") }; // Wed 11/11
  const rt = (time) => [{ at: time, source: "yahootw" }];
  const yf = (time) => [{ at: time, source: "yahoo" }];
  const by = (entries) => (market, open) => entries[`${market} ${open}`];
  const stock = (o) => by({ [`stock ${T.open}`]: o });
  const quiet = (source = "yahootw") => ({ kind: "noTrades", source });
  const night = { kind: "nightNoTrades", source: "yahootw" };
  const cases = [
    // [market, now, seen, closure]
    ["stock", T.open + 599_999, stock(observation({ realtime: rt(T.open + 590_000) })), null],
    ["stock", T.open + 600_000, stock(observation({ realtime: rt(T.open + 480_000) })), quiet()],           // latest answer 09:08: counts
    ["stock", T.open + 600_000, stock(observation({ realtime: rt(T.open + 479_999) })), null],              // older than deadline − 2 min
    ["stock", T.open + 720_000, stock(observation({ realtime: rt(T.open + 3_000) })), null],                // one answer at 09:00:03 (I1)
    ["stock", T.open + 1_799_999, stock(observation({ delayed: yf(T.open + 1_790_000) })), null],
    ["stock", T.open + 1_800_000, stock(observation({ delayed: yf(T.open + 1_790_000) })), quiet("yahoo")],
    ["stock", T.open + 1_800_000, stock(observation({ traded: true, realtime: rt(T.open + 1_790_000) })), null],
    ["stock", at("2026-11-14T01:30:00Z"), () => observation({ realtime: rt(at("2026-11-14T01:29:00Z")) }), null],  // Saturday
    // The veto: a futures trade since 08:45 for stocks; a stock trade since 09:00 for the futures day session.
    ["stock", T.open + 600_000, by({ [`stock ${T.open}`]: observation({ realtime: rt(T.open + 590_000) }), [`future ${T.day}`]: observation({ traded: true }) }), null],
    ["future", T.day + 600_000, by({ [`future ${T.day}`]: observation({ realtime: rt(T.day + 590_000) }) }), quiet()],
    // A copy first shown after 15:00 has only the night's entry: a futures trade since 08:45 there vetoes too, a night
    // trade (15:19) or the day's carried by the night's answers (13:45).
    ["stock", T.night + 1_200_000, by({ [`stock ${T.open}`]: observation({ realtime: rt(T.night + 1_190_000) }),
      [`future ${T.night}`]: observation({ traded: true, newest: T.night + 1_140_000, realtime: rt(T.night + 1_190_000) }) }), null],
    ["stock", T.night + 1_200_000, by({ [`stock ${T.open}`]: observation({ realtime: rt(T.night + 1_190_000) }),
      [`future ${T.night}`]: observation({ newest: at("2026-11-11T05:45:00Z"), realtime: rt(T.night + 1_190_000) }) }), null],
    ["stock", T.night + 1_200_000, by({ [`stock ${T.open}`]: observation({ realtime: rt(T.night + 1_190_000) }),
      [`future ${T.night}`]: observation({ newest: at("2026-11-10T20:59:00Z"), realtime: rt(T.night + 1_190_000) }) }), quiet()],
    ["future", T.open + 60_000, by({ [`future ${T.day}`]: observation({ realtime: rt(T.open + 50_000) }), [`stock ${T.open}`]: observation({ traded: true }) }), null],
    // The night: skipped after a traded day; the whole day when nothing traded, read from the answers' newest trade (choice 5).
    ["future", T.night + 600_000, by({ [`future ${T.night}`]: observation({ newest: at("2026-11-11T05:45:00Z"), realtime: rt(T.night + 590_000) }) }), night],
    ["future", T.night + 600_000, by({ [`future ${T.night}`]: observation({ newest: at("2026-11-10T20:59:00Z"), realtime: rt(T.night + 590_000) }) }), quiet()],
    ["future", T.night + 600_000, by({ [`future ${T.night}`]: observation({ newest: at("2026-11-10T20:59:00Z"), realtime: rt(T.night + 590_000) }),
      [`stock ${T.open}`]: observation({ traded: true }) }), night],
    // After midnight (choice 4): Thu 11/12 02:00, the night of 11/11 without trades.
    ["future", at("2026-11-11T18:00:00Z"), by({ [`future ${T.night}`]: observation({ newest: at("2026-11-11T05:45:00Z"), realtime: rt(at("2026-11-11T17:59:00Z")) }) }), night],
    // A futures day without trades (review 2, M4 and M5): carried from 15:00 to the night's deadline unless a stock
    // traded, kept after midnight, gone at 05:00.
    ["future", T.night + 30_000, by({ [`future ${T.day}`]: observation({ realtime: rt(T.night - 10_000) }) }), quiet()],
    ["future", T.night + 30_000, by({ [`future ${T.day}`]: observation({ realtime: rt(T.night - 10_000) }), [`stock ${T.open}`]: observation({ traded: true }) }), null],
    // The night's source answers once at 15:00:05 and then goes quiet: the day's reading is carried only until the
    // night's deadline (15:10), then the existing reading stands, as for any source that does not answer.
    ...[[T.night + 300_000, quiet()], [T.night + 600_001, null], [at("2026-11-11T12:00:00Z"), null]].map(([now, closure]) => ["future", now,
      by({ [`future ${T.day}`]: observation({ realtime: rt(T.night - 10_000) }),
        [`future ${T.night}`]: observation({ newest: at("2026-11-10T20:59:00Z"), realtime: rt(T.night + 5_000) }) }), closure]),
    ["future", at("2026-11-11T18:00:00Z"), by({ [`future ${T.night}`]: observation({ newest: at("2026-11-10T20:59:00Z"), realtime: rt(at("2026-11-11T17:59:00Z")) }) }), quiet()],
    ["future", at("2026-11-11T21:00:00Z"), by({ [`future ${T.night}`]: observation({ newest: at("2026-11-10T20:59:00Z"), realtime: rt(at("2026-11-11T20:59:00Z")) }) }), null],
    // The fixed source order names the closure (review 2, M3): both real-time sources recent, Yahoo 奇摩股市; only
    // MIS recent, MIS; a real-time answer before a delayed one.
    ["stock", T.open + 600_000, stock(observation({ realtime: [{ at: T.open + 590_000, source: "yahootw" }, { at: T.open + 595_000, source: "mis" }] })), quiet()],
    ["stock", T.open + 600_000, stock(observation({ realtime: [{ at: T.open + 300_000, source: "yahootw" }, { at: T.open + 595_000, source: "mis" }] })), quiet("mis")],
    ["stock", T.open + 1_800_000, stock(observation({ realtime: rt(T.open + 1_790_000), delayed: yf(T.open + 1_790_000) })), quiet()],
    // A night TAIFEX does not hold (Wed 2/11, a notice; choice 18's cost): the night form at 15:10, then the listed
    // 2/12 from midnight.
    ["future", at("2026-02-11T07:10:00Z"), by({ [`future ${at("2026-02-11T07:00:00Z")}`]: observation({ newest: at("2026-02-11T05:45:00Z"), realtime: rt(at("2026-02-11T07:09:00Z")) }) }), night],
    ["future", at("2026-02-11T16:30:00Z"), by({ [`future ${at("2026-02-11T07:00:00Z")}`]: observation({ newest: at("2026-02-11T05:45:00Z"), realtime: rt(at("2026-02-11T16:29:00Z")) }) }),
      { kind: "listed", reason: "市場無交易，僅辦理結算交割作業" }],
  ];
  for (const [market, now, seen, closure] of cases) assert.deepEqual(closureOf(market, now, listed2026, seen).closure, closure, `${market} ${new Date(now).toISOString()}`);
  const both = stock(observation({ realtime: rt(T.open + 300_000), delayed: yf(T.open + 300_000) }));
  const deadline = (now, seen) => closureOf("stock", now, listed2026, seen).deadline;
  assert.deepEqual([deadline(T.open + 300_000, both), deadline(T.open + 700_000, both),
    deadline(T.open + 300_000, stock(observation({ traded: true, realtime: rt(T.open) }))), deadline(T.open + 300_000, () => undefined)],
    [T.open + 600_000, T.open + 1_800_000, null, null]);
});

// Wednesday 11/11, unlisted: the day session (08:45) answered quietly until 14:59:50 (an answer after 15:00 is filed
// under the night's open), no stock traded.
const QUIET_DAY = { dayOpen: at("2026-11-11T00:45:00Z"), nightOpen: at("2026-11-11T07:00:00Z") };
const quietDayAnswers = (nightAnswer) => (market, open) => {
  if (market !== "future") return undefined;
  if (open === QUIET_DAY.dayOpen) return observation({ realtime: [{ at: at("2026-11-11T06:59:50Z"), source: "yahootw" }] });
  if (open === QUIET_DAY.nightOpen && nightAnswer) return observation({ realtime: [{ at: nightAnswer, source: "yahootw" }] });
  return undefined;
};

test("a quiet futures day with no night answer: 今日無成交 until 15:10:00, announced as a deadline", () => {
  const read = (iso) => closureOf("future", at(iso), () => null, quietDayAnswers(null));
  const cap = at("2026-11-11T07:10:00Z");
  assert.deepEqual(read("2026-11-11T07:05:00Z"), { closure: { kind: "noTrades", source: "yahootw" }, deadline: cap, until: cap });
  assert.deepEqual(read("2026-11-11T07:09:59Z").closure, { kind: "noTrades", source: "yahootw" });
  assert.deepEqual(read("2026-11-11T07:10:00Z"), { closure: null, deadline: null, until: null });
});

test("with a night answer the 15:10 deadline is as before", () => {
  const seen = quietDayAnswers(at("2026-11-11T07:00:30Z"));
  assert.equal(closureOf("future", at("2026-11-11T07:05:00Z"), () => null, seen).deadline, at("2026-11-11T07:10:00Z"));
});

// Each mark read at a moment and when it stops holding without a new answer, from the schedule and the answers each
// row of closureRule reads (Wed 11/11 unlisted, Fri 12/25 listed).
test("closureOf: when each mark read at a moment stops holding", () => {
  const T = { day: at("2026-11-11T00:45:00Z"), night: at("2026-11-11T07:00:00Z"), stock: at("2026-11-11T01:00:00Z") };
  const rt = (time) => ({ realtime: [{ at: time, source: "yahootw" }] });
  const by = (entries) => (market, open) => entries[`${market} ${open}`];
  const tradedDay = { newest: at("2026-11-11T05:45:00Z") };
  const cases = [
    // [market, now, seen, kind, until] (Taipei time in the comment)
    ["stock", "2026-11-11T02:00:00Z", by({ [`stock ${T.stock}`]: observation(rt(at("2026-11-11T01:59:00Z"))) }), "noTrades",
      "2026-11-11T16:00:00Z"],                                                                   // 10:00 → 00:00
    ["stock", "2026-12-24T17:00:00Z", none, "listed", "2026-12-25T16:00:00Z"],                    // 12/25 01:00 → 12/26 00:00
    // A future's listed mark holds through the night the listed day removes, read from 05:00 (row 6) or before (rows 3–5).
    ["future", "2026-12-24T22:00:00Z", none, "listed", "2026-12-25T21:00:00Z"],                   // 12/25 06:00 → 12/26 05:00
    ["future", "2026-12-24T18:00:00Z", by({ [`future ${at("2026-12-24T07:00:00Z")}`]: observation(rt(at("2026-12-24T17:59:00Z"))) }),
      "listed", "2026-12-25T21:00:00Z"],                                                         // 12/25 02:00 → 12/26 05:00
    ["future", "2026-11-11T18:00:00Z", by({ [`future ${T.night}`]: observation({ ...tradedDay, ...rt(at("2026-11-11T17:59:00Z")) }) }),
      "nightNoTrades", "2026-11-11T21:00:00Z"],                                                  // 02:00 → 05:00
    ["future", "2026-12-25T18:00:00Z", none, "nightRemoved", "2026-12-25T21:00:00Z"],              // Sat 12/26 02:00 → 05:00
    ["future", "2026-11-11T02:00:00Z", by({ [`future ${T.day}`]: observation(rt(at("2026-11-11T01:59:00Z"))) }), "noTrades",
      "2026-11-11T07:10:00Z"],                                                                   // 10:00 (row 7) → 15:10
    ["future", "2026-11-11T07:05:00Z", quietDayAnswers(null), "noTrades", "2026-11-11T07:10:00Z"], // 15:05 (row 8b) → 15:10
    ["future", "2026-11-11T08:00:00Z", by({ [`future ${T.night}`]: observation(rt(at("2026-11-11T07:59:00Z"))) }), "noTrades",
      "2026-11-11T21:00:00Z"],                                                                   // 16:00 (row 8) → 05:00
    ["future", "2026-11-11T08:00:00Z", by({ [`future ${T.night}`]: observation({ ...tradedDay, ...rt(at("2026-11-11T07:59:00Z")) }) }),
      "nightNoTrades", "2026-11-11T21:00:00Z"],
  ];
  for (const [market, now, seen, kind, until] of cases) {
    const reading = closureOf(market, at(now), listed2026, seen);
    assert.deepEqual([reading.closure?.kind, reading.until], [kind, at(until)], `${market} ${kind} ${now}`);
  }
  assert.equal(closureOf("stock", at("2026-11-11T02:00:00Z"), listed2026, none).until, null);
});

test("heldMarks keeps a mark 1 ms before its end and drops it at the end", () => {
  const end = at("2026-11-11T21:00:00Z");
  const q = { symbol: "WTX&", closure: { kind: "nightNoTrades", source: "yahootw" }, closureDeadline: 1, closureUntil: end };
  assert.equal(heldMarks(q, end - 1), q);
  const dropped = heldMarks(q, end);
  assert.deepEqual([dropped.closure, dropped.closureUntil, "closureDeadline" in dropped], [null, null, false]);
  const plain = { symbol: "AAPL" };
  assert.equal(heldMarks(plain, end), plain);                                     // a quote with no mark end is kept as it is
});
