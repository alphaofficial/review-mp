import { ContextEnvelope } from '../contextRetriever';

export function buildChangeBriefPrompt(formattedDiff: string, contextEnvelope: ContextEnvelope): string {
  const contextSection = contextEnvelope.text
    ? `Retrieved review context:\n${contextEnvelope.text}\n\n`
    : '';

  return `Build a concise change brief for the following code review.

Use only the supplied diff and retrieved context. Do not inspect files, search the repository, or run commands.

${contextSection}<diff>
${formattedDiff}
</diff>

Output ONLY this format:
Apparent goal:
- ...

Files touched and why:
- ...

Main behavior or contract affected:
- ...

Key risks to inspect:
- ...

Unknowns:
- ...

Keep the brief under 500 words. Mark uncertain points as uncertain. Do not report review findings.`;
}
