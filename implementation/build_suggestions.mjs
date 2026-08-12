import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const inputRoot = path.resolve(args.get("--input-root") || path.join(scriptRoot, "..", "input_data"));
const outputRoot = path.resolve(args.get("--output-root") || scriptRoot);
const reportRoot = path.join(outputRoot, "reports");

function assert(value, message) { if (!value) throw new Error(message); }
function csvCell(value) { const text = String(value ?? ""); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function toCsv(columns, rows) { return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}\n`; }
function parseCsv(text) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) { if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; } else if (character === '"') quoted = false; else cell += character; }
    else if (character === '"') quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n") { row.push(cell.replace(/\r$/, "")); if (row.some((value) => value !== "")) rows.push(row); row = []; cell = ""; }
    else cell += character;
  }
  if (cell !== "" || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  const headers = rows.shift();
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}
function normalizeQuery(raw) { return String(raw).trim().toLowerCase().replace(/\s+/gu, " "); }
function lexical(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function daysOld(reference, eventTime) { return (Date.parse(reference) - Date.parse(eventTime)) / 86400000; }

async function main() {
  await fs.rm(reportRoot, { recursive: true, force: true });
  try {
    const dataRoot = path.join(inputRoot, "data");
    const [eventText, ruleText, termText] = await Promise.all([
      fs.readFile(path.join(dataRoot, "query_events.jsonl"), "utf8"),
      fs.readFile(path.join(dataRoot, "normalization_rules.json"), "utf8"),
      fs.readFile(path.join(dataRoot, "sensitive_terms.csv"), "utf8")
    ]);
    const events = eventText.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`query_events.jsonl第${index + 1}行不是合法JSON`); }
    });
    const rules = JSON.parse(ruleText);
    const terms = parseCsv(termText).map((row) => ({...row, normalized_term: normalizeQuery(row.term)}));
    assert(events.length > 0 && new Set(events.map((event) => event.event_id)).size === events.length, "事件ID为空或重复");
    assert(Number.isFinite(Date.parse(rules.reference_time_utc)), "reference_time_utc无效");
    assert(Number(rules.decay_half_life_days) > 0 && Number(rules.top_n_per_locale) > 0 && Number(rules.click_boost) >= 0, "衰减或TopN规则无效");
    assert(rules.aliases && typeof rules.aliases === "object", "aliases无效");
    assert(terms.length > 0 && terms.every((row) => row.term && row.category), "敏感词表无效");

    const auditRows = [];
    const suppressedRows = [];
    const aggregates = new Map();
    for (const event of events) {
      assert(event.event_id && event.locale && event.raw_query && Number.isFinite(Date.parse(event.event_time_utc)), `事件字段无效:${event.event_id || "unknown"}`);
      assert(Number.isFinite(Number(event.impression_count)) && Number(event.impression_count) >= 0 && Number.isFinite(Number(event.click_count)) && Number(event.click_count) >= 0, `事件计数无效:${event.event_id}`);
      const normalized = normalizeQuery(event.raw_query);
      const canonical = rules.aliases[normalized] ?? normalized;
      const normalizedMatch = terms.find((term) => normalized.includes(term.normalized_term));
      const canonicalMatch = normalizedMatch ? null : terms.find((term) => canonical.includes(term.normalized_term));
      const suppression = normalizedMatch || canonicalMatch;
      const matchedOn = normalizedMatch ? "normalized_query" : canonicalMatch ? "canonical_query" : "";
      const age = daysOld(rules.reference_time_utc, event.event_time_utc);
      assert(Number.isFinite(age) && age >= 0, `事件晚于参考时刻:${event.event_id}`);
      const decayFactor = Math.pow(0.5, age / Number(rules.decay_half_life_days));
      const eventScore = (Number(event.impression_count) + Number(event.click_count) * Number(rules.click_boost)) * decayFactor;
      auditRows.push({
        event_id:event.event_id, locale:event.locale, surface:event.surface, raw_query:event.raw_query,
        normalized_query:normalized, canonical_query:canonical, alias_applied:normalized === canonical ? "no" : "yes",
        suppressed:suppression ? "yes" : "no", matched_on:matchedOn, suppression_category:suppression?.category ?? "",
        decay_factor:decayFactor.toFixed(6), event_score:eventScore.toFixed(4)
      });
      if (suppression) {
        suppressedRows.push({event_id:event.event_id,locale:event.locale,raw_query:event.raw_query,normalized_query:normalized,canonical_query:canonical,suppression_term:suppression.term,matched_on:matchedOn,category:suppression.category,action:"remove_from_suggestions"});
        continue;
      }
      const key = `${event.locale}\u0000${canonical}`;
      const aggregate = aggregates.get(key) ?? {locale:event.locale,canonical_query:canonical,total_impressions:0,total_clicks:0,decayed_score:0,source_event_ids:[],alias_event_count:0,last_event_time_utc:event.event_time_utc};
      aggregate.total_impressions += Number(event.impression_count);
      aggregate.total_clicks += Number(event.click_count);
      aggregate.decayed_score += eventScore;
      aggregate.source_event_ids.push(event.event_id);
      aggregate.alias_event_count += normalized === canonical ? 0 : 1;
      if (event.event_time_utc > aggregate.last_event_time_utc) aggregate.last_event_time_utc = event.event_time_utc;
      aggregates.set(key, aggregate);
    }

    const grouped = new Map();
    for (const row of aggregates.values()) {
      if (!grouped.has(row.locale)) grouped.set(row.locale, []);
      grouped.get(row.locale).push(row);
    }
    const rankingRows = [];
    for (const locale of [...grouped.keys()].sort(lexical)) {
      grouped.get(locale).sort((left,right) => right.decayed_score-left.decayed_score || right.total_clicks-left.total_clicks || lexical(left.canonical_query,right.canonical_query)).slice(0, Number(rules.top_n_per_locale)).forEach((row,index) => rankingRows.push({
        locale, rank:index+1, canonical_query:row.canonical_query, decayed_score:row.decayed_score.toFixed(4), total_impressions:row.total_impressions,
        total_clicks:row.total_clicks, source_event_ids:row.source_event_ids.join("|"), alias_event_count:row.alias_event_count, last_event_time_utc:row.last_event_time_utc
      }));
    }
    await fs.mkdir(reportRoot, { recursive: true });
    await fs.writeFile(path.join(reportRoot,"suggestion_rankings.csv"),toCsv(["locale","rank","canonical_query","decayed_score","total_impressions","total_clicks","source_event_ids","alias_event_count","last_event_time_utc"],rankingRows));
    await fs.writeFile(path.join(reportRoot,"suppressed_queries.csv"),toCsv(["event_id","locale","raw_query","normalized_query","canonical_query","suppression_term","matched_on","category","action"],suppressedRows));
    await fs.writeFile(path.join(reportRoot,"normalization_audit.csv"),toCsv(["event_id","locale","surface","raw_query","normalized_query","canonical_query","alias_applied","suppressed","matched_on","suppression_category","decay_factor","event_score"],auditRows));
  } catch (error) {
    await fs.rm(reportRoot,{recursive:true,force:true});
    console.error(error.message);
    process.exitCode=1;
  }
}

main();
