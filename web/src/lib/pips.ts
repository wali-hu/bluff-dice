/** Cells (0..8, row by row in a 3x3 grid) that hold a pip for each die face. */
export const PIP_CELLS: Readonly<Record<number, readonly number[]>> = {
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

export function pipCells(face: number): readonly number[] {
  const cells = PIP_CELLS[face];
  if (!cells) throw new Error(`Die face must be 1..6, got ${face}`);
  return cells;
}
