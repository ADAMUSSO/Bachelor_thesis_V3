export function amountToRawString(amount: string, decimals: number): string {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Amount must be numeric");

  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);

  const raw = (whole.replace(/^0+(?=\d)/, "") || "0") + fracPadded;
  return raw.replace(/^0+(?=\d)/, "") || "0";
}
