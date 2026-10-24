/**
 * How many physical garments one order_item line represents. A Set garment (e.g. a 2-piece Suit)
 * is ONE ordered unit but several physical pieces, each with its own tag — any "garment count"
 * derived from order_items must fold pieces_per_unit in, or it undercounts.
 *
 * This bug recurred independently in several PHP screens (tag printing, workshop dashboard,
 * challans, the billing report) because each had its own copy of the multiplication. Node
 * centralizes it here instead of repeating the pattern per page.
 */
export function piecesInLine(line: { quantity: unknown; pieces_per_unit?: unknown }): number {
  return Number(line.quantity) * Math.max(1, Number(line.pieces_per_unit ?? 1));
}
