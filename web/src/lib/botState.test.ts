import { describe, expect, it } from "vitest";

import { BOT_FLOOR_WEI } from "@/config/bot";

import { botView } from "./botState";

const base = { configured: true, tableId: undefined, botBalance: 10n ** 18n, seatTakenAt: null, now: 100_000 };

describe("botView", () => {
  it("hidden without NEXT_PUBLIC_BOT_ADDRESS", () => {
    expect(botView({ ...base, configured: false, tableId: 5n })).toEqual({ kind: "hidden" });
  });

  it("ready when a joinable bot table exists", () => {
    expect(botView({ ...base, tableId: 5n })).toEqual({ kind: "ready", tableId: 5n });
  });

  it("seat taken: searching for ~30 s, ignoring the stale table, then busy", () => {
    expect(botView({ ...base, tableId: 5n, takenTableId: 5n, seatTakenAt: 90_000 })).toEqual({
      kind: "searching",
      secondsLeft: 20,
    });
    expect(botView({ ...base, tableId: 6n, takenTableId: 5n, seatTakenAt: 90_000 })).toEqual({
      kind: "ready",
      tableId: 6n,
    });
    expect(botView({ ...base, seatTakenAt: 60_000 })).toEqual({ kind: "busy" });
  });

  it("resting when the bot is under its ETH floor", () => {
    expect(botView({ ...base, botBalance: BOT_FLOOR_WEI - 1n })).toEqual({ kind: "resting" });
    expect(botView({ ...base, botBalance: BOT_FLOOR_WEI })).toEqual({ kind: "busy" });
  });
});
