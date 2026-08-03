import { redirect } from 'next/navigation';

/**
 * `/insights` has no view of its own any more.
 *
 * It used to be an overview that restated the coverage headline and the health
 * score above links to the two screens those numbers already live on — a page
 * whose entire content was a preview of the next click. The tab strip does that
 * job now, so the bare route lands on the first tab.
 *
 * Kept as a redirect rather than deleted: `/insights` is in the sidebar, in the
 * command palette, in the docs and in at least one e2e spec, and a 404 is a
 * worse answer than the screen somebody meant.
 */
export default function InsightsPage() {
  redirect('/insights/coverage');
}
