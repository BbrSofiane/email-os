/**
 * How far a scroller must move so an item is visible: 0 when it already is,
 * the smallest move that brings a short item fully in, and the top edge aligned
 * for an item taller than the view (its start is what identifies it). Positive
 * means scroll down. Pure geometry in viewport coordinates.
 */
export function revealDelta(view: { top: number; bottom: number }, item: { top: number; bottom: number }): number {
  const viewHeight = view.bottom - view.top;
  const itemHeight = item.bottom - item.top;
  if (itemHeight > viewHeight) return item.top - view.top;
  if (item.bottom > view.bottom) return item.bottom - view.bottom;
  if (item.top < view.top) return item.top - view.top;
  return 0;
}
