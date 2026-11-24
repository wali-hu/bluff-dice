import { DICE_PER_PLAYER, FACES } from "@/config/game";

/**
 * Bid rules, mirroring BluffDice._validateBid exactly (same checks, same order, same error names):
 *   face 1..6                                  else InvalidFace
 *   quantity 1..playerCount * 5                else InvalidQuantity
 *   quantity > prev, or same quantity and face > prev face   else BidNotHigher
 * "No bid yet" is prevQuantity 0 / prevFace 0, so any valid first bid raises. Shared with bot/ (Phase F) through
 * the JSON fixture next to this file.
 */
export interface BidContext {
  readonly playerCount: number;
  /** 0 = no bid yet. */
  readonly prevQuantity: number;
  readonly prevFace: number;
}

export type BidCheck = "ok" | "InvalidFace" | "InvalidQuantity" | "BidNotHigher";

export function maxQuantity(playerCount: number): number {
  return playerCount * DICE_PER_PLAYER;
}

export function checkBid(ctx: BidContext, quantity: number, face: number): BidCheck {
  // Same order as the contract. The contract takes uint8; the app also refuses non-integers and negatives.
  if (!Number.isInteger(face) || face < 1 || face > FACES) return "InvalidFace";
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity(ctx.playerCount)) {
    return "InvalidQuantity";
  }
  const raises = quantity > ctx.prevQuantity || (quantity === ctx.prevQuantity && face > ctx.prevFace);
  return raises ? "ok" : "BidNotHigher";
}

/** Faces that are legal for `quantity` (the face buttons the picker enables). */
export function legalFaces(ctx: BidContext, quantity: number): number[] {
  return Array.from({ length: FACES }, (_, i) => i + 1).filter((face) => checkBid(ctx, quantity, face) === "ok");
}

/** The smallest legal quantity (where the stepper starts), or null when no bid can raise (max x 6 already bid). */
export function minLegalQuantity(ctx: BidContext): number | null {
  for (let q = Math.max(1, ctx.prevQuantity); q <= maxQuantity(ctx.playerCount); q++) {
    if (legalFaces(ctx, q).length > 0) return q;
  }
  return null;
}

/** E5-R5: the smallest legal bid (where the picker starts), or null when nothing can raise (only LIAR!). */
export function smallestLegalBid(ctx: BidContext): { quantity: number; face: number } | null {
  const quantity = minLegalQuantity(ctx);
  if (quantity === null) return null;
  const face = legalFaces(ctx, quantity)[0];
  return face === undefined ? null : { quantity, face };
}

export const BID_RULE_TEXT = "Higher quantity, or the same quantity with a higher face.";
