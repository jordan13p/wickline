// node --test tests/  (calendar.js imports nothing from Herdr)
import test from "node:test";
import assert from "node:assert/strict";
import { parseHolidays, rocDay, taipeiDay } from "../mods/wickline/calendar.js";
import { closureOf } from "../mods/wickline/closures.js";
import { HOLIDAYS_2026, at, listed2026 } from "./helpers.mjs";

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
  for (const weekend of ["1150215", "1150228", "1150404", "1150405", "1151010", "1151025"])
    assert.equal(days[rocDay(weekend)], undefined, weekend);
  assert.equal(days[rocDay("1150212")], "市場無交易，僅辦理結算交割作業");
  assert.equal(days[rocDay("1150213")], "市場無交易，僅辦理結算交割作業");
  assert.equal(days[rocDay("1151225")], "行憲紀念日");
  assert.equal(days[rocDay("1150928")], "孔子誕辰紀念日/ 教師節");
  assert.equal(days[rocDay("1151009")], "國慶日");
});

// Rows in the OpenAPI shape, named as in TWSE's 2024 list.
test("a closure by any other name is a closure, as in 2024", () => {
  const days = parseHolidays(
    JSON.stringify([
      { Name: "市場無交易，僅辦理結算交割作業", Date: "1130206" },
      { Name: "農曆除夕前一日", Date: "1130208" },
      { Name: "農曆春節後開始交易日", Date: "1130215" },
    ]),
  );
  assert.deepEqual(Object.values(days), ["市場無交易，僅辦理結算交割作業", "農曆除夕前一日"]);
});

// A notice read as a closure hides a trading morning; a closure read as a notice falls back to inference, which shows.
test("a notice with spaces around it or a new wording is still a notice; a closure's name is trimmed", () => {
  const days = parseHolidays(
    JSON.stringify([
      { Name: "國曆新年開始交易日 ", Date: "1150102" },
      { Name: "\u3000農曆春節前最後交易日", Date: "1150211" },
      { Name: "農曆春節後開始交易", Date: "1150223" },
      { Name: "農曆春節前最後交易", Date: "1150210" },
      { Name: " 行憲紀念日 ", Date: "1151225" },
    ]),
  );
  assert.deepEqual(days, { [rocDay("1151225")]: "行憲紀念日" });
});

test("an unreadable schedule is none; a bad row is skipped", () => {
  assert.equal(parseHolidays("<html>blocked</html>"), null);
  assert.equal(parseHolidays("{}"), null);
  assert.deepEqual(parseHolidays("[]"), {});
  assert.deepEqual(
    parseHolidays(JSON.stringify([{ Name: "x", Date: "bad" }, { Date: "1151225" }, { Name: "", Date: "1151225" }])),
    {},
  );
});

const none = () => undefined;

test("a list for another year matches no date of this one", () => {
  assert.deepEqual(closureOf("stock", at("2027-01-01T02:00:00Z"), listed2026, none).closure, null);
  const next = parseHolidays(JSON.stringify([{ Name: "中華民國開國紀念日", Date: "1160101" }]));
  assert.deepEqual(closureOf("stock", at("2026-12-25T02:00:00Z"), (day) => next[day] ?? null, none).closure, null);
});
