// Copy-paste "playoff picture" for the whole league (spec 5.4.1.f). Plain text + light
// emoji only — Sleeper chat has no rich formatting — and short lines for phones.

import { TIEBREAKERS, STATUS, explain, scenarioText } from './playoffs.js';
import { formatPct } from './playoffsim.js';

const MAX_SCENARIOS = 4;

const rec = (t) => `${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}`;
const pf = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function settledOf(a) {
  if (!a) return null;
  if (a.inClinched) return 'in';
  if (a.status === 'eliminated') return 'out';
  return null;
}

function capped(list) {
  const shown = list.slice(0, MAX_SCENARIOS).map(scenarioText);
  if (list.length > MAX_SCENARIOS) shown.push(`…or ${list.length - MAX_SCENARIOS} other combination${list.length - MAX_SCENARIOS === 1 ? '' : 's'}`);
  return shown;
}

// Structured "what this team needs" — shared by the message and the in-app view.
// Returns null for teams that are already settled (clinched / eliminated / final).
export function teamNeeds(a, { you = false } = {}) {
  if (!a || a.final || !['control', 'bubble', 'hunt'].includes(a.status)) return null;
  const sc = a.scenarios;
  const week = sc?.week;
  const clinch = sc ? capped(sc.clinch) : [];
  const elim = sc ? capped(sc.elim) : [];
  const lastWeek = a.weeksLeft === 1;

  let path = null;
  if (a.status === 'control') {
    // "Win this week and you're in" is already the first clinch scenario.
    if (a.winNext > 1) path = explain(a, { you });
  } else if (!(lastWeek && clinch.length)) {
    path = explain(a, { you });
  }
  return {
    week,
    clinch,
    elim,
    cantClinchNow: Boolean(sc) && !clinch.length,
    path,
  };
}

// ranked: teams in seed order. analysis: Map<rosterId, analysis> | null. odds: sim result | null.
export function buildLeagueUpdate({ leagueName, model, ranked, analysis, odds, tiebreaker, divisionMode = 'top', leaders = null, unsupported = null }) {
  const { spots, byes, complete, remainingWeeks } = model;
  const week = remainingWeeks[0];
  const lines = [];
  const pctFor = (t) => {
    const o = odds?.byRoster[t.rosterId];
    return o ? formatPct(o.playoffPct, { settled: settledOf(analysis?.get(t.rosterId)) }) : null;
  };

  lines.push(complete ? '🏆 PLAYOFF PICTURE — Final Standings' : `🏆 PLAYOFF PICTURE — Week ${week}`);
  lines.push(leagueName || 'League');
  const left = remainingWeeks.length;
  lines.push(`Top ${spots} make it${byes ? ` · top ${byes} get a bye` : ''}${complete ? '' : ` · ${left} week${left === 1 ? '' : 's'} left`}`);
  lines.push('');
  lines.push('STANDINGS');
  ranked.forEach((t, i) => {
    if (i === spots) lines.push('— — playoff line — —');
    const p = pctFor(t);
    const lead = leaders?.has(t.rosterId) ? ' 👑' : '';
    lines.push(`${i + 1}. ${t.name}${lead}  ${rec(t)}  ${pf(t.pf)} PF${p ? ' · ' + p : ''}`);
  });

  if (analysis) {
    const of = (keys) => ranked.filter((t) => keys.includes(analysis.get(t.rosterId)?.status));
    const label = (t) => {
      const a = analysis.get(t.rosterId);
      const byeTag = a.status === 'clinched_bye' ? ` (bye${a.hedged && a.inClinched ? '*' : ''})` : '';
      const tag = byeTag || (a.divClinched ? ' (division)' : '');
      return `${t.name}${tag}${a.hedged && !a.inClinched ? '*' : ''}`;
    };
    const inTeams = of(['clinched_bye', 'clinched']);
    const outTeams = of(['eliminated']);
    lines.push('');
    if (complete) {
      if (inTeams.length) lines.push(`✅ IN THE PLAYOFFS: ${inTeams.map(label).join(', ')}`);
      if (outTeams.length) lines.push(`❌ MISSED THE CUT: ${outTeams.map(label).join(', ')}`);
    } else {
      lines.push(`✅ CLINCHED: ${inTeams.length ? inTeams.map(label).join(', ') : 'nobody yet'}`);
      if (outTeams.length) lines.push(`❌ ELIMINATED: ${outTeams.map(label).join(', ')}`);

      const alive = of(['control', 'bubble', 'hunt']);
      if (alive.length) {
        lines.push('', `WHAT EACH TEAM NEEDS — WEEK ${week}`);
        for (const t of alive) {
          const a = analysis.get(t.rosterId);
          const n = teamNeeds(a);
          const p = pctFor(t);
          lines.push('');
          lines.push(`${STATUS[a.status].emoji} ${t.name} (#${a.seed} · ${rec(t)}${p ? ' · ' + p : ''})`);
          if (n.clinch.length) {
            lines.push('Clinches this week with:');
            for (const c of n.clinch) lines.push(`• ${c}`);
          } else if (n.cantClinchNow) {
            lines.push('Can’t clinch this week.');
          }
          if (n.path) lines.push(n.clinch.length ? `Otherwise: ${lowerFirst(n.path)}` : n.path);
          if (n.elim.length) {
            lines.push('Eliminated this week with:');
            for (const e of n.elim) lines.push(`• ${e}`);
          }
        }
      }
    }
    if ([...analysis.values()].some((a) => a.hedged)) lines.push('', '* if tiebreakers hold');
  } else if (unsupported) {
    lines.push('', `(${unsupported})`);
  }
  if (leaders?.size) {
    const how = divisionMode === 'top' ? 'division winners get the top seeds' : 'division winners are guaranteed a spot';
    lines.push('', `👑 = division leader · ${how}`);
  }

  if (analysis && model.median && !complete) {
    lines.push('', 'Median league: “Win”/“Loss” in scenarios = the head-to-head game; they hold no matter how the median games go.');
  }
  lines.push('');
  const foot = [`Tiebreaker: ${TIEBREAKERS[tiebreaker]?.label.toLowerCase() || 'points for'}`];
  if (odds && !complete) foot.push(`odds from ${odds.iterations.toLocaleString('en-US')} sims`);
  lines.push(foot.join(' · '));
  return lines.join('\n');
}

function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
