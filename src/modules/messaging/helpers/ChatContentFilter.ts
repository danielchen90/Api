// Minimal server-side abuse filter for anonymous livestream chat (App Store guideline 1.2).
// No LLM: a short list of slurs and explicit terms in English, Spanish, French and Portuguese.
//
// Deliberately conservative so scripture and ordinary church talk pass: words the KJV and
// other Bibles use (ass, bastard, whore, harlot, piss, cock, hell, damn) are NOT listed, nor
// words with an innocent meaning in one of the four languages (zorra, rola, pede, porra, bite,
// chink, dyke, cono). Short words are matched as whole words only (no "Scunthorpe" hits).
//
// Text is normalised before matching: lower case, accents stripped, common look-alike
// characters mapped (0->o, 1->i, 3->e, 4->a, 5->s, 7->t, @->a, $->s), and runs of three or
// more of the same letter squeezed to one ("fuuuuck" -> "fuck").

// Matched anywhere inside a word (these stems never occur inside innocent words).
const STEMS = (
  "fuck motherf nigger nigga faggot blowjob pornhub xvideos " +
  "chinga pendej malparid hijueputa " +
  "encule enculer salope connard connasse " +
  "caralh arrombad buceta fodase foder "
).trim().split(/\s+/);

// Matched as whole words only (optionally with a plural s/es ending).
const WORDS = (
  "shit shitty bullshit bitch bitches slut pussy dildo porn porno nudes cunt " +
  "fag kike spic wetback tranny retard twat wanker jizz rapist " +
  "puta puto putas putos joder jodete cabron cabrona maricon marica " +
  "culero mierda follar " +
  "pute putain merde niquer nique tapette bougnoule negre " +
  "foda fodido viado xoxota cuzao vagabunda "
).trim().split(/\s+/);

const LOOKALIKE: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };

const WORD_SET = new Set(WORDS.map((w) => ChatContentFilterNormalize(w)));

function ChatContentFilterNormalize(text: string): string {
  let s = (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/[013457@$!]/g, (c) => LOOKALIKE[c] || c);
  s = s.replace(/([a-z])\1{2,}/g, "$1");
  return s;
}

export class ChatContentFilter {
  public static normalize = ChatContentFilterNormalize;

  /** TRUE when the text contains a listed slur or explicit term. */
  public static isAbusive(text: string): boolean {
    if (!text) return false;
    const normalized = ChatContentFilterNormalize(text);
    const words = normalized.split(/[^a-z]+/).filter(Boolean);
    for (const w of words) {
      if (WORD_SET.has(w)) return true;
      if (w.endsWith("es") && WORD_SET.has(w.slice(0, -2))) return true;
      if (w.endsWith("s") && WORD_SET.has(w.slice(0, -1))) return true;
      for (const stem of STEMS) if (w.includes(stem)) return true;
    }
    // Letters spaced out to dodge the list ("f u c k", "f.u.c.k"): join single-letter runs.
    const joined = normalized.replace(/\b([a-z])[\s._*-]+(?=[a-z]\b)/g, "$1");
    if (joined !== normalized) {
      for (const w of joined.split(/[^a-z]+/).filter(Boolean)) {
        if (WORD_SET.has(w)) return true;
        for (const stem of STEMS) if (w.includes(stem)) return true;
      }
    }
    return false;
  }
}
