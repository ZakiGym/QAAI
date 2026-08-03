import { redirect } from 'next/navigation';

/**
 * /dashboard is now the top of /runs.
 *
 * The two screens were the same data twice — a fleet rollup here, the run log
 * there, twelve sidebar rows apart — so the aggregates became the stats band on
 * Runs home and this route kept its URL. Bookmarks, the old sidebar link and
 * anything that shipped pointing here still land somewhere real.
 *
 * A server redirect, not `router.push` in an effect: pushing means the browser
 * renders this route first, so the user sees an empty shell flash before the
 * navigation starts. Here they never see it at all.
 */
export default function DashboardPage() {
  redirect('/runs');
}
