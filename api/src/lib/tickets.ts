import type { Env } from "../types";
import { getWeekRange, isoDay, parseDDMMYYYY } from "./dates";
import { lc } from "./util";

/** Reserve `n` sequential ticket numbers atomically; returns ids like "#00042". */
export async function nextTicketIds(env: Env, counter: "help_ticket" | "support_ticket", n = 1): Promise<string[]> {
  const r = await env.DB.prepare("UPDATE counters SET value = value + ? WHERE name = ? RETURNING value")
    .bind(n, counter).first<{ value: number }>();
  const last = r?.value ?? n;
  return Array.from({ length: n }, (_, i) => `#${String(last - n + 1 + i).padStart(5, "0")}`);
}

interface TicketLike { created_by: string; assigned_to: string; created_date: string; done_date: string }

/**
 * Weekly ticket stats used by /filter on both ticket modules.
 * `delayedOverCompleted` = help-ticket semantics (delay % over completed);
 * support tickets historically divided by total.
 */
export function ticketWeekStats<T extends TicketLike, M>(rows: T[], month: string, week: string, name: string, map: (r: T) => M, delayedOverCompleted: boolean) {
  const { weekStart, weekEnd } = getWeekRange(month, week);
  const key = lc(name);
  const calc = (subset: T[]) => {
    let total = 0, pending = 0, completed = 0, delayed = 0;
    const tickets: M[] = [];
    for (const r of subset) {
      const created = parseDDMMYYYY(r.created_date);
      const done = parseDDMMYYYY(r.done_date);
      if (!created) continue;
      if (!(created <= weekEnd && (!done || done >= weekStart))) continue;
      total++;
      if (done && done >= weekStart && done <= weekEnd) {
        completed++;
        if (Math.ceil((done.getTime() - created.getTime()) / 86400000) > 3) delayed++;
      } else pending++;
      tickets.push(map(r));
    }
    const denom = delayedOverCompleted ? completed : total;
    return {
      total, pending, completed, delayed,
      pendingPercentage: total ? ((pending / total) * 100).toFixed(2) : "0.00",
      delayedPercentage: denom ? ((delayed / denom) * 100).toFixed(2) : "0.00",
      tickets,
    };
  };
  const a = calc(rows.filter((r) => lc(r.assigned_to) === key));
  const cr = calc(rows.filter((r) => lc(r.created_by) === key));
  return {
    weekStart: isoDay(weekStart),
    weekEnd: isoDay(weekEnd),
    assigned: {
      assignedTotalTicket: a.total, assignedPendingTicket: a.pending, assignedCompletedTicket: a.completed,
      assignedDelayedTicket: a.delayed, assignedPendingPercentage: a.pendingPercentage,
      assignedDelayPercentage: a.delayedPercentage, tickets: a.tickets,
    },
    created: {
      createdTotalTicket: cr.total, createdPendingTicket: cr.pending, createdCompletedTicket: cr.completed,
      createdDelayedTicket: cr.delayed, createdPendingPercentage: cr.pendingPercentage,
      createdDelayPercentage: cr.delayedPercentage, tickets: cr.tickets,
    },
  };
}
