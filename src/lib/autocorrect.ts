export interface AutocorrectRule {
  pattern: RegExp;
  replacement: string;
  silent: boolean;
}

const SUBSTITUTIONS: [string, string][] = [
  ["teh", "the"],
  ["adn", "and"],
  ["recieve", "receive"],
  ["occured", "occurred"],
  ["seperate", "separate"],
  ["definately", "definitely"],
  ["accomodate", "accommodate"],
  ["untill", "until"],
  ["acheive", "achieve"],
  ["beleive", "believe"],
  ["wierd", "weird"],
  ["thier", "their"],
  ["truely", "truly"],
  ["calender", "calendar"],
  ["goverment", "government"],
  ["enviroment", "environment"],
  ["arguement", "argument"],
  ["judgement", "judgment"],
  ["noticable", "noticeable"],
  ["occurance", "occurrence"],
  ["persistant", "persistent"],
  ["posession", "possession"],
  ["refered", "referred"],
  ["relevent", "relevant"],
  ["supercede", "supersede"],
  ["threshhold", "threshold"],
  ["tommorow", "tomorrow"],
  ["untill", "until"],
  ["writting", "writing"],
  ["begining", "beginning"],
  ["comming", "coming"],
  ["decission", "decision"],
  ["developement", "development"],
  ["dissapear", "disappear"],
  ["embarass", "embarrass"],
  ["explaination", "explanation"],
  ["foriegn", "foreign"],
  ["guage", "gauge"],
  ["heirarchy", "hierarchy"],
  ["immediatly", "immediately"],
  ["independant", "independent"],
  ["knowlege", "knowledge"],
  ["maintainance", "maintenance"],
  ["manuever", "maneuver"],
  ["millenium", "millennium"],
  ["neccessary", "necessary"],
  ["nineth", "ninth"],
  ["occassion", "occasion"],
  ["occurence", "occurrence"],
  ["parrallel", "parallel"],
  ["publically", "publicly"],
  ["reccommend", "recommend"],
  ["referance", "reference"],
  ["relevent", "relevant"],
  ["seize", "seize"],
  ["similer", "similar"],
  ["successfull", "successful"],
  ["supress", "suppress"],
  ["tommorow", "tomorrow"],
  ["typicaly", "typically"],
  ["unforseen", "unforeseen"],
  ["unfortunatly", "unfortunately"],
];

const CHAR_NORMALIZATIONS: [RegExp, string][] = [
  [/---/g, "\u2014"],
  [/--/g, "\u2013"],
  [/\.\.\./g, "\u2026"],
  [/  +/g, " "],
  [/(^|[.!?]\s+)i(\s)/g, "$1I$2"],
  [/"/g, "\u201C"],
  [/"/g, "\u201D"],
  [/'/g, "\u2018"],
  [/'/g, "\u2019"],
];

function wordFrequency(word: string): number {
  const common: Record<string, number> = {
    the: 1000, be: 900, to: 800, of: 700, and: 600, a: 500, in: 450,
    that: 400, have: 350, i: 340, it: 330, for: 320, not: 310, on: 300,
    with: 290, he: 280, as: 270, you: 260, do: 250, at: 240, this: 230,
    but: 220, his: 210, by: 200, from: 190, they: 180, we: 170, say: 160,
    her: 150, she: 140, or: 130, an: 120, will: 110, my: 100, one: 90,
    all: 80, would: 70, there: 60, their: 50, what: 40, so: 30, up: 20,
    out: 10, if: 9, about: 8, who: 7, get: 6, which: 5, go: 4, me: 3,
    when: 2, make: 1, can: 0.9, like: 0.8, time: 0.7, no: 0.6, just: 0.5,
    him: 0.4, know: 0.3, take: 0.2, people: 0.1, into: 0.09, year: 0.08,
    your: 0.07, good: 0.06, some: 0.05, could: 0.04, them: 0.03, other: 0.02,
    then: 0.01, now: 0.009, look: 0.008, only: 0.007, come: 0.006,
    its: 0.005, over: 0.004, think: 0.003, also: 0.002, back: 0.001,
    after: 0.0009, use: 0.0008, two: 0.0007, how: 0.0006, our: 0.0005,
    work: 0.0004, first: 0.0003, well: 0.0002, way: 0.0001, even: 0.00009,
    new: 0.00008, want: 0.00007, because: 0.00006, any: 0.00005,
    these: 0.00004, give: 0.00003, day: 0.00002, most: 0.00001, us: 0.000009,
  };
  return common[word.toLowerCase()] ?? 0.000001;
}

function damerauLevenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const d: number[][] = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0));

  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[la][lb];
}

/** Layer 1 membership: exact hits of the curated typo table. */
export function isKnownTypo(lower: string): boolean {
  for (const [typo] of SUBSTITUTIONS) {
    if (lower === typo) return true;
  }
  return false;
}

export function getAutocorrectSuggestions(  word: string,
  customDict: Set<string> = new Set(),
  useEnglishTable = true
): string | null {
  const lower = word.toLowerCase();

  if (useEnglishTable) {
    for (const [typo, correct] of SUBSTITUTIONS) {
      if (lower === typo) return correct;
    }
  }

  const candidates: [string, number][] = [];

  for (const dictWord of customDict) {
    if (dictWord.toLowerCase() === lower) return null;
  }

  const allWords = new Set([...(useEnglishTable ? SUBSTITUTIONS.map(([, c]) => c) : []), ...customDict]);

  for (const dictWord of allWords) {
    const dist = damerauLevenshtein(lower, dictWord.toLowerCase());
    if (dist === 1) {
      candidates.push([dictWord, wordFrequency(dictWord)]);
    }
  }

  if (candidates.length === 1) {
    const [candidate, freq] = candidates[0];
    const typedFreq = wordFrequency(lower);
    if (freq > typedFreq * 10) {
      return candidate;
    }
  }

  return null;
}

export function normalizeCharacters(text: string): string {
  let result = text;
  for (const [pattern, replacement] of CHAR_NORMALIZATIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
