// The metric panels for one horizon: headline, heatmap and line chart for each metric.

import { AXIS_INK, EMPTY, GRANULARITIES, LINE_STEP, PALETTES, PHONE_PAN, RACE, RUN_LINE, RUN_COLUMN_STEP, RUN_TYPES, STRENGTH, STRENGTH_HOUR_AS_DISTANCE, LINE_TWO_COLUMN_MAX_POINTS, TWO_COLUMN_MAX_WEEKS } from "./config.js";
import { daysBetween, iso, parseDay, shortDate } from "./dates.js";
import { clock, compact, distance, fixed, hm, hours, pace, signed, tick } from "./format.js";
import { heatGrid, heatLegend, heatmap, swatchLegend, weekCount } from "./heatmap.js";
import { lineChart, lineLegend } from "./linechart.js";
import { hiddenSeries } from "./series.js";
import { axisTicks, bucketed, fsum as sum, periodSpans, quantileEdges } from "./stats.js";

const mean = (obj) => { const v = Object.values(obj); return v.length ? sum(v) / v.length : null; };
const PERIOD_DAYS = { weekly: 7, monthly: 365.25 / 12, yearly: 365.25 }; // for the run headline's per-period average
const REST = { w: "Rest week", m: "Rest month", y: "Rest year" }; // run tooltip for a bucket with no training

/**
 * One metric: shared headline, then both chart variants (CSS shows the one for the current mode).
 * chart names the line chart so its hidden series are remembered across horizons (see series.js).
 * aside: optional [value, label], a secondary stat at the right end of the headline. heatChart: the same for the
 * heatmap, when its legend can hide series.
 */
function panel(chart, big, unit, note, heat, line, aside = null, heatChart = null) {
  const noteHtml = note ? ` <span class="note">${note}</span>` : "";
  const asideHtml = aside ? `<span class="aside"><span class="aside-value">${aside[0]}</span> ${aside[1]}</span>` : "";
  return (
    `<section><h2><span class="head"><span class="big">${big}</span> <span class="unit">${unit}</span>${noteHtml}</span>` +
    `${asideHtml}</h2><div class="readout"></div>` + // the active point's value in this panel (tooltip.js)
    `<div class="heat"${heatChart ? ` data-m="${heatChart}"` : ""}>${heat}</div><div class="line" data-m="${chart}">${line}</div></section>`
  );
}

/**
 * Axes for the stacked run/strength columns: one shared scale, with an hour of strength drawn as tall as
 * `perHour` of distance. Distance ticks every `step`, up to the first multiple above the tallest stack.
 */
function stackedTicks(run, strength, perHour, step) {
  const tallest = Math.max(0, ...run.map((r, i) => r + strength[i] * perHour));
  const top = Math.max(step, Math.ceil(tallest / step - 1e-9) * step);
  const distance = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  return [distance, distance.map((d) => d / perHour)];
}

const TYPE_LABEL = Object.fromEntries(RUN_TYPES.map((t) => [t.key, t.label]));
const TYPE_COLOR = Object.fromEntries(RUN_TYPES.map((t) => [t.key, t.color]));

/**
 * Hover text for one day of training, shared by the run heatmap and the daily columns: {tip, sum}.
 * tip: the runs on one line ("10 km Tempo · 5 km Base", a race as "21.1 km Race"), strength on the next
 * ("1.1h Strength"), then the race details; "Rest day" if nothing happened. sum: runs and strength on one line,
 * for the panel's readout (tooltip.js).
 */
function runDayTip(runs, strengthMins, raceText, du) {
  const did = [runs.map((r) => `${distance(r.distance, du)} ${r.race ? "Race" : TYPE_LABEL[r.type]}`).join(" · "),
               strengthMins > 0 && `${hours(strengthMins / 60)} Strength`].filter(Boolean);
  return {
    tip: [did.join("\n") || "Rest day", ...(raceText ? [raceText] : [])].join("\n"),
    sum: did.join(" · ") || "Rest day",
  };
}

/** Race tooltip text for each race day: name, then distance and time, one race after another. */
function raceTips(races, du) {
  return Object.fromEntries(Object.entries(races).map(([day, list]) => [
    day, list.map((r) => `${r.name}\n${distance(r.distance, du)} in ${clock(r.duration)}`).join("\n"),
  ]));
}

/** Bucket index -> race tooltips, for the buckets of `spans` that contain a race day. */
function raceBucketsOf(spans, races) {
  const buckets = new Map();
  for (const [day, text] of Object.entries(races)) {
    const date = parseDay(day);
    spans.forEach(([ws, we], i) => {
      if (ws <= date && date <= we) buckets.set(i, [...(buckets.get(i) || []), text]);
    });
  }
  return buckets;
}

/**
 * HTML for one horizon. `d` is the API's /api/days response for [start, end] (see main.js).
 * Options: `granularity`, the line charts' bucket (a GRANULARITIES key; buckets are calendar periods, see
 * stats.periodSpans); `keepPartialFirst` keeps a partial first bucket, starting at `start` (YTD), instead of
 * dropping it; `heat: false` leaves the heatmaps out (line-only horizons); `panelWidth`, the px width a panel is
 * displayed at in the current mode, which charts are drawn at; `phone`, whether full-width line charts should be
 * drawn wider and pan.
 * Daily buckets draw the run chart as stacked columns (each run coloured by type, races in their own colour with a
 * star, strength on top); the other granularities draw it as run and strength lines.
 */
export function renderPanels(start, end, d,
                             { granularity = "w", keepPartialFirst = false, heat = true, panelWidth = 500, phone = false } = {}) {
  const dailyLines = granularity === "d";
  const gran = GRANULARITIES.find((g) => g.key === granularity);
  const m = d.metrics;
  const du = d.units.distance;
  const wu = d.units.weight;
  const races = raceTips(d.races, du);
  const weeksInRange = (daysBetween(start, end) + 1) / 7;
  // panel layout, chosen separately per mode (CSS applies the current one): heatmaps by weeks, line charts by points
  const heatLayout = weekCount(start, end) <= TWO_COLUMN_MAX_WEEKS ? "two-col" : "stacked";

  const sleepEdges = [60, 70, 80, 90];
  const hrvEdges = quantileEdges(Object.values(m.hrv));
  const rhrEdges = quantileEdges(Object.values(m.rhr));
  const rhrPalette = [...PALETTES.red].reverse(); // a lower resting HR is the more prominent colour (darker, or brighter in dark mode), so it reads as better

  const runTotal = sum(Object.values(m.run_dist));
  const runWeek = runTotal / weeksInRange;
  // per-period run average over the whole range: weekly in heatmap mode, the granularity's period in line mode
  const runPer = (per) => runTotal / ((daysBetween(start, end) + 1) / PERIOD_DAYS[per]);
  const [lineBig, linePer] = [distance(runPer(gran.per), du), gran.per];
  const byMode = (heatHtml, lineHtml) => (heatHtml === lineHtml ? heatHtml
    : `<span class="for-heat">${heatHtml}</span><span class="for-line">${lineHtml}</span>`);
  const avgSleep = mean(m.sleep_secs) || 0;
  const avgScore = mean(m.sleep_score);
  const hrvAvg = mean(m.hrv) || 0;
  const rhrAvg = mean(m.rhr) || 0;

  const weighDays = Object.keys(m.weight).sort();
  const weightEdges = quantileEdges(Object.values(m.weight), 5, 0.1); // fine step so the top edge stays within the data
  // a day without its own weigh-in shows the last one (carried forward by the API): say when that was, on a
  // tooltip line of its own, so the panel's readout (a tip's first line, see tooltip.js) stays one short line
  const lastWeighed = (day) => {
    const on = (m.weighed_on || {})[day];
    return on && on !== day ? `as of ${shortDate(parseDay(on))}` : "";
  };
  let weightBig = `— ${wu}`, weightNote = "";
  if (weighDays.length) {
    const latestDay = weighDays[weighDays.length - 1];
    const latest = m.weight[latestDay];
    weightBig = `${fixed(latest, 1)} ${wu}`;
    const change = latest - m.weight[weighDays[0]];
    const fatDays = Object.keys(m.body_fat).sort();
    const fatChange = fatDays.length && m.body_fat[fatDays[fatDays.length - 1]] - m.body_fat[fatDays[0]];
    weightNote = `(${signed(change, 1)} ${wu}` + (fatDays.length ? ` · ${signed(fatChange, 1)}% fat)` : ")"); // over range
  }

  // per-bucket series for the line view: one point per calendar day, week, month or year
  const spans = periodSpans(start, end, granularity, keepPartialFirst);
  const lineLayout = spans.length <= LINE_TWO_COLUMN_MAX_POINTS ? "two-col" : "stacked";
  const chartWidth = lineLayout === "stacked" && phone ? panelWidth * PHONE_PAN : panelWidth; // pans on phones
  const avg = dailyLines ? "" : " avg"; // a daily point is a single reading, not an average
  const legendName = dailyLines ? "Daily" : `${gran.name} average`;
  const runW = bucketed(spans, m.run_dist, "sum");
  const strengthW = bucketed(spans, m.strength_mins, "sum").map((mins) => mins / 60); // hours
  const sleepW = bucketed(spans, Object.fromEntries(Object.entries(m.sleep_secs).map(([k, v]) => [k, v / 3600])), "mean");
  const scoreW = bucketed(spans, m.sleep_score, "mean");
  const hrvW = bucketed(spans, m.hrv, "mean");
  const rhrW = bucketed(spans, m.rhr, "mean");
  const weightW = bucketed(spans, m.weight, "mean");
  const fatW = bucketed(spans, m.body_fat, "mean");
  const raceBuckets = raceBucketsOf(spans, races);

  const runChart = dailyLines ? "run-types" : "run"; // separate legend memory: the series differ
  let runLine, runLegend;
  if (dailyLines) {
    // one column series per run type (stacked in RUN_TYPES order), then races, then strength on top
    const dayRuns = spans.map(([day]) => d.runs[iso(day)] || []);
    const distanceOf = (keep) => dayRuns.map((rs) => sum(rs.filter(keep).map((r) => r.distance)));
    const byType = RUN_TYPES.map((t) => distanceOf((r) => !r.race && r.type === t.key));
    const raceDist = distanceOf((r) => r.race);
    const dayTips = dayRuns.map((rs, i) => runDayTip(rs, strengthW[i] * 60, (raceBuckets.get(i) || []).join("\n"), du));
    const [distTicks, hourTicks] = stackedTicks(runW, strengthW, STRENGTH_HOUR_AS_DISTANCE[du], RUN_COLUMN_STEP);
    runLine = lineChart(
      spans, chartWidth,
      [
        ...RUN_TYPES.map((t, j) => ({ key: t.key, values: byType[j], color: t.color, ticks: distTicks, tickFmt: tick,
                                      bar: true, axisColor: AXIS_INK })), // the distance axis measures every run type
        { key: "race", values: raceDist, color: RACE, ticks: distTicks, tickFmt: tick, bar: true },
        { key: "strength", values: strengthW, color: STRENGTH, ticks: hourTicks, tickFmt: (t) => `${tick(t)}h`,
          right: true, bar: true, axisColor: AXIS_INK },
      ],
      dayTips.map((t) => t.tip),
      { unit: "d", sums: dayTips.map((t) => t.sum), stars: [...raceBuckets.keys()], starKey: "race",
        hidden: hiddenSeries(runChart) }, // the Race toggle hides column and star
    );
    runLegend = lineLegend( // strength first, then run types, then race, so race sits next to the runs
      ["Strength", STRENGTH, "bar", "strength"],
      ...RUN_TYPES.map((t) => [t.label, t.color, "bar", t.key]),
      ["Race", "star", null, "race"],
    );
  } else {
    // run distance and strength hours per week, month or year, with a star on buckets holding a race
    const runTicks = axisTicks(runW, true, null, 1);
    runLine = lineChart(
      spans, chartWidth,
      [
        { values: runW, color: RUN_LINE, ticks: runTicks, tickFmt: tick },
        { values: strengthW, color: STRENGTH, ticks: axisTicks(strengthW, true, runTicks.length, 1),
          tickFmt: (t) => `${tick(t)}h`, right: true, axisColor: AXIS_INK },
      ],
      runW.map((r, i) => { // only what happened: run, strength, both, or a rest week/month/year
        const did = [r > 0 && `${distance(r, du)} run`, strengthW[i] > 0 && `${hours(strengthW[i])} strength`];
        return [did.filter(Boolean).join(" · ") || REST[granularity], ...(raceBuckets.get(i) || [])].join("\n");
      }),
      // the stars mark points on the run line, so they share its key: they show and hide with it
      { unit: granularity, stars: [...raceBuckets.keys()], starKey: "s0" },
    );
    runLegend = lineLegend( // strength first, so race sits next to run; Run and Race are one toggle (both "s0")
      ["Strength", STRENGTH, null, 1], ["Run", RUN_LINE, null, 0], ["Race", "star", null, "s0"],
    );
  }

  const meanLine = (values, color, tipFmt) => lineChart(
    spans, chartWidth,
    [{ values, color, ticks: axisTicks(values, false), tickFmt: compact }],
    values.map((v) => (v !== null ? tipFmt(v) : "—")),
    { unit: granularity },
  );

  const joinTip = (...parts) => parts.filter(Boolean).join(" · ") || "—";

  const sleepTicks = axisTicks(sleepW, false);
  const sleepLine = lineChart(
    spans, chartWidth,
    [
      { values: sleepW, color: PALETTES.purple[LINE_STEP], ticks: sleepTicks, tickFmt: (t) => `${compact(t)}h` },
      { values: scoreW, color: PALETTES.orange[LINE_STEP], ticks: axisTicks(scoreW, false, sleepTicks.length),
        tickFmt: compact, right: true },
    ],
    sleepW.map((h, i) => joinTip(
      h !== null && `${hm(h * 60)}${avg} sleep`,
      scoreW[i] !== null && `score ${fixed(scoreW[i], 0)}`,
    )),
    { unit: granularity },
  );

  const weightTicks = axisTicks(weightW, false);
  const weightLine = lineChart(
    spans, chartWidth,
    [
      { values: weightW, color: PALETTES.teal[LINE_STEP], ticks: weightTicks, tickFmt: compact },
      { values: fatW, color: PALETTES.orange[LINE_STEP], ticks: axisTicks(fatW, false, weightTicks.length),
        tickFmt: (t) => `${compact(t)}%`, right: true },
    ],
    weightW.map((w, i) => [joinTip(
      w !== null && `${fixed(w, 1)} ${wu}${avg}`,
      fatW[i] !== null && `${fixed(fatW[i], 1)}% body fat`,
    ), dailyLines && lastWeighed(iso(spans[i][0]))].filter(Boolean).join("\n")), // a week/month/year average needs no such note
    { unit: granularity },
  );

  const H = (html) => (heat ? html() : ""); // heatmap HTML, built only when the horizon has heatmaps

  // lactate threshold, from a hand-kept file and carried forward by the API (one value per day, held until the next
  // change). The panel is left out when the range has none (no file, or a range before its first entry).
  const ltDays = Object.keys(m.lt_pace || {}).sort();
  const paceUnit = `/${du}`;
  const ltAsOf = (day) => `as of ${shortDate(parseDay(m.lt_since[day]))}`;
  let ltPanel = "";
  if (ltDays.length) {
    const last = ltDays[ltDays.length - 1];
    // The heatmap is coloured by efficiency, metres per heartbeat at threshold (threshold speed / threshold HR):
    // pace alone changes rarely and in whole seconds, so it filled the grid with two or three tones. Higher is better.
    const unitMetres = { km: 1000, mi: 1609.344 }[du];
    const efficiency = Object.fromEntries(ltDays.map((day) => [day, (unitMetres * 60) / (m.lt_pace[day] * m.lt_hr[day])]));
    const effEdges = quantileEdges(Object.values(efficiency), 5, 0.01);
    // The line joins the entries themselves, point to point: they're measurements of something that changes
    // gradually, too few to average, and carrying them forward would draw steps on the days Garmin noticed. The
    // value in effect when the chart starts is a point too, so the line spans the chart. A bucket shows its last
    // entry; hovering any bucket names the value in effect at its end.
    const firstDay = iso(spans[0][0]);
    const entryIn = ([ws, we]) => [...ltDays].reverse().find((day) => iso(ws) <= day && day <= iso(we)
      && (m.lt_since[day] === day || day === firstDay));
    const entries = spans.map(entryIn);
    const inEffect = spans.map(([, we]) => (m.lt_pace[iso(we)] !== undefined ? iso(we) : null));
    // pace is drawn negated, so a faster pace sits higher on the chart, like every other "up is better" line
    const paceW = entries.map((day) => (day ? -m.lt_pace[day] : null));
    const ltHrW = entries.map((day) => (day ? m.lt_hr[day] : null));
    const paceTicks = axisTicks(paceW, false, null, 0);
    const ltLine = lineChart(
      spans, chartWidth,
      [
        { values: paceW, color: PALETTES.green[LINE_STEP], ticks: paceTicks, tickFmt: (t) => pace(-t) },
        { values: ltHrW, color: PALETTES.red[LINE_STEP], ticks: axisTicks(ltHrW, false, paceTicks.length, 0),
          tickFmt: compact, right: true },
      ],
      inEffect.map((day) => (day
        ? `${pace(m.lt_pace[day])} ${paceUnit} · ${m.lt_hr[day]} bpm\n${ltAsOf(day)}` : "—")),
      { unit: granularity, bridge: true },
    );
    ltPanel = panel(
      "lt",
      `${pace(m.lt_pace[last])} ${paceUnit}`, "LT pace",
      "",
      H(() => heatmap(start, end, efficiency, effEdges, PALETTES.green,
                      (v, day) => `${fixed(v, 2)} m/beat · ${pace(m.lt_pace[day])} ${paceUnit} · ${m.lt_hr[day]} bpm\n${ltAsOf(day)}`)
        + heatLegend(`Efficiency &lt;${fixed(effEdges[0], 2)}`, `${fixed(effEdges[effEdges.length - 1], 2)}+ m/beat`, PALETTES.green)),
      ltLine + lineLegend([`Pace ${paceUnit}`, PALETTES.green[LINE_STEP]], ["LTHR", PALETTES.red[LINE_STEP]]),
      [m.lt_hr[last], "bpm LTHR"],
    );
  }

  // run heatmap: each day coloured by its run type (the longest run's, if several), split diagonally with
  // strength on days with both; races are stars. Its legend shares hidden choices with the daily columns
  // ("run-types"): hidden kinds are left out, so a day with nothing visible shows as rest (the tip still lists all).
  const off = hiddenSeries("run-types");
  const runHeat = heat && heatGrid(start, end, (day) => {
    const all = d.runs[day] || [];
    const { tip, sum } = runDayTip(all, m.strength_mins[day] || 0, races[day], du);
    if (races[day] && !off.has("race")) return { color: RACE, tip, sum, star: true, keys: "race" };
    const runs = all.filter((r) => !r.race && !off.has(r.type));
    const lifted = (m.strength_count[day] || 0) > 0 && !off.has("strength");
    const main = runs.reduce((a, r) => (!a || r.distance > a.distance ? r : a), null);
    const runColor = main && TYPE_COLOR[main.type];
    const color = runColor && lifted ? `linear-gradient(135deg, ${runColor} 50%, ${STRENGTH} 50%)`
      : runColor || (lifted ? STRENGTH : EMPTY);
    const keys = [main && main.type, lifted && "strength"].filter(Boolean).join(" ") || "rest"; // a split day is both
    return { color, tip, sum, star: false, keys };
  });

  const panels = [
    panel(
      runChart,
      byMode(distance(runWeek, du), lineBig), byMode("weekly", linePer), "",
      H(() => runHeat + swatchLegend(
        ["Strength", STRENGTH, null, "strength"], ...RUN_TYPES.map((t) => [t.label, t.color, null, t.key]),
        ["Race", RACE, "star", "race"],
      )),
      runLine + runLegend,
      [distance(runTotal, du), "total"], // distance over the selected range
      "run-types", // the heatmap legend shares hidden choices with the daily columns
    ),
    ltPanel,
    panel(
      "hrv",
      `${fixed(hrvAvg, 0)} ms`, "overnight HRV", "",
      H(() => heatmap(start, end, m.hrv, hrvEdges, PALETTES.blue, (v) => `${v} ms`)
        + heatLegend(`&lt;${hrvEdges[0]}`, `${hrvEdges[hrvEdges.length - 1]}+ ms`, PALETTES.blue)),
      meanLine(hrvW, PALETTES.blue[LINE_STEP], (v) => `${fixed(v, 0)} ms${avg} HRV`)
        + lineLegend([`${legendName} ms`, PALETTES.blue[LINE_STEP]]),
    ),
    panel(
      "rhr",
      `${fixed(rhrAvg, 0)} bpm`, "resting heart rate", "",
      H(() => heatmap(start, end, m.rhr, rhrEdges, rhrPalette, (v) => `${v} bpm resting`)
        + heatLegend(`&lt;${rhrEdges[0]}`, `${rhrEdges[rhrEdges.length - 1]}+ bpm`, rhrPalette)),
      meanLine(rhrW, PALETTES.red[LINE_STEP], (v) => (dailyLines ? `${fixed(v, 0)} bpm resting` : `${fixed(v, 1)} bpm avg resting`))
        + lineLegend([`${legendName} bpm`, PALETTES.red[LINE_STEP]]),
    ),
    panel(
      "sleep",
      `${Math.floor(avgSleep / 3600)}h ${Math.floor((avgSleep % 3600) / 60)}m`, "sleep",
      avgScore !== null ? `(avg score ${fixed(avgScore, 0)})` : "",
      H(() => heatmap(start, end, m.sleep_score, sleepEdges, PALETTES.purple,
                      (v, day) => joinTip(day in m.sleep_secs && `${hm(m.sleep_secs[day] / 60)} sleep`, `score ${v}`))
        + heatLegend("Sleep score &lt;60", "90+", PALETTES.purple)),
      sleepLine + lineLegend(["Hours asleep", PALETTES.purple[LINE_STEP]], ["Sleep score", PALETTES.orange[LINE_STEP]]),
    ),
    panel(
      "weight",
      weightBig, "weight", weightNote,
      H(() => heatmap(start, end, m.weight, weightEdges, PALETTES.teal,
                      (v, day) => [joinTip(`${fixed(v, 1)} ${wu}`, day in m.body_fat && `${fixed(m.body_fat[day], 1)}% body fat`),
                                   lastWeighed(day)].filter(Boolean).join("\n"))
        + heatLegend(`&lt;${compact(weightEdges[0])}`, `${compact(weightEdges[weightEdges.length - 1])}+ ${wu}`, PALETTES.teal)),
      weightLine + lineLegend([`Weight ${wu}`, PALETTES.teal[LINE_STEP]], ["Body fat %", PALETTES.orange[LINE_STEP]]),
    ),
  ].filter(Boolean);

  return `<div class="panels heat-${heatLayout} line-${lineLayout}">${panels.join("")}</div>`;
}
