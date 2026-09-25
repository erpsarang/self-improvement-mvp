export interface InvocationFragments {
  readonly ordinal: number;
  readonly boundaryConfirmed: true;
  readonly bannerLog: string;
  readonly completionLog: string;
}

const banner = /^OpenAI Codex v\S+$/;
const integer = /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/;

/** Select only the observed Actions/Codex format; never trim numeric lines. */
export function selectInvocationFragments(rawLog: string): InvocationFragments[] {
  const lines = rawLog.split(/\r?\n/).map(line => line
    // Exactly one timestamp separator: remaining indentation belongs to output.
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /, '')
    .replace(/\x1b\[[0-9;]*m/g, ''));
  const starts = lines.flatMap((line, index) => /^OpenAI Codex v/.test(line) ? [index] : []);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    // A malformed start is not a confirmed invocation. Stop instead of hiding it.
    if (!banner.test(lines[start]!) || lines[start + 1] !== '--------') {
      throw new Error('Unconfirmed Codex invocation boundary');
    }
    let close = start + 2;
    while (close < end && lines[close] !== '--------' && lines[close] !== 'user') close += 1;
    const headerConfirmed = close < end && lines[close] === '--------';
    const bannerLog = headerConfirmed ? lines.slice(start + 2, close).join('\n') : '';
    let completionLog = '';
    if (headerConfirmed) {
      const markers: number[] = [];
      for (let position = close + 1; position < end; position += 1) {
        if (/^tokens used\b/.test(lines[position]!)) markers.push(position);
      }
      // Repeated or malformed markers cannot establish one termination summary.
      if (markers.length === 1 && lines[markers[0]!] === 'tokens used') {
        for (let position = markers[0]! + 1; position < end; position += 1) {
          if (integer.test(lines[position]!)) {
            completionLog = `tokens used\n${lines[position]!}`;
            break;
          }
        }
      }
    }
    return { ordinal: index + 1, boundaryConfirmed: true, bannerLog, completionLog };
  });
}
