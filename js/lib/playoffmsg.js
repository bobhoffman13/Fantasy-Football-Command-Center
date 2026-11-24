// Copy-paste "playoff picture" for the whole league (spec 5.4.1.f). Plain text + light
// emoji only — Sleeper chat has no rich formatting — and short lines for phones.

import { TIEBREAKERS, explain } from './playoffs.js';
import { formatPct } from './playoffsim.js';

const rec = (t) => `${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}`;
const pf = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function settledOf(a) {
  if (!a) return null;
  if ((a.status === 'clinched' || a.status === 'clinched_bye') && !a.hedged) return 'in';
  if (a.status === 'eliminated') return 'out';
  return null;
}

// ranked: teams in seed order. analysis: Map<rosterId, analysis> | null. odds: sim result | null.
export function buildLeagueUpdate({ leagueName, model, ranked, analysis, odds, tiebreaker }) {
  const { spots, byes, complete, remainingWeeks } = model;
  const week = remainingWeeks[0];
  const lines = [];
  const oddsFor = (t) => {
    if (!odds) return '';
    const o = odds.byRoster[t.rosterId];
    return o ? ` · ${formatPct(o.playoffPct, { settled: settledOf(analysis?.get(t.rosterId)) })}` : '';
  };

  lines.push(complete ? '🏆 PLAYOFF PICTURE — Final Standings' : `🏆 PLAYOFF PICTURE — Week ${week}`);
  lines.push(leagueName || 'League');
  const left = remainingWeeks.length;
  lines.push(`Top ${spots} make it${byes ? ` · top ${byes} get a bye` : ''}${complete ? '' : ` · ${left} week${left === 1 ? '' : 's'} left`}`);
  lines.push('');
  lines.push('STANDINGS');
  ranked.forEach((t, i) => {
    if (i === spots) lines.push('— — playoff line — —');
    lines.push(`${i + 1}. ${t.name}  ${rec(t)}  ${pf(t.pf)} PF${oddsFor(t)}`);
  });

  if (analysis) {
    const groups = [
      { title: '✅ CLINCHED', keys: ['clinched_bye', 'clinched'] },
      { title: '🎯 IN CONTROL (win out = in)', keys: ['control'] },
      { title: '🔥 ON THE BUBBLE / IN THE HUNT', keys: ['bubble', 'hunt'] },
      { title: '❌ ELIMINATED', keys: ['eliminated'] },
    ];
    if (complete) {
      groups.splice(1, 2);
      groups[0].title = '✅ IN THE PLAYOFFS';
      groups[1].title = '❌ MISSED THE CUT';
    }
    for (const g of groups) {
      const members = ranked.filter((t) => g.keys.includes(analysis.get(t.rosterId)?.status));
      if (!members.length) continue;
      lines.push('');
      lines.push(g.title);
      for (const t of members) {
        const a = analysis.get(t.rosterId);
        const tag = a.status === 'clinched_bye' ? ' (bye)' : '';
        const hedge = a.hedged && (a.status === 'clinched' || a.status === 'clinched_bye' || a.final) ? '*' : '';
        if (g.keys.includes('eliminated') || g.keys.includes('clinched')) {
          lines.push(`• ${t.name}${tag}${hedge}`);
        } else {
          lines.push(`• ${t.name}${oddsFor(t)} — ${explain(a)}`);
        }
      }
    }
    if ([...analysis.values()].some((a) => a.hedged)) lines.push('', '* if tiebreakers hold');
  } else if (model.divisions) {
    lines.push('', '(Division league — clinch scenarios not calculated.)');
  }

  lines.push('');
  const foot = [`Tiebreaker: ${TIEBREAKERS[tiebreaker]?.label.toLowerCase() || 'points for'}`];
  if (odds && !complete) foot.push(`odds from ${odds.iterations.toLocaleString('en-US')} sims`);
  lines.push(foot.join(' · '));
  return lines.join('\n');
}

