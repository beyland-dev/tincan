import { getCountries, getCountryCallingCode } from "libphonenumber-js/min";

export interface Country {
  code: string;
  name: string;
  dial: string;
  flag: string;
  search: string;
}

let all: Country[] | null = null;

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function flag(code: string): string {
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function countries(): Country[] {
  if (all) return all;
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  all = getCountries()
    .map((code) => {
      const name = names.of(code) ?? code;
      const dial = getCountryCallingCode(code);
      return { code, name, dial, flag: flag(code), search: fold(`${name} ${code}`) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return all;
}

export function filterCountries(list: Country[], query: string): Country[] {
  const q = fold(query.trim());
  if (!q) return list;
  const digits = q.replace(/^\+/, "");
  if (/^\d+$/.test(digits)) return list.filter((c) => c.dial.startsWith(digits));
  const starts = list.filter((c) => c.search.startsWith(q) || c.code.toLowerCase() === q);
  const rest = list.filter((c) => !starts.includes(c) && c.search.includes(q));
  return [...starts, ...rest];
}
