import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Disclaimer } from "@/components/Disclaimer";
import { BLUFF_CHIPS_ADDRESS, BLUFF_DICE_ADDRESS } from "@/contracts/addresses";

import { DISCLAIMER } from "./disclaimer";

describe("disclaimer", () => {
  it("has the exact required wording", () => {
    expect(DISCLAIMER).toBe("This project is not audited, endorsed or operated by Zama. Use at your own risk.");
  });

  it("is rendered by the footer together with the contract and source links", () => {
    const html = renderToStaticMarkup(<Disclaimer />);
    expect(html).toContain(`>${DISCLAIMER}<`);
    expect(html).toContain(`https://sepolia.etherscan.io/address/${BLUFF_DICE_ADDRESS}`);
    expect(html).toContain(`https://sepolia.etherscan.io/address/${BLUFF_CHIPS_ADDRESS}`);
    expect(html).toContain("https://github.com/wali-hu/liars-dice-kit");
  });
});
