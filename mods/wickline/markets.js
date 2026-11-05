// Which market a symbol trades on, from its form alone. No Herdr imports.
import { isCryptoPair } from "./quotes.js";

// Yahoo exchange suffixes.
const SUFFIXES = { TW: "tw", TWO: "tw", HK: "hk", SS: "cn", SZ: "cn", T: "jp", KS: "kr", KQ: "kr" };

/** "us", "tw", "hk", "cn", "jp", "kr", "crypto" or "other" (indices, currencies, other exchanges). */
export function marketOf(symbol) {
  if (isCryptoPair(symbol)) return "crypto";
  // Indices start with ^, currencies and futures contain =.
  if (/^\^|=/.test(symbol)) return "other";
  const dot = symbol.lastIndexOf(".");
  if (dot === -1) return "us";
  return SUFFIXES[symbol.slice(dot + 1)] ?? "other";
}
