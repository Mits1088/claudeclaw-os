import { protectedValueVariants, scanForSecrets } from './exfiltration-guard.js';

/**
 * All built-in credential patterns in exfiltration-guard consume no whitespace.
 * Retain the unfinished whitespace-delimited token, plus every suffix which is
 * a prefix of a configured protected value (raw/base64/URL encoded). Unlike a
 * fixed character delay this also protects arbitrarily long, multiline values.
 * A new detector that crosses whitespace must extend this boundary contract.
 */
export class OutboundStreamBoundary {
  private length = 0;
  private tokenEnd = 0;
  private readonly patterns: Array<{ value: string; failure: number[]; matched: number }>;

  constructor(private readonly protectedValues: string[] = []) {
    const variants = [...new Set(protectedValues.flatMap(v => protectedValueVariants(v).map(p => p.encoded)))];
    this.patterns = variants.map(value => {
      const failure = new Array<number>(value.length).fill(0);
      for (let i = 1, j = 0; i < value.length; i++) {
        while (j && value[i] !== value[j]) j = failure[j - 1];
        if (value[i] === value[j]) j++;
        failure[i] = j;
      }
      return { value, failure, matched: 0 };
    });
  }

  append(delta: string): void {
    for (let i = 0; i < delta.length; i++) {
      const char = delta[i];
      this.length++;
      if (/\s/.test(char)) this.tokenEnd = this.length;
      for (const pattern of this.patterns) {
        while (pattern.matched && char !== pattern.value[pattern.matched]) {
          pattern.matched = pattern.failure[pattern.matched - 1];
        }
        if (char === pattern.value[pattern.matched]) pattern.matched++;
      }
    }
  }

  cutoff(text: string): number {
    let cut = this.tokenEnd;
    for (const pattern of this.patterns) cut = Math.min(cut, this.length - pattern.matched);
    // Never cut through a complete match, including overlapping protected
    // values. Moving left can intersect an earlier match, hence reverse order.
    const matches = scanForSecrets(text, this.protectedValues);
    let previous: number;
    do {
      previous = cut;
      // A protected prefix can begin in the middle of a generic credential.
      // Re-align left rather than releasing a truncated credential token.
      while (cut > 0 && !/\s/.test(text[cut - 1])) cut--;
      for (let i = matches.length - 1; i >= 0; i--) {
        const match = matches[i];
        if (match.position < cut && match.position + match.length > cut) cut = match.position;
      }
    } while (cut !== previous);
    return cut;
  }
}
